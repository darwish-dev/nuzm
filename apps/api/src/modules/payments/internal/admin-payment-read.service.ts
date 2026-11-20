import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { RefundDto } from './refund.service';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const INTENT_STATUSES = [
  'requires_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
];
const REFUND_STATUSES = ['pending', 'succeeded', 'failed'];

export interface AdminPaymentDto {
  id: string;
  orgId: string;
  invoiceId: string | null;
  walletTopupId: string | null;
  provider: string;
  amountMinor: string;
  currency: string;
  status: string;
  failureCode: string | null;
  capturedMinor: string;
  refundedMinor: string;
  eventCount: number;
  createdAt: string;
}
export interface AdminPspEventDto {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  error: string | null;
  eventAt: string;
  receivedAt: string;
  processedAt: string | null;
  duplicateCount: number;
  lastDuplicateAt: string | null;
  payload: Record<string, unknown>;
}
export type AdminRefundDto = RefundDto & { orgId: string };

const iso = (v: unknown, name: string): Date | null => {
  if (v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime()))
    throw new ProblemException('validation_failed', `${name} must be an ISO date-time`);
  return d;
};

/** A provider reference is shown as "…" plus its last four characters; the stored payload is a whitelist already (never card data). */
export function redactPspPayload(payload: unknown): Record<string, unknown> {
  const src = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (/token|secret|card|pan|cvv|signature/i.test(k)) continue;
    out[k] = k === 'pspPaymentRef' && typeof v === 'string' ? `…${v.slice(-4)}` : v;
  }
  return out;
}

/**
 * Cross-organization payment and refund reads for finance (S12d, UI-M03-14/15). READ-ONLY, through the platform scope (SELECT only), every
 * read audited. Creating a refund stays with `RefundService.request`.
 */
