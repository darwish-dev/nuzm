import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { recipes, type LedgerPostingService } from '../../billing';
import type { DocLocale } from './doc-labels';
import { creditable, type CreditNoteStatus, type InvoiceStatus } from './invoice-state';
import { renderDocumentHtml } from './invoice-render';
import type { PdfRenderer } from './pdf.renderer';
import type { SequenceService } from './sequence.service';
import { divRound, type RoundingMode } from './tax-engine';

type Row = Record<string, unknown>;
type RevenueAccount = recipes.RevenueAccount;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreditNoteDto {
  id: string;
  number: string;
  invoiceId: string;
  invoiceNumber: string;
  status: CreditNoteStatus;
  environment: 'sandbox' | 'live';
  currency: string;
  reasonCode: string;
  reason: string;
  lines: { invoiceLineId: string; position: number; netMinor: string; taxMinor: string }[];
  netMinor: string;
  taxMinor: string;
  totalMinor: string;
  issuedAt: string;
  dataRegion: string;
  ledgerPosted: boolean;
}
export interface CreditInput {
  invoiceId: string;
  reasonCode: string;
  reason: string;
  /** Idempotency of the business event (a refund id, a support case): the same key returns the same credit note. */
  sourceKey: string;
  /** Omit to credit everything still creditable on the invoice. */
  lines?: { invoiceLineId: string; netMinor: string }[];
}

/**
 * Credit notes (docs/11 §2): the ONLY way to correct an issued invoice. A credit note references its invoice and lines, can never exceed
 * what is left on any line (and, as a backstop, the invoice total: a trigger under the invoice row lock), gets its own gapless number
 * (series = invoice series + `C`) and posts its own ledger transaction; it never edits the invoice or its postings.
 */
