import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { recipes, type LedgerPostingService } from '../../billing';
import type { CreditNoteService, InvoiceService } from '../../invoicing';
import { PspTimeoutError, type PspAdapter, type PspRefundResult } from './psp/psp';
import type { PspRegistry } from './psp/registry';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINOR = /^[1-9]\d{0,17}$/;

export interface RefundDto {
  id: string;
  paymentId: string;
  amountMinor: string;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string;
  failureCode: string | null;
  creditNoteId: string | null;
  createdAt: string;
}
const dto = (r: Row): RefundDto => ({
  id: r.id as string,
  paymentId: r.intent_id as string,
  amountMinor: String(r.amount_minor),
  currency: (r.currency as string).trim(),
  status: r.status as RefundDto['status'],
  reason: r.reason as string,
  failureCode: (r.failure_code as string | null) ?? null,
  creditNoteId: (r.credit_note_id as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

/**
 * Refunds (docs/11 §7, docs/04 POST /v1/admin/billing/refunds). The rules that matter:
 *  - **Never more than was captured:** a refund is inserted under the payment's row lock and RESERVES its amount while pending
 *    (remaining = captured − refunded − pending), so concurrent refunds and a late capture cannot exceed the capture.
 *  - **Idempotent:** one (requester, Idempotency-Key) is one refund; the PSP receives the refund's own merchant reference as its idempotency key.
 *  - **Reconcile before retry:** an uncertain PSP answer leaves the refund `pending`; before any new PSP call the PSP is asked about the
 *    merchant reference, and a refund that already happened is adopted, never repeated.
 *  - **One ledger effect per refund:** `payment:<id>:refund:<refundId>`, linked once; a crash between the PSP answer and the ledger is repaired
 *    by `complete`.
 */
export class RefundService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly psp: PspRegistry,
    private readonly invoices: Pick<InvoiceService, 'appliedOf'>,
    private readonly creditNotes: Pick<CreditNoteService, 'get' | 'markRefunded'>,
  ) {}

  async request(
    actorUserId: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<{ refund: RefundDto; httpStatus: 200 | 201 | 202 }> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 255)
      throw new ProblemException('validation_failed', 'Idempotency-Key must be 1..255 characters');
    if (typeof input.paymentId !== 'string' || !UUID.test(input.paymentId))
      throw new ProblemException('validation_failed', 'paymentId must be a uuid');
    const amount = input.amount;
    if (typeof amount !== 'string' || !MINOR.test(amount))
      throw new ProblemException(
        'validation_failed',
        'amount must be a positive integer string (minor units)',
      );
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500
    )
      throw new ProblemException('validation_failed', 'reason must be 1..500 characters');
    const creditNoteId = input.creditNoteId ?? null;
    if (creditNoteId !== null && (typeof creditNoteId !== 'string' || !UUID.test(creditNoteId)))
      throw new ProblemException('validation_failed', 'creditNoteId must be a uuid');
    const paymentId = input.paymentId.toLowerCase();
    const reason = input.reason.trim();
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          paymentId,
          amount,
          reason,
          creditNoteId: creditNoteId === null ? null : (creditNoteId as string).toLowerCase(),
        }),
      )
      .digest('hex');

    // the organization comes from the payment itself (finance acts on any organization; the row is the authority, never the body)
    const found = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ org_id: string }>(
            `SELECT org_id FROM payments.payment_intents WHERE id = $1`,
            [paymentId],
          )
        ).rows[0],
    );
    if (!found) throw new ProblemException('not_found', 'payment not found');
    const orgId = found.org_id;

    // reads that use other connections happen BEFORE the transaction that holds the payment's row lock (no nested connections)
    const applied = await this.invoices.appliedOf(orgId, paymentId);
    const note =
      creditNoteId === null
        ? null
        : await this.creditNotes.get(orgId, (creditNoteId as string).toLowerCase());

    const refundId = uuidv7();
    const created = await this.db.withOrg(orgId, async (c) => {
      const prior = (
        await c.query(
          `SELECT * FROM payments.refunds WHERE requested_by = $1 AND idempotency_key = $2`,
          [actorUserId, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new ProblemException('idempotency_key_reuse');
        return { row: prior as Row, replayed: true };
      }
      const intent = (
        await c.query(
          `SELECT * FROM payments.payment_intents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [paymentId, orgId],
        )
      ).rows[0] as Row;
      if (intent.wallet_topup_id !== null)
        throw new ProblemException(
          'validation_failed',
          'refunding a wallet top-up is not available yet (needs the unspent-credit rule)',
        );
      if (intent.status !== 'succeeded' && intent.status !== 'partially_refunded')
        throw new ProblemException(
          'conflict',
          `a ${intent.status as string} payment cannot be refunded`,
        );
      if (intent.ledger_transaction_id === null)
        throw new ProblemException(
          'conflict',
          'the payment is still being finalized; retry shortly',
        );
      const captured = BigInt(intent.captured_minor as string);
      const pending = BigInt(
        (
          await c.query<{ n: string }>(
            `SELECT coalesce(sum(amount_minor), 0)::text n FROM payments.refunds WHERE intent_id = $1 AND status = 'pending'`,
            [paymentId],
          )
        ).rows[0]!.n,
      );
      const remaining = captured - BigInt(intent.refunded_minor as string) - pending;
      if (BigInt(amount) > remaining)
        throw new ProblemException(
          'validation_failed',
          `the amount exceeds what can still be refunded (${remaining.toString()})`,
        );
      // part of the refund comes out of the unapplied customer payments (2500) when some of the capture was never applied to an invoice
      const unappliedTaken = BigInt(
        (
          await c.query<{ n: string }>(
            `SELECT coalesce(sum(unapplied_minor), 0)::text n FROM payments.refunds WHERE intent_id = $1 AND status IN ('pending','succeeded')`,
            [paymentId],
          )
        ).rows[0]!.n,
      );
      const unappliedLeft = captured - applied - unappliedTaken;
      const unapplied =
        unappliedLeft <= 0n ? 0n : unappliedLeft < BigInt(amount) ? unappliedLeft : BigInt(amount);
      if (note) {
        if (note.status !== 'issued')
          throw new ProblemException(
            'validation_failed',
            `the credit note is ${note.status}, not issued`,
          );
        if (note.invoiceId !== intent.invoice_id)
          throw new ProblemException(
            'validation_failed',
            'the credit note belongs to another invoice',
          );
        if (note.currency !== (intent.currency as string).trim())
          throw new ProblemException('validation_failed', 'the credit note is in another currency');
      }
      const row = (
        await c.query(
          `INSERT INTO payments.refunds (id, org_id, intent_id, amount_minor, unapplied_minor, currency, reason, merchant_reference, credit_note_id, requested_by, idempotency_key, request_hash, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
          [
            refundId,
            orgId,
            paymentId,
            amount,
            unapplied.toString(),
            (intent.currency as string).trim(),
            reason,
            `nuzm_rf_${refundId}`,
            creditNoteId === null ? null : (creditNoteId as string).toLowerCase(),
            actorUserId,
            idempotencyKey,
            hash,
            now,
          ],
        )
      ).rows[0] as Row;
      await this.audit.record({
        action: 'payments.refund.requested',
        actorUserId,
        orgId,
        resource: { type: 'refund', id: refundId },
        outcome: 'success',
        after: { paymentId, amountMinor: amount, currency: (intent.currency as string).trim() },
      });
      return { row, replayed: false };
    });
    if (created.replayed) {
      // a replay returns what is true now (a pending refund is looked at again, never re-sent blindly)
      const settled = await this.reconcile(orgId, created.row.id as string, now);
      return { refund: settled, httpStatus: 200 };
    }
    const settled = await this.send(orgId, refundId, now);
    return { refund: settled, httpStatus: settled.status === 'pending' ? 202 : 201 };
  }

  private async load(orgId: string, refundId: string) {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT r.*, i.merchant_reference AS pay_ref, i.psp_payment_ref, i.invoice_id, a.code AS psp_code, a.provider
               FROM payments.refunds r JOIN payments.payment_intents i ON i.id = r.intent_id
               JOIN payments.psp_accounts a ON a.id = i.psp_account_id
              WHERE r.id = $1 AND r.org_id = $2`,
            [refundId, orgId],
          )
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return r as Row;
  }

  /** The first (and only) PSP call for a new refund. An unknown outcome leaves it pending for `reconcile`. */
  private async send(orgId: string, refundId: string, now: Date): Promise<RefundDto> {
    const r = await this.load(orgId, refundId);
    const adapter = this.psp.find(r.provider as string);
    if (!adapter) return dto(r); // no PSP available: stays pending, reconciled when one is
    let res: PspRefundResult | null = null;
    try {
      res = await this.call(adapter, r);
    } catch (e) {
      if (!(e instanceof PspTimeoutError)) res = null; // dropped connection or 5xx: also unknown
    }
    if (res) await this.finalize(orgId, refundId, res, now);
    return dto(await this.load(orgId, refundId));
  }

  private call(adapter: PspAdapter, r: Row): Promise<PspRefundResult> {
    return adapter.createRefund({
      merchantReference: r.merchant_reference as string,
      paymentMerchantReference: r.pay_ref as string,
      pspPaymentRef: (r.psp_payment_ref as string | null) ?? '',
      idempotencyKey: r.merchant_reference as string,
      amountMinor: String(r.amount_minor),
      currency: (r.currency as string).trim(),
    });
  }

  /**
   * Ask the PSP what is true about a pending refund and adopt it. Only when the PSP has NO record of the reference (the request never
   * arrived) is the refund sent once more, with the same merchant reference.
   */
  async reconcile(orgId: string, refundId: string, now = new Date()): Promise<RefundDto> {
    const r = await this.load(orgId, refundId);
    if (r.status !== 'pending') {
      if (r.status === 'succeeded') await this.complete(orgId, refundId);
      return dto(r);
    }
    const adapter = this.psp.find(r.provider as string);
    if (!adapter) return dto(r);
    let known: PspRefundResult | null;
    try {
      known = await adapter.retrieveRefund(r.merchant_reference as string);
    } catch {
      return dto(r); // the PSP cannot be asked right now: change nothing, never retry blindly
    }
    if (known) {
      if (known.status !== 'pending') await this.finalize(orgId, refundId, known, now);
      return dto(await this.load(orgId, refundId));
    }
    return this.send(orgId, refundId, now);
  }

  /** Record the PSP's verdict (once) and then run the ledger/credit-note effects. */
  private async finalize(orgId: string, refundId: string, res: PspRefundResult, now: Date) {
    if (res.status === 'pending') return;
    await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM payments.refunds WHERE id = $1 AND org_id = $2 FOR UPDATE`, [
          refundId,
          orgId,
        ])
      ).rows[0] as Row;
      if (r.status !== 'pending') return; // final already
      const intent = (
        await c.query(`SELECT * FROM payments.payment_intents WHERE id = $1 FOR UPDATE`, [
          r.intent_id,
        ])
      ).rows[0] as Row;
      if (res.status === 'failed') {
        await c.query(
          `UPDATE payments.refunds SET status = 'failed', failure_code = $2, psp_refund_ref = $3, updated_at = $4 WHERE id = $1`,
          [refundId, res.failureCode ?? 'refund_failed', res.pspRefundRef, now],
        );
        await this.audit.record({
          action: 'payments.refund.failed',
          actorType: 'system',
          orgId,
          resource: { type: 'refund', id: refundId },
          outcome: 'failure',
          detail: { failureCode: res.failureCode ?? 'refund_failed' },
        });
        return;
      }
      const refunded = BigInt(intent.refunded_minor as string) + BigInt(r.amount_minor as string);
      const full = refunded === BigInt(intent.captured_minor as string);
      await c.query(
        `UPDATE payments.refunds SET status = 'succeeded', psp_refund_ref = $2, failure_code = NULL, updated_at = $3 WHERE id = $1`,
        [refundId, res.pspRefundRef, now],
      );
      await c.query(
        `UPDATE payments.payment_intents SET refunded_minor = $2, status = $3, updated_at = $4 WHERE id = $1`,
        [intent.id, refunded.toString(), full ? 'refunded' : 'partially_refunded', now],
      );
      await enqueue(c, orgId, 'payment.refunded', {
        paymentId: intent.id,
        refundId,
        amountMinor: String(r.amount_minor),
        currency: (r.currency as string).trim(),
      });
      await this.audit.record({
        action: 'payments.refund.succeeded',
        actorType: 'system',
        orgId,
        resource: { type: 'refund', id: refundId },
        outcome: 'success',
        after: {
          amountMinor: String(r.amount_minor),
          status: full ? 'refunded' : 'partially_refunded',
        },
      });
    });
    await this.complete(orgId, refundId);
  }

  /** The ledger entry and the credit-note link for a succeeded refund. Idempotent; safe to call any number of times. */
  async complete(orgId: string, refundId: string): Promise<void> {
    const r = await this.load(orgId, refundId);
    if (r.status !== 'succeeded') return;
    if (r.ledger_transaction_id === null) {
      const posted = await this.ledger.post(
        recipes.refund({
          orgId,
          refundId,
          paymentId: r.intent_id as string,
          pspAccountCode: r.psp_code as string,
          currency: (r.currency as string).trim(),
          amountMinor: String(r.amount_minor),
          unappliedMinor: String(r.unapplied_minor),
        }),
        `payment:${r.intent_id as string}:refund:${refundId}`,
      );
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE payments.refunds SET ledger_transaction_id = $2, updated_at = now() WHERE id = $1 AND ledger_transaction_id IS NULL`,
          [refundId, posted.transactionId],
        ),
      );
    }
    if (r.credit_note_id) {
      // the credit note is "refunded" once the money returned to the customer covers its total
      const cn = await this.creditNotes.get(orgId, r.credit_note_id as string);
      const returned = BigInt(
        await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query<{ n: string }>(
                `SELECT coalesce(sum(amount_minor), 0)::text n FROM payments.refunds WHERE credit_note_id = $1 AND status = 'succeeded'`,
                [r.credit_note_id],
              )
            ).rows[0]!.n,
        ),
      );
      if (returned >= BigInt(cn.totalMinor)) await this.creditNotes.markRefunded(orgId, cn.id);
    }
  }

  /** Sweeper entry point: look again at refunds that are still pending (uncertain answers, slow PSPs). */
  async processPending(limit = 50, olderThanSeconds = 30, now = new Date()): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ id: string; org_id: string }>(
            `SELECT id, org_id FROM payments.refunds WHERE status = 'pending' AND created_at < $2 ORDER BY created_at LIMIT $1`,
            [limit, new Date(now.getTime() - olderThanSeconds * 1000)],
          )
        ).rows,
    );
    let n = 0;
    for (const r of rows) {
      const before = r.id;
      const after = await this.reconcile(r.org_id, before, now);
      if (after.status !== 'pending') n++;
    }
    return n;
  }

  async get(orgId: string, refundId: string): Promise<RefundDto> {
    return dto(await this.load(orgId, refundId));
  }
}
