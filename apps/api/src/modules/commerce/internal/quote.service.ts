import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { formatDec, parseDec } from '../../../common/rating';
import type { QuotaService, SpendService } from '../../billing';
import type { TaxService } from '../../invoicing';
import { QUOTE_KINDS, type QuoteKind, type QuotePricerRegistry } from './pricers';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

export interface QuoteDto {
  id: string;
  kind: QuoteKind;
  /** `expired` is derived from `expiresAt`; the stored quote never changes. */
  status: 'issued' | 'expired';
  expiresAt: string;
  currency: string;
  items: {
    position: number;
    description: string;
    meterId: string | null;
    quantity: string;
    unit: string;
    unitPriceMinor: string | null;
    amountMinor: string;
  }[];
  subtotalMinor: string;
  taxEstimate: {
    status: 'provisional';
    rateBps: number;
    taxMinor: string;
    source: string;
    note: string;
  };
  totalMinor: string;
  requiresApproval: boolean;
  approvalDetail: unknown;
  residency: { status: 'not_evaluated' };
  priceBookVersionId: string | null;
  projectId: string | null;
  createdAt: string;
}

/**
 * One quote mechanism for every kind (docs/04). A quote is priced by the kind's registered pricer from the price book version
 * effective NOW, carries a provisional tax estimate and a not-evaluated residency block, says whether the spend cap requires
 * an approval, and is immutable (database trigger) and valid for a TTL. A hard quota that the quote would exceed refuses it.
 */
