import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { dateOnly } from '../../../common/dates';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { formatDec, parseDec } from '../../../common/rating';
import { recipes, type LedgerPostingService } from '../../billing';
import type { RatingService } from '../../metering';
import { label, type DocLocale } from './doc-labels';
import { renderDocumentHtml, type RenderDocument } from './invoice-render';
import { creditable, type InvoiceStatus } from './invoice-state';
import type { PdfRenderer } from './pdf.renderer';
import type { SequenceService } from './sequence.service';
import type { TaxService } from './tax.service';

type Row = Record<string, unknown>;
type RevenueAccount = recipes.RevenueAccount;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const CURRENCY = /^[A-Z]{3}$/;
const STATUSES: InvoiceStatus[] = ['open', 'partially_paid', 'paid', 'void', 'uncollectible'];

export interface InvoiceLineDto {
  position: number;
  kind: 'usage' | 'order' | 'subscription';
  description: string;
  meterId: string | null;
  quantity: string;
  unit: string;
  netMinor: string;
  taxMinor: string;
  rateCode: string;
  rateBps: number;
}
export interface InvoiceDto {
  id: string;
  number: string;
  status: InvoiceStatus;
  environment: 'sandbox' | 'live';
  currency: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueAt: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  paidMinor: string;
  lines: InvoiceLineDto[];
  taxBreakdown: { rateCode: string; rateBps: number; netMinor: string; taxMinor: string }[];
  taxReview: { required: boolean; reasons: string[] };
  seller: { legalName: { ar: string; en: string }; vatNumber: string | null; placeholder: boolean };
  buyer: {
    legalName: { ar: string; en: string };
    vatNumber: string | null;
    buyerType: 'b2b' | 'b2c';
  };
  dataRegion: string;
  /** ZATCA e-invoice status: the module arrives in S11, until then nothing is generated. */
  zatca: { state: 'not_generated'; uuid: null; qr: null };
  ledgerPosted: boolean;
}
export interface CloseResult {
  invoice: InvoiceDto | null;
  created: boolean;
  /** Usage that could not be priced (no price item): reported, never silently dropped. */
  unpriced: { meterId: string; resourceKey: string; quantity: string }[];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const monthEnd = (start: string) => {
  const d = new Date(`${start}T00:00:00Z`);
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};
const nextMonth = (start: string) => {
  const d = new Date(`${start}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};
const orderAccount = (kind: string): RevenueAccount =>
  kind === 'domain' ? '4300' : kind === 'marketplace' ? '4400' : kind === 'plan' ? '4200' : '4100';

/** One revenue line before tax: where it came from decides the account and (through `sourceId`) that it is billed once, ever. */
interface DraftLine {
  kind: 'usage' | 'order' | 'subscription';
  description: string;
  meterId: string | null;
  quantity: string;
  unit: string;
  netMinor: bigint;
  revenueAccount: RevenueAccount;
  sourceId: string;
}

export function invoiceDto(inv: Row, lines: Row[]): InvoiceDto {
  const byRate = new Map<string, { rateCode: string; rateBps: number; net: bigint; tax: bigint }>();
  for (const l of lines) {
    const k = `${l.rate_code as string}|${l.rate_bps as number}`;
    const e = byRate.get(k) ?? {
      rateCode: l.rate_code as string,
      rateBps: l.rate_bps as number,
      net: 0n,
      tax: 0n,
    };
    e.net += BigInt(l.net_minor as string);
    e.tax += BigInt(l.tax_minor as string);
    byRate.set(k, e);
  }
  const buyer = inv.buyer as {
    legalName: { ar: string; en: string };
    vatNumber: string | null;
    buyerType: 'b2b' | 'b2c';
  };
  const seller = inv.seller as {
    legalName: { ar: string; en: string };
    vatNumber: string | null;
    placeholder: boolean;
  };
  return {
    id: inv.id as string,
    number: inv.number_text as string,
    status: inv.status as InvoiceStatus,
    environment: inv.environment as 'sandbox' | 'live',
    currency: (inv.currency as string).trim(),
    periodStart: ymdOf(inv.period_start),
    periodEnd: ymdOf(inv.period_end),
    issuedAt: (inv.issued_at as Date).toISOString(),
    dueAt: (inv.due_at as Date).toISOString(),
    subtotalMinor: String(inv.subtotal_minor),
    taxMinor: String(inv.tax_minor),
    totalMinor: String(inv.total_minor),
    paidMinor: String(inv.paid_minor),
    lines: lines.map((l) => ({
      position: l.position as number,
      kind: l.kind as InvoiceLineDto['kind'],
      description: l.description as string,
      meterId: (l.meter_id as string | null) ?? null,
      quantity: String(l.quantity),
      unit: l.unit as string,
      netMinor: String(l.net_minor),
      taxMinor: String(l.tax_minor),
      rateCode: l.rate_code as string,
      rateBps: l.rate_bps as number,
    })),
    taxBreakdown: [...byRate.values()].map((e) => ({
      rateCode: e.rateCode,
      rateBps: e.rateBps,
      netMinor: e.net.toString(),
      taxMinor: e.tax.toString(),
    })),
    taxReview: inv.tax_review as InvoiceDto['taxReview'],
    seller: {
      legalName: seller.legalName,
      vatNumber: seller.vatNumber,
      placeholder: seller.placeholder,
    },
    buyer: { legalName: buyer.legalName, vatNumber: buyer.vatNumber, buyerType: buyer.buyerType },
    dataRegion: inv.data_region as string,
    zatca: { state: 'not_generated', uuid: null, qr: null },
    ledgerPosted: inv.ledger_transaction_id !== null,
  };
}
const ymdOf = dateOnly;

/**
 * Invoice builder and issuer (docs/11 §1, M03 §4.3). A period close is ONE idempotent operation per (organization, period, entity):
 * rating run → build lines (rated usage, uninvoiced orders) → per-line tax → issue (gapless number, immutable rows, `invoice.issued`
 * event) → ledger posting. The ledger step runs after the invoice commits and is itself idempotent (`invoice:<id>`), so a crash between
 * the two is repaired by the next call (`ledgerPosted` shows the gap; RC-02 reconciles it).
 */
export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly tax: Pick<TaxService, 'estimate'>,
    private readonly rating: Pick<RatingService, 'rate'>,
    private readonly sequences: SequenceService,
    private readonly renderer: PdfRenderer,
    private readonly opts: { mode: 'sandbox' | 'live'; dueDays: number } = {
      mode: 'sandbox',
      dueDays: 14,
    },
  ) {}

  static optsFromEnv(env: NodeJS.ProcessEnv = process.env) {
    return {
      mode: env.INVOICING_MODE === 'live' ? ('live' as const) : ('sandbox' as const),
      dueDays: Math.max(0, Number(env.INVOICE_DUE_DAYS ?? 14) || 14),
    };
  }

  // ---- period close -----------------------------------------------------------------------------------------------

  async periodClose(
    orgId: string,
    periodStart: string,
    actorUserId: string | null = null,
    now = new Date(),
    currency = 'SAR',
  ): Promise<CloseResult> {
    if (!PERIOD.test(periodStart))
      throw new ProblemException(
        'validation_failed',
        'periodStart must be the first day of a month (YYYY-MM-01)',
      );
    if (!CURRENCY.test(currency))
      throw new ProblemException('validation_failed', 'currency must be an ISO 4217 code');
    const entity = await this.entity();
    const sourceKey = `period:${periodStart.slice(0, 7)}:${currency}`;
    const existing = await this.findByKey(orgId, entity.id as string, sourceKey);
    if (existing)
      return {
        invoice: await this.ensureLedger(orgId, existing.id as string, actorUserId),
        created: false,
        unpriced: [],
      };

    const run = await this.rating.rate(orgId, periodStart, { currency });
    const lines = await this.collect(orgId, periodStart, currency, run.rows);
    if (lines.length === 0) return { invoice: null, created: false, unpriced: run.unpriced };
    const { id, created } = await this.issue(
      orgId,
      entity,
      { periodStart, sourceKey, currency, lines },
      actorUserId,
      now,
    );
    return {
      invoice: await this.ensureLedger(orgId, id, actorUserId),
      created,
      unpriced: run.unpriced,
    };
  }

  /** Rated usage (grouped by meter) plus order items not yet invoiced; zero-priced usage stays on the usage statement. */
  private async collect(
    orgId: string,
    periodStart: string,
    currency: string,
    rows: { meterId: string; amountMinor: string; billableQuantity: string }[],
  ): Promise<DraftLine[]> {
    const out: DraftLine[] = [];
    const byMeter = new Map<string, { net: bigint; qty: bigint }>();
    for (const r of rows) {
      const e = byMeter.get(r.meterId) ?? { net: 0n, qty: 0n };
      e.net += BigInt(r.amountMinor);
      e.qty += parseDec(r.billableQuantity);
      byMeter.set(r.meterId, e);
    }
    const units = await this.db.withOrg(orgId, async (c) => {
      const m = new Map<string, string>();
      for (const r of (
        await c.query<{ id: string; unit: string }>(
          `SELECT id, unit FROM metering.meters WHERE id = ANY($1)`,
          [[...byMeter.keys()]],
        )
      ).rows)
        m.set(r.id, r.unit);
      return m;
    });
    for (const [meterId, e] of [...byMeter].sort(([a], [b]) => a.localeCompare(b)))
      if (e.net > 0n)
        out.push({
          kind: 'usage',
          description: `Usage ${meterId}`,
          meterId,
          quantity: formatDec(e.qty),
          unit: units.get(meterId) ?? 'unit',
          netMinor: e.net,
          revenueAccount: '4100',
          sourceId: `usage:${periodStart}:${meterId}`,
        });
    const orders = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<Row>(
            `SELECT i.id, i.description, i.meter_id, i.quantity, i.unit, i.amount_minor, o.kind
             FROM commerce.order_items i JOIN commerce.orders o ON o.id = i.order_id
             LEFT JOIN invoicing.invoice_lines l ON l.org_id = i.org_id AND l.source_id = 'order_item:' || i.id::text
            WHERE o.org_id = $1 AND o.currency = $2 AND o.status <> 'cancelled' AND i.amount_minor > 0 AND l.id IS NULL
              AND o.created_at >= $3::date AND o.created_at < $4::timestamptz
            ORDER BY o.created_at, i.position`,
            [orgId, currency, periodStart, nextMonth(periodStart)],
          )
        ).rows,
    );
    for (const o of orders)
      out.push({
        kind: 'order',
        description: o.description as string,
        meterId: (o.meter_id as string | null) ?? null,
        quantity: String(o.quantity),
        unit: o.unit as string,
        netMinor: BigInt(o.amount_minor as string),
        revenueAccount: orderAccount(o.kind as string),
        sourceId: `order_item:${o.id as string}`,
      });
    return out;
  }

  // ---- issue ------------------------------------------------------------------------------------------------------

  private async entity(): Promise<Row> {
    const e = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM invoicing.billing_entities WHERE status = 'active' ORDER BY created_at, id LIMIT 1`,
          )
        ).rows[0],
    );
    if (!e)
      throw new ProblemException('service_unavailable', 'no active billing entity is configured');
    if (this.opts.mode === 'live' && e.placeholder)
      throw new ProblemException(
        'service_unavailable',
        'issuing outside the sandbox needs the real billing entity (HG-03-01); the placeholder entity is not registered',
      );
    return e;
  }

  private async findByKey(orgId: string, entityId: string, key: string): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM invoicing.invoices WHERE org_id = $1 AND entity_id = $2 AND source_key = $3`,
            [orgId, entityId, key],
          )
        ).rows[0],
    );
  }

  private async issue(
    orgId: string,
    entity: Row,
    d: { periodStart: string; sourceKey: string; currency: string; lines: DraftLine[] },
    actorUserId: string | null,
    now: Date,
  ): Promise<{ id: string; created: boolean }> {
    const est = await this.tax.estimate(
      orgId,
      d.lines.map((l) => l.netMinor),
      now,
    );
    const subtotal = d.lines.reduce((s, l) => s + l.netMinor, 0n);
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, async (c) => {
        const buyer = await this.buyerSnapshot(c, orgId);
        const num = await this.sequences.next(
          c,
          entity.id as string,
          entity.invoice_series as string,
        );
        await c.query(
          `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at,
             source_key, subtotal_minor, tax_minor, total_minor, tax_review, buyer, seller, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            id,
            orgId,
            entity.id,
            entity.invoice_series,
            num.value.toString(),
            num.formatted,
            this.opts.mode,
            d.currency,
            d.periodStart,
            monthEnd(d.periodStart),
            now,
            new Date(now.getTime() + this.opts.dueDays * 86_400_000),
            d.sourceKey,
            subtotal.toString(),
            est.taxMinor.toString(),
            (subtotal + est.taxMinor).toString(),
            JSON.stringify({ required: est.reviewRequired, reasons: est.reasons }),
            JSON.stringify(buyer),
            JSON.stringify({
              legalName: { ar: entity.legal_name_ar, en: entity.legal_name_en },
              vatNumber: entity.vat_number,
              crNumber: entity.cr_number,
              address: entity.address,
              placeholder: entity.placeholder,
            }),
            actorUserId,
          ],
        );
        let pos = 1;
        for (const [i, l] of d.lines.entries())
          await c.query(
            `INSERT INTO invoicing.invoice_lines (id, invoice_id, org_id, position, kind, description, meter_id, quantity, unit, net_minor, tax_minor, rate_code, rate_bps, revenue_account, source_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              uuidv7(),
              id,
              orgId,
              pos++,
              l.kind,
              l.description,
              l.meterId,
              l.quantity,
              l.unit,
              l.netMinor.toString(),
              est.perLineTaxMinor[i]!.toString(),
              est.rateCode,
              est.rateBps,
              l.revenueAccount,
              l.sourceId,
            ],
          );
        await this.audit.record({
          action: 'invoicing.invoice.issued',
          ...(actorUserId ? { actorUserId } : { actorType: 'system' as const }),
          orgId,
          resource: { type: 'invoice', id },
          outcome: 'success',
          after: {
            number: num.formatted,
            totalMinor: (subtotal + est.taxMinor).toString(),
            currency: d.currency,
            environment: this.opts.mode,
            taxReview: est.reviewRequired,
          },
        });
        await enqueue(c, orgId, 'invoice.issued', {
          invoiceId: id,
          number: num.formatted,
          totalMinor: (subtotal + est.taxMinor).toString(),
          currency: d.currency,
        });
      });
      return { id, created: true };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        // a parallel close won (the failed attempt rolled its number back); return the winner
        const winner = await this.findByKey(orgId, entity.id as string, d.sourceKey);
        if (winner) return { id: winner.id as string, created: false };
      }
      throw e;
    }
  }

  private async buyerSnapshot(c: PoolClient, orgId: string) {
    const p = (await c.query(`SELECT * FROM invoicing.tax_profiles WHERE org_id = $1`, [orgId]))
      .rows[0];
    if (p)
      return {
        buyerType: p.buyer_type,
        legalName: { ar: p.legal_name_ar, en: p.legal_name_en },
        vatNumber: p.vat_number,
        crNumber: p.cr_number,
        address: p.address,
      };
    const org = (
      await c.query<{ name: string }>(`SELECT name FROM tenancy.organizations WHERE id = $1`, [
        orgId,
      ])
    ).rows[0];
    const name = org?.name ?? orgId;
    return {
      buyerType: 'b2c',
      legalName: { ar: name, en: name },
      vatNumber: null,
      crNumber: null,
      address: {},
    };
  }

  // ---- ledger -----------------------------------------------------------------------------------------------------

  /** Post the invoice to the ledger (idempotent) and link it; a no-op once linked. */
  async ensureLedger(
    orgId: string,
    invoiceId: string,
    actorUserId: string | null = null,
  ): Promise<InvoiceDto> {
    const { inv, lines } = await this.load(orgId, invoiceId);
    if (inv.ledger_transaction_id === null) {
      const built = recipes.invoiceIssued({
        orgId,
        documentId: invoiceId,
        invoiceId,
        entityId: inv.entity_id as string,
        currency: (inv.currency as string).trim(),
        number: inv.number_text as string,
        lines: lines.map((l) => ({
          revenueAccount: l.revenue_account as RevenueAccount,
          netMinor: String(l.net_minor),
          taxMinor: String(l.tax_minor),
        })),
      });
      const r = await this.ledger.post(built, `invoice:${invoiceId}`, actorUserId ?? undefined);
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE invoicing.invoices SET ledger_transaction_id = $2, updated_at = now() WHERE id = $1 AND ledger_transaction_id IS NULL`,
          [invoiceId, r.transactionId],
        ),
      );
    }
    return this.get(orgId, invoiceId);
  }

  // ---- reads ------------------------------------------------------------------------------------------------------

  private async load(orgId: string, id: string): Promise<{ inv: Row; lines: Row[] }> {
    return this.db.withOrg(orgId, async (c) => {
      const inv = (
        await c.query(`SELECT * FROM invoicing.invoices WHERE id = $1 AND org_id = $2`, [id, orgId])
      ).rows[0];
      if (!inv) throw new ProblemException('not_found');
      const lines = (
        await c.query(
          `SELECT * FROM invoicing.invoice_lines WHERE invoice_id = $1 ORDER BY position`,
          [id],
        )
      ).rows;
      return { inv, lines };
    });
  }

  async get(orgId: string, id: string): Promise<InvoiceDto> {
    const { inv, lines } = await this.load(orgId, id);
    return invoiceDto(inv, lines);
  }

  async list(
    orgId: string,
    o: {
      limit: number;
      cursor?: string | undefined;
      status?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    },
  ): Promise<Page<InvoiceDto>> {
    if (o.status !== undefined && !STATUSES.includes(o.status as InvoiceStatus))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    const after = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM invoicing.invoices WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::timestamptz IS NULL OR issued_at >= $3) AND ($4::timestamptz IS NULL OR issued_at <= $4)
              AND ($5::uuid IS NULL OR id < $5::uuid) ORDER BY id DESC LIMIT $6`,
          [orgId, o.status ?? null, o.from ?? null, o.to ?? null, after, o.limit + 1],
        )
      ).rows;
      const page = pageOf(
        rows.map((r) => ({ id: r.id as string, row: r })),
        o.limit,
      );
      const ids = page.items.map((p) => p.id);
      const lines = ids.length
        ? (
            await c.query(
              `SELECT * FROM invoicing.invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, position`,
              [ids],
            )
          ).rows
        : [];
      return {
        items: page.items.map((p) =>
          invoiceDto(
            p.row,
            lines.filter((l) => l.invoice_id === p.id),
          ),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  async pdf(
    orgId: string,
    id: string,
    locale: DocLocale,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const { inv, lines } = await this.load(orgId, id);
    const dto = invoiceDto(inv, lines);
    const html = renderDocumentHtml(toRender(inv, lines, dto), locale);
    return { pdf: await this.renderer.render(html), filename: `${dto.number}.pdf` };
  }

  /** Whether `creditable` statuses allow a credit note (used by the credit-note service). */
  static creditable = creditable;
  static label = label;
}

export function toRender(inv: Row, lines: Row[], dto: InvoiceDto): RenderDocument {
  const b = inv.buyer as {
    legalName: { ar: string; en: string };
    vatNumber: string | null;
    crNumber: string | null;
    address: Record<string, string>;
  };
  const s = inv.seller as {
    legalName: { ar: string; en: string };
    vatNumber: string | null;
    crNumber: string | null;
    address: Record<string, string>;
    placeholder: boolean;
  };
  return {
    kind: 'invoice',
    numberText: dto.number,
    environment: dto.environment,
    issuedAt: dto.issuedAt,
    dueAt: dto.dueAt,
    periodStart: dto.periodStart,
    periodEnd: dto.periodEnd,
    currency: dto.currency,
    lines: lines.map((l) => ({
      description: l.description as string,
      quantity: String(l.quantity).replace(/\.?0+$/, '') || '0',
      unit: l.unit as string,
      netMinor: String(l.net_minor),
      taxMinor: String(l.tax_minor),
      rateBps: l.rate_bps as number,
    })),
    subtotalMinor: dto.subtotalMinor,
    taxMinor: dto.taxMinor,
    totalMinor: dto.totalMinor,
    seller: {
      legalName: s.legalName,
      vatNumber: s.vatNumber,
      crNumber: s.crNumber,
      address: s.address ?? {},
      placeholder: s.placeholder,
    },
    buyer: {
      legalName: b.legalName,
      vatNumber: b.vatNumber,
      crNumber: b.crNumber,
      address: b.address ?? {},
    },
    taxReviewRequired: dto.taxReview.required,
  };
}