export class AdminPaymentReadService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async listPayments(
    actorUserId: string,
    o: {
      limit: number;
      cursor?: string | undefined;
      org?: string | undefined;
      status?: string | undefined;
      invoiceId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<Page<AdminPaymentDto>> {
    if (o.org !== undefined && !UUID.test(o.org))
      throw new ProblemException('validation_failed', 'org must be a uuid');
    if (o.invoiceId !== undefined && !UUID.test(o.invoiceId))
      throw new ProblemException('validation_failed', 'invoiceId must be a uuid');
    if (o.status !== undefined && !INTENT_STATUSES.includes(o.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${INTENT_STATUSES.join(', ')}`,
      );
    const from = iso(o.from, 'from');
    const to = iso(o.to, 'to');
    const after = decodeCursor(o.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT p.*, a.code AS provider,
                    (SELECT count(*)::int FROM payments.psp_events e WHERE e.intent_id = p.id) AS event_count
               FROM payments.payment_intents p JOIN payments.psp_accounts a ON a.id = p.psp_account_id
              WHERE ($1::uuid IS NULL OR p.org_id = $1::uuid) AND ($2::text IS NULL OR p.status = $2)
                AND ($3::uuid IS NULL OR p.invoice_id = $3::uuid) AND ($4::timestamptz IS NULL OR p.created_at >= $4)
                AND ($5::timestamptz IS NULL OR p.created_at <= $5) AND ($6::uuid IS NULL OR p.id < $6::uuid)
              ORDER BY p.id DESC LIMIT $7`,
            [o.org ?? null, o.status ?? null, o.invoiceId ?? null, from, to, after, o.limit + 1],
          )
        ).rows as Row[],
    );
    const page = pageOf(
      rows.map((r) => ({ id: r.id as string, r })),
      o.limit,
    );
    await this.audit.record({
      action: 'billing.admin_payments.read',
      actorUserId,
      resource: { type: 'payment_search' },
      outcome: 'success',
      detail: {
        org: o.org ?? null,
        status: o.status ?? null,
        invoiceId: o.invoiceId ?? null,
        rows: page.items.length,
      },
    });
    return {
      items: page.items.map((x) => ({
        id: x.r.id as string,
        orgId: x.r.org_id as string,
        invoiceId: (x.r.invoice_id as string | null) ?? null,
        walletTopupId: (x.r.wallet_topup_id as string | null) ?? null,
        provider: x.r.provider as string,
        amountMinor: String(x.r.amount_minor),
        currency: (x.r.currency as string).trim(),
        status: x.r.status as string,
        failureCode: (x.r.failure_code as string | null) ?? null,
        capturedMinor: String(x.r.captured_minor),
        refundedMinor: String(x.r.refunded_minor),
        eventCount: Number(x.r.event_count),
        createdAt: (x.r.created_at as Date).toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Stored provider events of one payment, oldest first. Redacted: whitelist payload, masked provider reference. */
  async paymentEvents(
    actorUserId: string,
    paymentId: string,
  ): Promise<{ items: AdminPspEventDto[] }> {
    if (!UUID.test(paymentId)) throw new ProblemException('not_found');
    const id = paymentId.toLowerCase();
    const found = await this.db.withPlatformScope(async (c) => {
      const intent = (
        await c.query<{ org_id: string }>(
          `SELECT org_id FROM payments.payment_intents WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!intent) return null;
      const events = (
        await c.query(
          `SELECT * FROM payments.psp_events WHERE intent_id = $1 ORDER BY event_at, id LIMIT 500`,
          [id],
        )
      ).rows as Row[];
      return { orgId: intent.org_id, events };
    });
    if (!found) throw new ProblemException('not_found');
    await this.audit.record({
      action: 'billing.admin_payment_events.read',
      actorUserId,
      orgId: found.orgId,
      resource: { type: 'payment', id },
      outcome: 'success',
      detail: { rows: found.events.length },
    });
    return {
      items: found.events.map((e) => ({
        id: e.id as string,
        provider: e.psp as string,
        eventId: e.event_id as string,
        type: e.type as string,
        status: e.status as AdminPspEventDto['status'],
        error: (e.error as string | null) ?? null,
        eventAt: (e.event_at as Date).toISOString(),
        receivedAt: (e.received_at as Date).toISOString(),
        processedAt: e.processed_at ? (e.processed_at as Date).toISOString() : null,
        duplicateCount: Number(e.duplicate_count),
        lastDuplicateAt: e.last_duplicate_at ? (e.last_duplicate_at as Date).toISOString() : null,
        payload: redactPspPayload(e.payload),
      })),
    };
  }

  async listRefunds(
    actorUserId: string,
    o: {
      limit: number;
      cursor?: string | undefined;
      org?: string | undefined;
      status?: string | undefined;
      paymentId?: string | undefined;
    },
  ): Promise<Page<AdminRefundDto>> {
    if (o.org !== undefined && !UUID.test(o.org))
      throw new ProblemException('validation_failed', 'org must be a uuid');
    if (o.paymentId !== undefined && !UUID.test(o.paymentId))
      throw new ProblemException('validation_failed', 'paymentId must be a uuid');
    if (o.status !== undefined && !REFUND_STATUSES.includes(o.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${REFUND_STATUSES.join(', ')}`,
      );
    const after = decodeCursor(o.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM payments.refunds
              WHERE ($1::uuid IS NULL OR org_id = $1::uuid) AND ($2::text IS NULL OR status = $2)
                AND ($3::uuid IS NULL OR intent_id = $3::uuid) AND ($4::uuid IS NULL OR id < $4::uuid)
              ORDER BY id DESC LIMIT $5`,
            [o.org ?? null, o.status ?? null, o.paymentId ?? null, after, o.limit + 1],
          )
        ).rows as Row[],
    );
    const page = pageOf(
      rows.map((r) => ({ id: r.id as string, r })),
      o.limit,
    );
    await this.audit.record({
      action: 'billing.admin_refunds.read',
      actorUserId,
      resource: { type: 'refund_search' },
      outcome: 'success',
      detail: { org: o.org ?? null, status: o.status ?? null, rows: page.items.length },
    });
    return {
      items: page.items.map((x) => ({
        id: x.r.id as string,
        orgId: x.r.org_id as string,
        paymentId: x.r.intent_id as string,
        amountMinor: String(x.r.amount_minor),
        currency: (x.r.currency as string).trim(),
        status: x.r.status as RefundDto['status'],
        reason: x.r.reason as string,
        failureCode: (x.r.failure_code as string | null) ?? null,
        creditNoteId: (x.r.credit_note_id as string | null) ?? null,
        createdAt: (x.r.created_at as Date).toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