export class QuoteService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly pricers: QuotePricerRegistry,
    private readonly tax: Pick<TaxService, 'estimate'>,
    private readonly quotas: Pick<QuotaService, 'assertAllowed'>,
    private readonly spend: Pick<SpendService, 'evaluate'>,
    private readonly opts: { ttlMinutes: number } = { ttlMinutes: 15 },
  ) {}

  async create(
    orgId: string,
    actorUserId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<QuoteDto> {
    const kind = input.kind;
    if (typeof kind !== 'string' || !(QUOTE_KINDS as readonly string[]).includes(kind))
      throw new ProblemException(
        'validation_failed',
        `kind must be one of ${QUOTE_KINDS.join(', ')}`,
      );
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50)
      throw new ProblemException('validation_failed', 'items must be an array of 1..50 items');
    const currency = input.currency ?? 'SAR';
    if (typeof currency !== 'string' || !CURRENCY.test(currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const projectId = input.projectId ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || !UUID.test(projectId)))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    const prefs = input.preferences ?? {};
    if (
      typeof prefs !== 'object' ||
      prefs === null ||
      Array.isArray(prefs) ||
      JSON.stringify(prefs).length > 2000
    )
      throw new ProblemException(
        'validation_failed',
        'preferences must be an object of at most 2000 characters',
      );

    const pricer = this.pricers.get(kind as QuoteKind); // kind_not_available when no pricer is registered
    if (projectId !== null) {
      const ok = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(`SELECT 1 FROM tenancy.projects WHERE id = $1 AND org_id = $2`, [
              projectId,
              orgId,
            ])
          ).rowCount,
      );
      if (!ok) throw new ProblemException('not_found', 'project not found');
    }
    const priced = await pricer.price({ orgId, currency, now }, input.items);

    // hard quotas refuse the quote; soft quotas never block (they notify on their own)
    const byGroup = new Map<string, bigint>();
    for (const i of priced.items)
      if (i.meterGroup)
        byGroup.set(i.meterGroup, (byGroup.get(i.meterGroup) ?? 0n) + parseDec(i.quantity));
    for (const [group, q] of byGroup)
      await this.quotas.assertAllowed(orgId, group, formatDec(q), now);

    const subtotal = priced.items.reduce((s, i) => s + i.amountMinor, 0n);
    // tax per line from the effective-dated rates and the buyer's tax profile (the invoicing tax engine, docs/11 §4)
    const te = await this.tax.estimate(
      orgId,
      priced.items.map((i) => i.amountMinor),
      now,
    );
    const taxMinor = te.taxMinor;
    const estimate = {
      status: te.status,
      rateCode: te.rateCode,
      rateBps: te.rateBps,
      source: te.source,
      reviewRequired: te.reviewRequired,
      reasons: te.reasons,
      note: 'computed from the configured tax rates; the issued invoice is authoritative and rates await tax-advisor sign-off [VERIFY HG-03-04]',
    };
    const total = subtotal + taxMinor;
    const id = uuidv7();
    const spend = await this.spend.evaluate(orgId, {
      amountMinor: total.toString(),
      currency,
      projectId,
      subject: { kind: 'quote', id },
    });
    const expiresAt = new Date(now.getTime() + this.opts.ttlMinutes * 60_000);

    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO commerce.quotes (id, org_id, kind, project_id, currency, subtotal_minor, tax_minor, total_minor, tax_estimate,
           residency, requires_approval, approval_detail, price_book_version_id, preferences, expires_at, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id,
          orgId,
          kind,
          projectId,
          currency,
          subtotal.toString(),
          taxMinor.toString(),
          total.toString(),
          JSON.stringify(estimate),
          JSON.stringify({ status: 'not_evaluated' }),
          spend.requiresApproval,
          JSON.stringify(spend.exceeded),
          priced.priceBookVersionId,
          JSON.stringify(prefs),
          expiresAt,
          actorUserId,
          now,
        ],
      );
      let pos = 1;
      for (const i of priced.items)
        await c.query(
          `INSERT INTO commerce.quote_items (id, quote_id, org_id, position, description, meter_id, meter_group, quantity, unit, unit_price_minor, amount_minor, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            uuidv7(),
            id,
            orgId,
            pos++,
            i.description,
            i.meterId,
            i.meterGroup,
            i.quantity,
            i.unit,
            i.unitPriceMinor,
            i.amountMinor.toString(),
            JSON.stringify(i.details),
          ],
        );
      await this.audit.record({
        action: 'commerce.quote.issued',
        actorUserId,
        orgId,
        resource: { type: 'quote', id },
        outcome: 'success',
        after: {
          kind,
          totalMinor: total.toString(),
          currency,
          requiresApproval: spend.requiresApproval,
        },
      });
    });
    return this.get(orgId, id, now);
  }

  async get(orgId: string, id: string, now = new Date()): Promise<QuoteDto> {
    return this.db.withOrg(orgId, async (c) => {
      const q = (
        await c.query(`SELECT * FROM commerce.quotes WHERE id = $1 AND org_id = $2`, [id, orgId])
      ).rows[0];
      if (!q) throw new ProblemException('not_found');
      const items = (
        await c.query(`SELECT * FROM commerce.quote_items WHERE quote_id = $1 ORDER BY position`, [
          id,
        ])
      ).rows;
      return toDto(q, items, now);
    });
  }
}

export function toDto(q: Row, items: Row[], now: Date): QuoteDto {
  const est = q.tax_estimate as {
    status: 'provisional';
    rateBps: number;
    source: string;
    note: string;
  };
  return {
    id: q.id as string,
    kind: q.kind as QuoteKind,
    status: (q.expires_at as Date).getTime() <= now.getTime() ? 'expired' : 'issued',
    expiresAt: (q.expires_at as Date).toISOString(),
    currency: (q.currency as string).trim(),
    items: items.map((i) => ({
      position: i.position as number,
      description: i.description as string,
      meterId: (i.meter_id as string | null) ?? null,
      quantity: String(i.quantity),
      unit: i.unit as string,
      unitPriceMinor: i.unit_price_minor === null ? null : String(i.unit_price_minor),
      amountMinor: String(i.amount_minor),
    })),
    subtotalMinor: String(q.subtotal_minor),
    taxEstimate: { ...est, taxMinor: String(q.tax_minor) },
    totalMinor: String(q.total_minor),
    requiresApproval: q.requires_approval as boolean,
    approvalDetail: q.approval_detail,
    residency: q.residency as { status: 'not_evaluated' },
    priceBookVersionId: (q.price_book_version_id as string | null) ?? null,
    projectId: (q.project_id as string | null) ?? null,
    createdAt: (q.created_at as Date).toISOString(),
  };
}
