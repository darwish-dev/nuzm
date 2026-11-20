import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { recipes, type LedgerPostingService, type WalletTopupService } from '../../billing';
import type { InvoiceService } from '../../invoicing';
import { containsCardData } from './pan';
import { isOpenIntent, type IntentStatus } from './payment-state';
import {
  PspTimeoutError,
  WebhookRejectedError,
  type PspAdapter,
  type PspPaymentResult,
  type WebhookEvent,
} from './psp/psp';
import type { PspRegistry } from './psp/registry';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const MINOR = /^[1-9]\d{0,17}$/;
const STATUSES: IntentStatus[] = [
  'requires_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
];

export interface PaymentDto {
  id: string;
  /** The invoice being paid, or null for a wallet top-up payment. */
  invoiceId: string | null;
  walletTopupId: string | null;
  amountMinor: string;
  currency: string;
  status: IntentStatus;
  paymentMethodId: string | null;
  nextAction: { type: 'redirect'; url: string } | null;
  failureCode: string | null;
  capturedMinor: string;
  refundedMinor: string;
  createdAt: string;
}
const dto = (r: Row): PaymentDto => ({
  id: r.id as string,
  invoiceId: (r.invoice_id as string | null) ?? null,
  walletTopupId: (r.wallet_topup_id as string | null) ?? null,
  amountMinor: String(r.amount_minor),
  currency: (r.currency as string).trim(),
  status: r.status as IntentStatus,
  paymentMethodId: (r.payment_method_id as string | null) ?? null,
  nextAction: (r.next_action as PaymentDto['nextAction']) ?? null,
  failureCode: (r.failure_code as string | null) ?? null,
  capturedMinor: String(r.captured_minor),
  refundedMinor: String(r.refunded_minor),
  createdAt: (r.created_at as Date).toISOString(),
});

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate' | 'failed';

/**
 * Payments (docs/11 §7). The rules that matter:
 *  - **Reconcile before retry:** an uncertain PSP result (timeout, lost answer) is never retried blindly. Before a new attempt, the
 *    PSP is asked about the merchant reference; a charge that already happened is adopted, not repeated.
 *  - **Terminal states are final:** the intent moves only along the state machine (trigger); an event for a finished intent is ignored.
 *  - **One ledger effect per business event:** capture is finalized in one transaction (state + audit + outbox event), then applied to
 *    the invoice and the ledger with idempotent keys; a crash in between is repaired by `completeCapture`.
 *  - **Webhooks:** signature + replay window first, then a durable insert deduplicated by (psp, event id), then processing.
 */