export class CreditNoteService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly sequences: SequenceService,
    private readonly renderer: PdfRenderer,
    private readonly rounding: RoundingMode = 'half_up',
  ) {}

  async issue(
    orgId: string,
    actorUserId: string | null,
    input: CreditInput,
    now = new Date(),
  ): Promise<CreditNoteDto> {
    if (!UUID.test(input.invoiceId))
      throw new ProblemException('validation_failed', 'invoiceId must be a uuid');
    if (!/^[a-z_]{3,40}$/.test(input.reasonCode))
      throw new ProblemException(
        'validation_failed',
        'reasonCode must be 3..40 lowercase letters or underscores',
      );
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500
    )
      throw new ProblemException('validation_failed', 'reason must be 1..500 characters');
    if (
      typeof input.sourceKey !== 'string' ||
      input.sourceKey.length < 1 ||
      input.sourceKey.length > 200
    )
      throw new ProblemException('validation_failed', 'sourceKey must be 1..200 characters');
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, async (c) => {
        if (
          (
            await c.query(
              `SELECT 1 FROM invoicing.credit_notes WHERE org_id = $1 AND source_key = $2`,
              [orgId, input.sourceKey],
            )
          ).rowCount
        )
          return; // replay: nothing to do
        const inv = (
          await c.query(
            `SELECT * FROM invoicing.invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
            [input.invoiceId.toLowerCase(), orgId],
          )
        ).rows[0];
        if (!inv) throw new ProblemException('not_found', 'invoice not found');
        if (!creditable(inv.status as InvoiceStatus))
          throw new ProblemException(
            'conflict',
            `a ${inv.status as string} invoice cannot be credited`,
          );
        const lines = (
          await c.query(
            `SELECT * FROM invoicing.invoice_lines WHERE invoice_id = $1 ORDER BY position`,
            [inv.id],
          )
        ).rows;
        const prior = (
          await c.query<{ lines: { invoiceLineId: string; netMinor: string; taxMinor: string }[] }>(
            `SELECT lines FROM invoicing.credit_notes WHERE invoice_id = $1`,
            [inv.id],
          )
        ).rows;
        const usedNet = new Map<string, bigint>();
        const usedTax = new Map<string, bigint>();
        for (const n of prior)
          for (const l of n.lines) {
            usedNet.set(l.invoiceLineId, (usedNet.get(l.invoiceLineId) ?? 0n) + BigInt(l.netMinor));
            usedTax.set(l.invoiceLineId, (usedTax.get(l.invoiceLineId) ?? 0n) + BigInt(l.taxMinor));
          }
        const remainingNet = (l: Row) =>
          BigInt(l.net_minor as string) - (usedNet.get(l.id as string) ?? 0n);
        const remainingTax = (l: Row) =>
          BigInt(l.tax_minor as string) - (usedTax.get(l.id as string) ?? 0n);
        const requested =
          input.lines ??
          lines
            .filter((l) => remainingNet(l) > 0n || remainingTax(l) > 0n)
            .map((l) => ({ invoiceLineId: l.id as string, netMinor: remainingNet(l).toString() }));
        if (requested.length === 0)
          throw new ProblemException('conflict', 'nothing is left to credit on this invoice');
        const credited: {
          invoiceLineId: string;
          position: number;
          netMinor: bigint;
          taxMinor: bigint;
          account: RevenueAccount;
        }[] = [];
        const seen = new Set<string>();
        for (const r of requested) {
          const line = lines.find((l) => l.id === r.invoiceLineId);
          if (!line || seen.has(r.invoiceLineId))
            throw new ProblemException(
              'validation_failed',
              'every credited line must be a distinct line of this invoice',
            );
          seen.add(r.invoiceLineId);
          if (typeof r.netMinor !== 'string' || !/^\d{1,18}$/.test(r.netMinor))
            throw new ProblemException(
              'validation_failed',
              'netMinor must be a non-negative integer string',
            );
          const net = BigInt(r.netMinor);
          const left = remainingNet(line);
          if (net > left)
            throw new ProblemException(
              'validation_failed',
              `line ${line.position as number} has only ${left.toString()} left to credit`,
            );
          // crediting everything that is left takes the exact remaining tax (no rounding drift); a part is taxed at the line's rate
          const tax =
            net === left && net > 0n
              ? remainingTax(line)
              : (() => {
                  const t = divRound(net * BigInt(line.rate_bps as number), 10_000n, this.rounding);
                  const cap = remainingTax(line);
                  return t > cap ? cap : t;
                })();
          if (net === 0n && tax === 0n) continue;
          credited.push({
            invoiceLineId: line.id as string,
            position: line.position as number,
            netMinor: net,
            taxMinor: tax,
            account: line.revenue_account as RevenueAccount,
          });
        }
        if (credited.length === 0)
          throw new ProblemException('validation_failed', 'a credit note needs a positive amount');
        const net = credited.reduce((s, l) => s + l.netMinor, 0n);
        const tax = credited.reduce((s, l) => s + l.taxMinor, 0n);
        const series = `${inv.series as string}C`;
        const num = await this.sequences.next(c, inv.entity_id as string, series);
        await c.query(
          `INSERT INTO invoicing.credit_notes (id, org_id, invoice_id, entity_id, series, number, number_text, status, environment, currency, reason_code, reason, lines, net_minor, tax_minor, total_minor, issued_at, source_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id,
            orgId,
            inv.id,
            inv.entity_id,
            series,
            num.value.toString(),
            num.formatted,
            inv.environment,
            inv.currency,
            input.reasonCode,
            input.reason.trim(),
            JSON.stringify(
              credited.map((l) => ({
                invoiceLineId: l.invoiceLineId,
                position: l.position,
                netMinor: l.netMinor.toString(),
                taxMinor: l.taxMinor.toString(),
                account: l.account,
              })),
            ),
            net.toString(),
            tax.toString(),
            (net + tax).toString(),
            now,
            input.sourceKey,
            actorUserId,
          ],
        );
        await this.audit.record({
          action: 'invoicing.credit_note.issued',
          ...(actorUserId ? { actorUserId } : { actorType: 'system' as const }),
          orgId,
          resource: { type: 'credit_note', id },
          outcome: 'success',
          after: {
            number: num.formatted,
            invoice: inv.number_text,
            totalMinor: (net + tax).toString(),
            reasonCode: input.reasonCode,
          },
        });
        await enqueue(c, orgId, 'credit_note.issued', {
          creditNoteId: id,
          invoiceId: inv.id,
          totalMinor: (net + tax).toString(),
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        const dup = await this.byKey(orgId, input.sourceKey);
        if (dup) return this.ensureLedger(orgId, dup, actorUserId);
      }
      if ((e as { hint?: string }).hint === 'exceeds_invoice')
        throw new ProblemException('conflict', 'credit notes would exceed the invoice total');
      throw e;
    }
    const created = (await this.byKey(orgId, input.sourceKey))!;
    return this.ensureLedger(orgId, created, actorUserId);
  }

  private async byKey(orgId: string, key: string): Promise<string | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id FROM invoicing.credit_notes WHERE org_id = $1 AND source_key = $2`,
            [orgId, key],
          )
        ).rows[0]?.id,
    );
  }

  async ensureLedger(
    orgId: string,
    id: string,
    actorUserId: string | null,
  ): Promise<CreditNoteDto> {
    const { cn, inv } = await this.load(orgId, id);
    if (cn.ledger_transaction_id === null) {
      const credited = cn.lines as {
        netMinor: string;
        taxMinor: string;
        account: RevenueAccount;
      }[];
      const built = recipes.creditNote({
        orgId,
        documentId: id,
        invoiceId: inv.id as string,
        entityId: cn.entity_id as string,
        currency: (cn.currency as string).trim(),
        number: cn.number_text as string,
        lines: credited.map((l) => ({
          revenueAccount: l.account,
          netMinor: l.netMinor,
          taxMinor: l.taxMinor,
        })),
      });
      const r = await this.ledger.post(built, `credit_note:${id}`, actorUserId ?? undefined);
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE invoicing.credit_notes SET ledger_transaction_id = $2 WHERE id = $1 AND ledger_transaction_id IS NULL`,
          [id, r.transactionId],
        ),
      );
    }
    return this.get(orgId, id);
  }

  private async load(orgId: string, id: string): Promise<{ cn: Row; inv: Row }> {
    return this.db.withOrg(orgId, async (c) => {
      const cn = (
        await c.query(`SELECT * FROM invoicing.credit_notes WHERE id = $1 AND org_id = $2`, [
          id,
          orgId,
        ])
      ).rows[0];
      if (!cn) throw new ProblemException('not_found');
      const inv = (await c.query(`SELECT * FROM invoicing.invoices WHERE id = $1`, [cn.invoice_id]))
        .rows[0]!;
      return { cn, inv };
    });
  }

  private dto(cn: Row, invoiceNumber: string): CreditNoteDto {
    return {
      id: cn.id as string,
      number: cn.number_text as string,
      invoiceId: cn.invoice_id as string,
      invoiceNumber,
      status: cn.status as CreditNoteStatus,
      environment: cn.environment as 'sandbox' | 'live',
      currency: (cn.currency as string).trim(),
      reasonCode: cn.reason_code as string,
      reason: cn.reason as string,
      lines: (
        cn.lines as {
          invoiceLineId: string;
          position: number;
          netMinor: string;
          taxMinor: string;
        }[]
      ).map((l) => ({
        invoiceLineId: l.invoiceLineId,
        position: l.position,
        netMinor: l.netMinor,
        taxMinor: l.taxMinor,
      })),
      netMinor: String(cn.net_minor),
      taxMinor: String(cn.tax_minor),
      totalMinor: String(cn.total_minor),
      issuedAt: (cn.issued_at as Date).toISOString(),
      dataRegion: cn.data_region as string,
      ledgerPosted: cn.ledger_transaction_id !== null,
    };
  }

  async get(orgId: string, id: string): Promise<CreditNoteDto> {
    const { cn, inv } = await this.load(orgId, id);
    return this.dto(cn, inv.number_text as string);
  }

  async list(
    orgId: string,
    o: { limit: number; cursor?: string | undefined; invoiceId?: string | undefined },
  ): Promise<Page<CreditNoteDto>> {
    if (o.invoiceId !== undefined && !UUID.test(o.invoiceId))
      throw new ProblemException('validation_failed', 'invoice must be a uuid');
    const after = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT n.*, i.number_text AS invoice_number FROM invoicing.credit_notes n JOIN invoicing.invoices i ON i.id = n.invoice_id
            WHERE n.org_id = $1 AND ($2::uuid IS NULL OR n.invoice_id = $2::uuid) AND ($3::uuid IS NULL OR n.id < $3::uuid) ORDER BY n.id DESC LIMIT $4`,
          [orgId, o.invoiceId ?? null, after, o.limit + 1],
        )
      ).rows;
      const p = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        o.limit,
      );
      return {
        items: p.items.map((x) => this.dto(x.r, x.r.invoice_number as string)),
        nextCursor: p.nextCursor,
      };
    });
  }

  async pdf(
    orgId: string,
    id: string,
    locale: DocLocale,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const { cn, inv } = await this.load(orgId, id);
    const credited = cn.lines as { position: number; netMinor: string; taxMinor: string }[];
    const invLines = await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM invoicing.invoice_lines WHERE invoice_id = $1`, [inv.id]))
          .rows,
    );
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
    const html = renderDocumentHtml(
      {
        kind: 'credit_note',
        numberText: cn.number_text as string,
        referenceNumber: inv.number_text as string,
        reason: cn.reason as string,
        environment: cn.environment as 'sandbox' | 'live',
        issuedAt: (cn.issued_at as Date).toISOString(),
        currency: (cn.currency as string).trim(),
        lines: credited.map((l) => {
          const src = invLines.find((x) => x.position === l.position)!;
          return {
            description: src.description as string,
            quantity: '',
            unit: '',
            netMinor: l.netMinor,
            taxMinor: l.taxMinor,
            rateBps: src.rate_bps as number,
          };
        }),
        subtotalMinor: String(cn.net_minor),
        taxMinor: String(cn.tax_minor),
        totalMinor: String(cn.total_minor),
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
        taxReviewRequired: false,
      },
      locale,
    );
    return { pdf: await this.renderer.render(html), filename: `${cn.number_text as string}.pdf` };
  }
}