export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ledger: Pick<LedgerPostingService, 'post'>,
    private readonly psp: PspRegistry,
    private readonly invoices: Pick<InvoiceService, 'get' | 'applyPayment'>,
    private readonly topups: Pick<WalletTopupService, 'get' | 'credit'>,
    private readonly opts: { returnUrlAllowlist: string[] } = {
      returnUrlAllowlist: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    },
  ) {}

  static allowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    return (env.PAYMENT_RETURN_URL_ALLOWLIST ?? 'http://127.0.0.1:3000,http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private returnUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 500)
      throw new ProblemException('validation_failed', 'returnUrl is required');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ProblemException('validation_failed', 'returnUrl must be an absolute URL');
    }
    // open-redirect protection: only origins the platform itself serves may receive the customer back
    if (!this.opts.returnUrlAllowlist.includes(u.origin))
      throw new ProblemException('validation_failed', 'returnUrl is not an allowed origin');
    return u.toString();
  }

  // ---- create / retry ---------------------------------------------------------------------------------------------

  async create(
    orgId: string,
    actorUserId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<{ payment: PaymentDto; httpStatus: 200 | 201 | 202 }> {
    if (containsCardData(input))
      throw new ProblemException(
        'pan_not_allowed',
        'card data is never accepted; pay with a saved payment method',
      );
    if (input.quoteId !== undefined)
      throw new ProblemException(
        'validation_failed',
        'paying a quote is not available yet (M05); pay an invoice with invoiceId or a wallet top-up with walletTopupId',
      );
    if ((input.invoiceId === undefined) === (input.walletTopupId === undefined))
      throw new ProblemException(
        'validation_failed',
        'send exactly one of invoiceId or walletTopupId',
      );
    for (const k of ['invoiceId', 'walletTopupId'] as const)
      if (
        input[k] !== undefined &&
        (typeof input[k] !== 'string' || !UUID.test(input[k] as string))
      )
        throw new ProblemException('validation_failed', `${k} must be a uuid`);
    const returnUrl = this.returnUrl(input.returnUrl);
    if (
      input.amount !== undefined &&
      (typeof input.amount !== 'string' || !MINOR.test(input.amount))
    )
      throw new ProblemException(
        'validation_failed',
        'amount must be a positive integer string (minor units)',
      );
    if (
      input.paymentMethodId !== undefined &&
      (typeof input.paymentMethodId !== 'string' || !UUID.test(input.paymentMethodId))
    )
      throw new ProblemException('validation_failed', 'paymentMethodId must be a uuid');

    // what is being paid: an invoice (partial amounts allowed) or a wallet top-up (always the whole requested amount)
    let target: {
      invoiceId: string | null;
      topupId: string | null;
      amount: bigint;
      currency: string;
    };
    if (typeof input.invoiceId === 'string') {
      const invoice = await this.invoices.get(orgId, input.invoiceId.toLowerCase()); // 404 for a foreign or unknown invoice
      if (invoice.status === 'paid')
        throw new ProblemException('conflict', 'this invoice is already paid');
      if (invoice.status !== 'open' && invoice.status !== 'partially_paid')
        throw new ProblemException('conflict', `a ${invoice.status} invoice cannot be paid`);
      const remaining = BigInt(invoice.totalMinor) - BigInt(invoice.paidMinor);
      const amount = input.amount === undefined ? remaining : BigInt(input.amount as string);
      if (amount > remaining)
        throw new ProblemException(
          'validation_failed',
          `the amount exceeds what is still owed (${remaining.toString()})`,
        );
      target = { invoiceId: invoice.id, topupId: null, amount, currency: invoice.currency };
    } else {
      if (input.amount !== undefined)
        throw new ProblemException('validation_failed', 'a top-up is paid in full; omit amount');
      const topup = await this.topups.get(orgId, (input.walletTopupId as string).toLowerCase());
      if (topup.status === 'credited')
        throw new ProblemException('conflict', 'this top-up is already paid');
      target = {
        invoiceId: null,
        topupId: topup.id,
        amount: BigInt(topup.amountMinor),
        currency: topup.currency,
      };
    }

    // an unfinished payment for this target: reconcile with the PSP FIRST, then hand back whatever is true (never a second charge)
    const open = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM payments.payment_intents WHERE org_id = $1 AND (invoice_id = $2::uuid OR wallet_topup_id = $3::uuid) AND status IN ('requires_action','processing') ORDER BY created_at DESC LIMIT 1`,
            [orgId, target.invoiceId, target.topupId],
          )
        ).rows[0],
    );
    if (open) {
      const settled = await this.reconcile(orgId, open.id as string, now);
      if (isOpenIntent(settled.status) || settled.status === 'succeeded')
        return { payment: settled, httpStatus: settled.status === 'processing' ? 202 : 200 };
      // failed or cancelled: the customer may try again with a new intent below
    }

    const method = await this.method(orgId, input.paymentMethodId as string | undefined);
    const adapter = this.psp.find(method.provider);
    if (!adapter)
      throw new ProblemException('service_unavailable', 'the payment provider is not available');
    const id = uuidv7();
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO payments.payment_intents (id, org_id, psp_account_id, invoice_id, wallet_topup_id, payment_method_id, amount_minor, currency, merchant_reference, return_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          orgId,
          method.psp_account_id,
          target.invoiceId,
          target.topupId,
          method.id,
          target.amount.toString(),
          target.currency,
          `nuzm_pi_${id}`,
          returnUrl,
          actorUserId,
        ],
      );
      await this.audit.record({
        action: 'payments.payment_intent.created',
        actorUserId,
        orgId,
        resource: { type: 'payment_intent', id },
        outcome: 'success',
        after: {
          invoiceId: target.invoiceId,
          walletTopupId: target.topupId,
          amountMinor: target.amount.toString(),
          currency: target.currency,
        },
      });
    });
    return this.attempt(orgId, id, adapter, method, now, 201);
  }

  private async method(orgId: string, id?: string): Promise<Row & { provider: string }> {
    const m = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT m.*, a.provider, cu.psp_customer_ref FROM payments.payment_methods m JOIN payments.psp_accounts a ON a.id = m.psp_account_id
             LEFT JOIN payments.customers_psp cu ON cu.org_id = m.org_id AND cu.psp_account_id = m.psp_account_id
            WHERE m.org_id = $1 AND m.status = 'active' AND (($2::uuid IS NOT NULL AND m.id = $2::uuid) OR ($2::uuid IS NULL AND m.is_default)) LIMIT 1`,
            [orgId, id ?? null],
          )
        ).rows[0],
    );
    if (!m)
      throw new ProblemException(
        id ? 'not_found' : 'payment_method_required',
        id ? 'payment method not found' : 'add a payment method or choose one',
      );
    return m as Row & { provider: string };
  }

  /** One charge attempt for an intent: record what the PSP said (or that we do not know), and move the intent accordingly. */
  private async attempt(
    orgId: string,
    intentId: string,
    adapter: PspAdapter,
    method: Row,
    now: Date,
    created: 200 | 201,
  ): Promise<{ payment: PaymentDto; httpStatus: 200 | 201 | 202 }> {
    const intent = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM payments.payment_intents WHERE id = $1`, [intentId])).rows[0],
    ))!;
    const seq =
      (await this.db.withOrg(orgId, async (c) =>
        Number(
          (
            await c.query(
              `SELECT coalesce(max(seq),0)::int n FROM payments.payment_attempts WHERE intent_id = $1`,
              [intentId],
            )
          ).rows[0]!.n,
        ),
      )) + 1;
    let result: PspPaymentResult | null = null;
    try {
      result = await adapter.createPayment({
        merchantReference: intent.merchant_reference as string,
        idempotencyKey: `${intent.merchant_reference as string}-a${seq}`,
        amountMinor: String(intent.amount_minor),
        currency: (intent.currency as string).trim(),
        token: method.token_ref as string,
        customerRef: (method.psp_customer_ref as string | null) ?? '',
        returnUrl: intent.return_url as string,
      });
    } catch (e) {
      // a timeout (PspTimeoutError), a dropped connection, a 5xx: the charge may or may not exist. Never guess: record "uncertain" and reconcile.
      if (!(e instanceof PspTimeoutError)) result = null;
    }
    await this.db.withOrg(orgId, async (c) => {
      if (!result) {
        await this.record(c, intent, seq, 'uncertain', null, null, { reason: 'no_answer' });
        await c.query(
          `UPDATE payments.payment_intents SET status = 'processing', updated_at = now() WHERE id = $1 AND status IN ('requires_method','requires_action')`,
          [intentId],
        );
        return;
      }
      await this.record(
        c,
        intent,
        seq,
        result.status,
        result.pspPaymentRef,
        result.failureCode ?? null,
        {},
      );
      await this.applyResult(c, intent, result);
    });
    if (result?.status === 'succeeded') await this.completeCapture(orgId, intentId);
    const payment = await this.read(orgId, intentId);
    return { payment, httpStatus: payment.status === 'processing' ? 202 : created };
  }

  private async record(
    c: PoolClient,
    intent: Row,
    seq: number,
    status: string,
    ref: string | null,
    failure: string | null,
    summary: Record<string, unknown>,
  ) {
    await c.query(
      `INSERT INTO payments.payment_attempts (id, intent_id, org_id, seq, status, psp_attempt_ref, failure_code, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv7(), intent.id, intent.org_id, seq, status, ref, failure, JSON.stringify(summary)],
    );
  }

  /** Move the intent per a PSP result (state machine permitting). Success is finalized here; the ledger follows in `completeCapture`. */
  private async applyResult(
    c: PoolClient,
    intent: Row,
    r: PspPaymentResult,
    eventAt: Date | null = null,
  ): Promise<void> {
    const cur = (
      await c.query<{ status: IntentStatus }>(
        `SELECT status FROM payments.payment_intents WHERE id = $1 FOR UPDATE`,
        [intent.id],
      )
    ).rows[0]!.status;
    if (!isOpenIntent(cur)) return; // finished intents are final
    if (r.status === 'succeeded') {
      await c.query(
        `UPDATE payments.payment_intents SET status = 'succeeded', captured_minor = amount_minor, psp_payment_ref = $2, next_action = NULL, failure_code = NULL, last_event_at = coalesce($3, last_event_at), updated_at = now() WHERE id = $1`,
        [intent.id, r.pspPaymentRef, eventAt],
      );
      await enqueue(c, intent.org_id as string, 'payment.succeeded', {
        paymentId: intent.id,
        invoiceId: intent.invoice_id,
        amountMinor: String(intent.amount_minor),
        currency: (intent.currency as string).trim(),
      });
      await this.audit.record({
        action: 'payments.payment_intent.succeeded',
        actorType: 'system',
        orgId: intent.org_id as string,
        resource: { type: 'payment_intent', id: intent.id as string },
        outcome: 'success',
        after: { amountMinor: String(intent.amount_minor) },
      });
    } else if (r.status === 'failed') {
      await c.query(
        `UPDATE payments.payment_intents SET status = 'failed', failure_code = $2, psp_payment_ref = coalesce($3, psp_payment_ref), next_action = NULL, last_event_at = coalesce($4, last_event_at), updated_at = now() WHERE id = $1`,
        [intent.id, r.failureCode ?? 'payment_failed', r.pspPaymentRef, eventAt],
      );
      await enqueue(c, intent.org_id as string, 'payment.failed', {
        paymentId: intent.id,
        invoiceId: intent.invoice_id,
        failureCode: r.failureCode ?? 'payment_failed',
      });
      await this.audit.record({
        action: 'payments.payment_intent.failed',
        actorType: 'system',
        orgId: intent.org_id as string,
        resource: { type: 'payment_intent', id: intent.id as string },
        outcome: 'failure',
        detail: { failureCode: r.failureCode ?? 'payment_failed' },
      });
    } else if (r.status === 'requires_action') {
      await c.query(
        `UPDATE payments.payment_intents SET status = 'requires_action', next_action = $2, psp_payment_ref = coalesce($3, psp_payment_ref), last_event_at = coalesce($4, last_event_at), updated_at = now() WHERE id = $1`,
        [intent.id, JSON.stringify(r.nextAction ?? null), r.pspPaymentRef, eventAt],
      );
    } else if (cur !== 'processing') {
      await c.query(
        `UPDATE payments.payment_intents SET status = 'processing', psp_payment_ref = coalesce($2, psp_payment_ref), last_event_at = coalesce($3, last_event_at), updated_at = now() WHERE id = $1`,
        [intent.id, r.pspPaymentRef, eventAt],
      );
    }
  }

  /** Apply a succeeded payment to its invoice and the ledger. Idempotent end to end; safe to call any number of times. */
  async completeCapture(orgId: string, intentId: string): Promise<void> {
    const intent = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT i.*, a.code AS psp_code FROM payments.payment_intents i JOIN payments.psp_accounts a ON a.id = i.psp_account_id WHERE i.id = $1 AND i.org_id = $2`,
            [intentId, orgId],
          )
        ).rows[0],
    ))!;
    if (!['succeeded', 'partially_refunded', 'refunded'].includes(intent.status as string)) return;
    if (intent.wallet_topup_id !== null) {
      // a top-up payment: the wallet is credited once (ledger key payment:<id>:capture), then the top-up is marked credited
      const r = await this.topups.credit(orgId, intent.wallet_topup_id as string, {
        paymentId: intentId,
        pspAccountCode: intent.psp_code as string,
        amountMinor: String(intent.captured_minor),
        currency: (intent.currency as string).trim(),
      });
      if (intent.ledger_transaction_id === null)
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE payments.payment_intents SET ledger_transaction_id = $2, updated_at = now() WHERE id = $1 AND ledger_transaction_id IS NULL`,
            [intentId, r.transactionId],
          ),
        );
      return;
    }
    const applied = await this.invoices.applyPayment(
      orgId,
      intent.invoice_id as string,
      intentId,
      String(intent.captured_minor),
    );
    if (intent.ledger_transaction_id === null) {
      const built = recipes.paymentCaptured({
        orgId,
        paymentId: intentId,
        invoiceId: intent.invoice_id as string,
        pspAccountCode: intent.psp_code as string,
        currency: (intent.currency as string).trim(),
        amountMinor: String(intent.captured_minor),
        appliedMinor: applied.applied ? String(intent.captured_minor) : '0', // money that cannot be applied is booked as an unapplied customer payment (2500)
      });
      const r = await this.ledger.post(built, `payment:${intentId}:capture`);
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE payments.payment_intents SET ledger_transaction_id = $2, updated_at = now() WHERE id = $1 AND ledger_transaction_id IS NULL`,
          [intentId, r.transactionId],
        ),
      );
    }
  }

  // ---- reconcile ---------------------------------------------------------------------------------------------------

  /**
   * Ask the PSP what is true about an unfinished intent and adopt it. A PSP that has NO record of the reference means the request never
   * arrived: only then is a new attempt allowed (done here, once, with a fresh idempotency key).
   */
  async reconcile(orgId: string, intentId: string, now = new Date()): Promise<PaymentDto> {
    const intent = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT i.*, a.provider FROM payments.payment_intents i JOIN payments.psp_accounts a ON a.id = i.psp_account_id WHERE i.id = $1 AND i.org_id = $2`,
            [intentId, orgId],
          )
        ).rows[0],
    );
    if (!intent) throw new ProblemException('not_found');
    if (!isOpenIntent(intent.status as IntentStatus)) {
      if (intent.status === 'succeeded') await this.completeCapture(orgId, intentId);
      return dto(intent);
    }
    const adapter = this.psp.find(intent.provider as string);
    if (!adapter) return dto(intent);
    let known: PspPaymentResult | null;
    try {
      known = await adapter.retrievePayment(intent.merchant_reference as string);
    } catch {
      return dto(intent); // the PSP cannot be asked right now: change nothing, never retry blindly
    }
    if (known) {
      await this.db.withOrg(orgId, async (c) => {
        const seq =
          Number(
            (
              await c.query(
                `SELECT coalesce(max(seq),0)::int n FROM payments.payment_attempts WHERE intent_id = $1`,
                [intentId],
              )
            ).rows[0]!.n,
          ) + 1;
        await this.record(
          c,
          intent,
          seq,
          known!.status,
          known!.pspPaymentRef,
          known!.failureCode ?? null,
          { via: 'reconcile' },
        );
        await this.applyResult(c, intent, known!);
      });
      if (known.status === 'succeeded') await this.completeCapture(orgId, intentId);
      return this.read(orgId, intentId);
    }
    // the PSP has no record: the earlier request never arrived, a new attempt cannot duplicate anything. Only a payment that already made an
    // attempt (processing) is retried: merely READING a payment must never start a charge.
    if (intent.status === 'processing') {
      const method = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT m.*, cu.psp_customer_ref FROM payments.payment_methods m LEFT JOIN payments.customers_psp cu ON cu.org_id = m.org_id AND cu.psp_account_id = m.psp_account_id WHERE m.id = $1`,
              [intent.payment_method_id],
            )
          ).rows[0],
      );
      if (method) return (await this.attempt(orgId, intentId, adapter, method, now, 200)).payment;
    }
    return dto(intent);
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  private async read(orgId: string, id: string): Promise<PaymentDto> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM payments.payment_intents WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return dto(r);
  }

  /** One payment; an unfinished one is refreshed from the PSP first (the customer returning from 3-D Secure sees the truth even before the webhook). */
  async get(orgId: string, id: string, now = new Date()): Promise<PaymentDto> {
    const p = await this.read(orgId, id);
    return isOpenIntent(p.status) ? this.reconcile(orgId, id, now) : p;
  }

  async list(
    orgId: string,
    o: {
      limit: number;
      cursor?: string | undefined;
      status?: string | undefined;
      invoiceId?: string | undefined;
    },
  ): Promise<Page<PaymentDto>> {
    if (o.status !== undefined && !STATUSES.includes(o.status as IntentStatus))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    if (o.invoiceId !== undefined && !UUID.test(o.invoiceId))
      throw new ProblemException('validation_failed', 'invoice must be a uuid');
    const after = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM payments.payment_intents WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR invoice_id = $3::uuid) AND ($4::uuid IS NULL OR id < $4::uuid) ORDER BY id DESC LIMIT $5`,
          [orgId, o.status ?? null, o.invoiceId ?? null, after, o.limit + 1],
        )
      ).rows;
      const p = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        o.limit,
      );
      return { items: p.items.map((x) => dto(x.r)), nextCursor: p.nextCursor };
    });
  }

  // ---- webhooks ----------------------------------------------------------------------------------------------------

  /**
   * Provider callback. 404 for an unknown provider, 401 for a bad signature or a delivery outside the replay window. A valid event is
   * stored (deduplicated by provider event id) and then processed; the answer is 200 once the event is durable, whatever processing does.
   */
  async handleWebhook(
    provider: string,
    rawBody: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    now = new Date(),
  ): Promise<{ outcome: WebhookOutcome }> {
    const adapter = this.psp.find(provider);
    if (!adapter) throw new ProblemException('not_found');
    if (typeof rawBody !== 'string')
      throw new ProblemException('invalid_signature', 'the raw body is required for verification');
    let ev: WebhookEvent;
    try {
      ev = adapter.parseWebhook(rawBody, headers, now);
    } catch (e) {
      if (e instanceof WebhookRejectedError)
        throw new ProblemException(
          e.reason === 'malformed' ? 'validation_failed' : 'invalid_signature',
          e.message,
        );
      throw e;
    }
    // sanitized payload: a whitelist, never the raw body
    const payload = {
      id: ev.id,
      type: ev.type,
      merchantReference: ev.merchantReference,
      pspPaymentRef: ev.pspPaymentRef,
      amountMinor: ev.amountMinor,
      currency: ev.currency,
      failureCode: ev.failureCode,
    };
    const stored = await this.db.withAuthScope('psp_webhook', async (c) => {
      const row = (
        await c.query<{ id: string; inserted: boolean }>(
          // a redelivery changes nothing but a counter (the admin screen shows it); `xmax = 0` tells a fresh row from an updated one
          `INSERT INTO payments.psp_events (id, psp, event_id, type, event_at, payload) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (psp, event_id) DO UPDATE SET duplicate_count = payments.psp_events.duplicate_count + 1, last_duplicate_at = $7
           RETURNING id, (xmax = 0) AS inserted`,
          [uuidv7(), provider, ev.id, ev.type, ev.createdAt, JSON.stringify(payload), now],
        )
      ).rows[0];
      if (!row || !row.inserted) return null;
      const ref = (
        await c.query<{ id: string; org_id: string }>(
          `SELECT id, org_id FROM payments.resolve_intent($1)`,
          [ev.merchantReference],
        )
      ).rows[0];
      if (ref)
        await c.query(`UPDATE payments.psp_events SET org_id = $2, intent_id = $3 WHERE id = $1`, [
          row.id,
          ref.org_id,
          ref.id,
        ]);
      return { eventId: row.id, ref };
    });
    if (!stored) return { outcome: 'duplicate' };
    return {
      outcome: await this.process(
        stored.eventId,
        ev,
        stored.ref ? { orgId: stored.ref.org_id, intentId: stored.ref.id } : null,
        now,
      ),
    };
  }

  private async process(
    eventRowId: string,
    ev: WebhookEvent,
    ref: { orgId: string; intentId: string } | null,
    now: Date,
  ): Promise<WebhookOutcome> {
    const finish = (status: 'processed' | 'ignored' | 'failed', error: string | null) =>
      this.db.withAuthScope('psp_webhook', (c) =>
        c.query(
          `UPDATE payments.psp_events SET status = $2, error = $3, processed_at = $4 WHERE id = $1`,
          [eventRowId, status, error, now],
        ),
      );
    if (!ref) {
      await finish('ignored', 'unknown_reference');
      return 'ignored';
    }
    try {
      const verdict = await this.db.withOrg(ref.orgId, async (c) => {
        const intent = (
          await c.query(`SELECT * FROM payments.payment_intents WHERE id = $1 FOR UPDATE`, [
            ref.intentId,
          ])
        ).rows[0]!;
        if (ev.amountMinor !== null && ev.amountMinor !== String(intent.amount_minor))
          return { v: 'failed' as const, why: 'amount_mismatch' };
        // out-of-order delivery: an event older than the last one applied changes nothing
        if (
          intent.last_event_at &&
          ev.createdAt.getTime() < (intent.last_event_at as Date).getTime()
        )
          return { v: 'ignored' as const, why: 'stale_event' };
        if (!isOpenIntent(intent.status as IntentStatus)) {
          // a finished intent is final; a "succeeded" for a failed/cancelled one is an anomaly for finance, never an automatic reversal
          return ev.type === 'payment.succeeded' &&
            (intent.status === 'failed' || intent.status === 'cancelled')
            ? { v: 'failed' as const, why: 'succeeded_after_terminal_failure' }
            : { v: 'ignored' as const, why: 'already_final' };
        }
        const res: PspPaymentResult =
          ev.type === 'payment.succeeded'
            ? { status: 'succeeded', pspPaymentRef: ev.pspPaymentRef ?? 'unknown' }
            : ev.type === 'payment.failed'
              ? {
                  status: 'failed',
                  pspPaymentRef: ev.pspPaymentRef ?? 'unknown',
                  failureCode: ev.failureCode ?? 'payment_failed',
                }
              : { status: 'requires_action', pspPaymentRef: ev.pspPaymentRef ?? 'unknown' };
        if (res.status === 'requires_action' && intent.status !== 'requires_method')
          return { v: 'ignored' as const, why: 'already_beyond' };
        await this.applyResult(c, intent, res, ev.createdAt);
        return { v: 'processed' as const, why: null };
      });
      if (verdict.v === 'processed' && ev.type === 'payment.succeeded')
        await this.completeCapture(ref.orgId, ref.intentId);
      await finish(verdict.v, verdict.why);
      return verdict.v;
    } catch (e) {
      await finish('failed', (e as Error).message.slice(0, 200));
      return 'failed';
    }
  }

  /** Re-run events that were stored but not (successfully) processed. Safe to call repeatedly; the worker/sweeper entry point. */
  async processPending(limit = 50, now = new Date()): Promise<number> {
    const rows = await this.db.withAuthScope(
      'psp_webhook',
      async (c) =>
        (
          await c.query<{
            id: string;
            payload: WebhookEventPayload;
            event_at: Date;
            org_id: string | null;
            intent_id: string | null;
          }>(
            `SELECT id, payload, event_at, org_id, intent_id FROM payments.psp_events WHERE status IN ('received','failed') ORDER BY received_at LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    let n = 0;
    for (const r of rows) {
      const ev: WebhookEvent = {
        id: r.payload.id,
        type: r.payload.type,
        createdAt: r.event_at,
        merchantReference: r.payload.merchantReference,
        pspPaymentRef: r.payload.pspPaymentRef,
        amountMinor: r.payload.amountMinor,
        currency: r.payload.currency,
        failureCode: r.payload.failureCode,
      };
      const ref = r.org_id && r.intent_id ? { orgId: r.org_id, intentId: r.intent_id } : null;
      if ((await this.process(r.id, ev, ref, now)) === 'processed') n++;
    }
    return n;
  }
}
interface WebhookEventPayload {
  id: string;
  type: WebhookEvent['type'];
  merchantReference: string;
  pspPaymentRef: string | null;
  amountMinor: string | null;
  currency: string | null;
  failureCode: string | null;
}
