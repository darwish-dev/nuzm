import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PspTimeoutError,
  WebhookRejectedError,
  type MethodDetails,
  type PspAdapter,
  type PspPaymentResult,
  type PspRefundResult,
  type PspSettlement,
  type WebhookEvent,
  type WebhookEventType,
} from './psp';

/**
 * Deterministic sandbox PSP (`psp-mock`). The scenario is chosen by the setup token, like a PSP's test cards:
 *   tok_mock_success, tok_mock_decline, tok_mock_3ds, tok_mock_timeout (the charge SUCCEEDS but the answer is lost),
 *   tok_mock_processing (answers "processing"; the outcome arrives by webhook), tok_mock_expired (attach is refused).
 * It keeps its own state per merchant reference and counts every charge, so tests can prove "0 duplicate charges". It deliberately does
 * NOT deduplicate by idempotency key: a second createPayment for an already charged reference is a second charge, exactly the
 * mistake the service's reconcile-before-retry exists to prevent.
 * Everything here is NOT VERIFIED against any real PSP.
 */
export type MockScenario = 'success' | 'decline' | '3ds' | 'timeout' | 'processing';
interface Stored {
  status: PspPaymentResult['status'];
  pspPaymentRef: string;
  failureCode?: string;
  amountMinor: string;
  currency: string;
  charges: number;
}

export type MockRefundScenario = 'success' | 'fail' | 'pending' | 'timeout';
interface StoredRefund {
  status: PspRefundResult['status'];
  pspRefundRef: string;
  failureCode?: string;
  amountMinor: string;
  paymentMerchantReference: string;
  calls: number;
}

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
export const MOCK_TOLERANCE_SECONDS = 300;

export class MockPsp implements PspAdapter {
  readonly provider = 'mock';
  readonly environment = 'sandbox' as const;
  private readonly payments = new Map<string, Stored>();
  private readonly customers = new Map<string, string>();
  private readonly tokens = new Map<string, MockScenario>();
  private readonly usedSetupTokens = new Set<string>();
  private seq = 0;
  private readonly refunds = new Map<string, StoredRefund>();
  private readonly refundQueue: MockRefundScenario[] = [];
  private readonly settlementLog = new Map<string, PspSettlement>();
  /** Refund calls that moved money for a reference that was already refunded (must stay 0 when the service reconciles first). */
  duplicateRefunds = 0;
  /** Calls that created a charge for a reference that was already charged (must stay 0 when the service reconciles first). */
  duplicateCharges = 0;

  constructor(private readonly secret: string) {}

  async createCustomer(orgId: string) {
    const ref = this.customers.get(orgId) ?? `cus_mock_${orgId.replace(/-/g, '').slice(0, 16)}`;
    this.customers.set(orgId, ref);
    return { customerRef: ref };
  }

  /** Setup tokens are single-use (like a PSP's): the same token twice is refused. The optional suffix names the physical card (the fingerprint). */
  async attachMethod(_customer: string, setupToken: string): Promise<MethodDetails> {
    const m =
      /^tok_mock_(success|decline|3ds|timeout|processing|expired)(?:_([a-z0-9]{1,12}))?$/.exec(
        setupToken,
      );
    if (!m) throw new Error('unknown setup token');
    if (m[1] === 'expired') throw new Error('the setup token has expired');
    if (this.usedSetupTokens.has(setupToken)) throw new Error('the setup token was already used');
    this.usedSetupTokens.add(setupToken);
    const scenario = m[1] as MockScenario;
    const card = (m[2] ?? String(++this.seq)).padStart(4, '0');
    const token = `pm_mock_${scenario}_${String(++this.seq).padStart(6, '0')}`; // a new token per attach
    this.tokens.set(token, scenario);
    return {
      token,
      brand: 'visa',
      last4: scenario === 'decline' ? '0002' : '4242',
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 3,
      fingerprint: `fp_mock_${card}`,
    };
  }

  async detachMethod(token: string): Promise<void> {
    this.tokens.delete(token);
  }

  async createPayment(i: {
    merchantReference: string;
    amountMinor: string;
    currency: string;
    token: string;
  }): Promise<PspPaymentResult> {
    const scenario = this.tokens.get(i.token);
    if (!scenario)
      return { status: 'failed', pspPaymentRef: this.ref(), failureCode: 'invalid_payment_method' };
    const prior = this.payments.get(i.merchantReference);
    const base = { amountMinor: i.amountMinor, currency: i.currency, charges: prior?.charges ?? 0 };
    const result = (
      s: Omit<Stored, 'charges' | 'amountMinor' | 'currency'>,
      charged: boolean,
    ): Stored => {
      if (charged && base.charges > 0) this.duplicateCharges++;
      const stored = { ...s, ...base, charges: base.charges + (charged ? 1 : 0) };
      this.payments.set(i.merchantReference, stored);
      return stored;
    };
    switch (scenario) {
      case 'success': {
        const s = result({ status: 'succeeded', pspPaymentRef: this.ref() }, true);
        this.settle(s.pspPaymentRef, 'charge', i.amountMinor, i.currency);
        return { status: s.status, pspPaymentRef: s.pspPaymentRef };
      }
      case 'decline': {
        const s = result(
          { status: 'failed', pspPaymentRef: this.ref(), failureCode: 'card_declined' },
          false,
        );
        return { status: 'failed', pspPaymentRef: s.pspPaymentRef, failureCode: 'card_declined' };
      }
      case '3ds': {
        const s = result({ status: 'requires_action', pspPaymentRef: this.ref() }, false);
        return {
          status: 'requires_action',
          pspPaymentRef: s.pspPaymentRef,
          nextAction: {
            type: 'redirect',
            url: `https://mock-psp.invalid/3ds/${i.merchantReference}`,
          },
        };
      }
      case 'processing': {
        const s = result({ status: 'processing', pspPaymentRef: this.ref() }, false);
        return { status: 'processing', pspPaymentRef: s.pspPaymentRef };
      }
      case 'timeout': {
        const t = result({ status: 'succeeded', pspPaymentRef: this.ref() }, true); // the money moved; the answer is lost
        this.settle(t.pspPaymentRef, 'charge', i.amountMinor, i.currency);
        throw new PspTimeoutError();
      }
    }
  }

  async retrievePayment(merchantReference: string): Promise<PspPaymentResult | null> {
    const s = this.payments.get(merchantReference);
    if (!s) return null;
    return {
      status: s.status,
      pspPaymentRef: s.pspPaymentRef,
      ...(s.failureCode ? { failureCode: s.failureCode } : {}),
    };
  }

  private settle(ref: string, kind: 'charge' | 'refund', amountMinor: string, currency: string) {
    if (!this.settlementLog.has(ref))
      this.settlementLog.set(ref, { ref, kind, amountMinor, currency, settledAt: new Date() });
  }
  /** The settlement (payout) report: every charge and refund the PSP settled in [from, to). */
  async listSettlements(from: Date, to: Date): Promise<PspSettlement[]> {
    return [...this.settlementLog.values()].filter((s) => s.settledAt >= from && s.settledAt < to);
  }
  /** Tests: make the settlement report disagree with what the platform recorded (RC-01 must notice). */
  dropSettlement(ref: string): void {
    this.settlementLog.delete(ref);
  }
  alterSettlement(ref: string, amountMinor: string): void {
    const s = this.settlementLog.get(ref);
    if (s) this.settlementLog.set(ref, { ...s, amountMinor });
  }
  addSettlement(s: PspSettlement): void {
    this.settlementLog.set(s.ref, s);
  }

  /** Scenario of the NEXT refund call(s), in order (default success): fail, stay pending, or succeed but lose the answer. */
  queueRefund(...scenarios: MockRefundScenario[]): void {
    this.refundQueue.push(...scenarios);
  }

  async createRefund(i: {
    merchantReference: string;
    paymentMerchantReference: string;
    amountMinor: string;
  }): Promise<PspRefundResult> {
    const pay = this.payments.get(i.paymentMerchantReference);
    const scenario = this.refundQueue.shift() ?? 'success';
    const prior = this.refunds.get(i.merchantReference);
    if (prior && prior.status !== 'failed') this.duplicateRefunds++;
    const refundedSoFar = [...this.refunds.values()]
      .filter(
        (r) =>
          r.paymentMerchantReference === i.paymentMerchantReference && r.status === 'succeeded',
      )
      .reduce((s, r) => s + BigInt(r.amountMinor), 0n);
    const put = (status: StoredRefund['status'], failureCode?: string): StoredRefund => {
      const stored: StoredRefund = {
        status,
        pspRefundRef: prior?.pspRefundRef ?? `re_mock_${(++this.seq).toString().padStart(8, '0')}`,
        ...(failureCode ? { failureCode } : {}),
        amountMinor: i.amountMinor,
        paymentMerchantReference: i.paymentMerchantReference,
        calls: (prior?.calls ?? 0) + 1,
      };
      this.refunds.set(i.merchantReference, stored);
      return stored;
    };
    // the PSP itself refuses to refund more than it captured
    if (
      !pay ||
      pay.status !== 'succeeded' ||
      refundedSoFar + BigInt(i.amountMinor) > BigInt(pay.amountMinor)
    ) {
      const s = put('failed', 'amount_exceeds_balance');
      return {
        status: 'failed',
        pspRefundRef: s.pspRefundRef,
        failureCode: 'amount_exceeds_balance',
      };
    }
    switch (scenario) {
      case 'fail': {
        const s = put('failed', 'refund_declined');
        return { status: 'failed', pspRefundRef: s.pspRefundRef, failureCode: 'refund_declined' };
      }
      case 'pending': {
        const s = put('pending');
        return { status: 'pending', pspRefundRef: s.pspRefundRef };
      }
      case 'timeout': {
        const t = put('succeeded'); // the money moved; the answer is lost
        this.settle(t.pspRefundRef, 'refund', i.amountMinor, pay.currency);
        throw new PspTimeoutError();
      }
      default: {
        const s = put('succeeded');
        this.settle(s.pspRefundRef, 'refund', i.amountMinor, pay.currency);
        return { status: 'succeeded', pspRefundRef: s.pspRefundRef };
      }
    }
  }

  async retrieveRefund(merchantReference: string): Promise<PspRefundResult | null> {
    const r = this.refunds.get(merchantReference);
    if (!r) return null;
    return {
      status: r.status,
      pspRefundRef: r.pspRefundRef,
      ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    };
  }

  /** The PSP finishes a pending refund (tests): the service learns it by asking again. */
  finishRefund(merchantReference: string, outcome: 'succeeded' | 'failed' = 'succeeded'): void {
    const r = this.refunds.get(merchantReference);
    if (!r) throw new Error('no such refund at the PSP');
    r.status = outcome;
    if (outcome === 'failed') r.failureCode = 'refund_declined';
    else
      this.settle(
        r.pspRefundRef,
        'refund',
        r.amountMinor,
        this.payments.get(r.paymentMerchantReference)?.currency ?? 'SAR',
      );
  }

  /** Total the PSP actually refunded for a payment reference (tests assert it equals the sum of succeeded refunds, once each). */
  refundedTotal(paymentMerchantReference: string): bigint {
    return [...this.refunds.values()]
      .filter(
        (r) => r.paymentMerchantReference === paymentMerchantReference && r.status === 'succeeded',
      )
      .reduce((s, r) => s + BigInt(r.amountMinor), 0n);
  }

  /** Number of charges the PSP made for a reference (tests assert it is exactly 1 after a timeout + reconcile). */
  chargeCount(merchantReference: string): number {
    return this.payments.get(merchantReference)?.charges ?? 0;
  }

  /** Simulate the customer finishing 3-D Secure / the PSP finishing a processing payment: returns the signed webhook to deliver. */
  complete(
    merchantReference: string,
    outcome: 'succeeded' | 'failed' = 'succeeded',
    now = new Date(),
  ): { rawBody: string; headers: Record<string, string> } {
    const s = this.payments.get(merchantReference);
    if (!s) throw new Error('no such payment at the PSP');
    if (outcome === 'succeeded' && s.status !== 'succeeded') {
      s.status = 'succeeded';
      s.charges += 1;
      this.settle(s.pspPaymentRef, 'charge', s.amountMinor, s.currency);
    }
    if (outcome === 'failed') {
      s.status = 'failed';
      s.failureCode = 'authentication_failed';
    }
    return this.signedEvent(
      outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      merchantReference,
      now,
    );
  }

  /** Build and sign an arbitrary event (tests: duplicates, out-of-order, forged signatures). */
  signedEvent(
    type: WebhookEventType,
    merchantReference: string,
    now = new Date(),
    over: {
      id?: string;
      createdAt?: Date;
      amountMinor?: string | null;
      failureCode?: string | null;
      signAt?: Date;
    } = {},
  ): { rawBody: string; headers: Record<string, string> } {
    const s = this.payments.get(merchantReference);
    const event = {
      id: over.id ?? `evt_mock_${++this.seq}`,
      type,
      created: Math.floor((over.createdAt ?? now).getTime() / 1000),
      data: {
        merchantReference,
        pspPaymentRef: s?.pspPaymentRef ?? null,
        amountMinor: over.amountMinor === undefined ? (s?.amountMinor ?? null) : over.amountMinor,
        currency: s?.currency ?? 'SAR',
        failureCode: over.failureCode === undefined ? (s?.failureCode ?? null) : over.failureCode,
      },
    };
    const rawBody = JSON.stringify(event);
    return {
      rawBody,
      headers: {
        [MOCK_SIGNATURE_HEADER]: this.sign(rawBody, over.signAt ?? now),
        'content-type': 'application/json',
      },
    };
  }

  sign(rawBody: string, at: Date): string {
    const t = Math.floor(at.getTime() / 1000);
    return `t=${t},v1=${createHmac('sha256', this.secret).update(`${t}.${rawBody}`).digest('hex')}`;
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    now = new Date(),
  ): WebhookEvent {
    const h = headers[MOCK_SIGNATURE_HEADER];
    const sig = Array.isArray(h) ? h[0] : h;
    const m = sig ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(sig) : null;
    if (!m) throw new WebhookRejectedError('bad_signature', 'missing or malformed signature');
    const expected = createHmac('sha256', this.secret).update(`${m[1]}.${rawBody}`).digest();
    const given = Buffer.from(m[2]!, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new WebhookRejectedError('bad_signature', 'signature mismatch');
    if (Math.abs(now.getTime() / 1000 - Number(m[1])) > MOCK_TOLERANCE_SECONDS)
      throw new WebhookRejectedError('replay', 'the delivery is outside the replay window');
    let e: { id?: unknown; type?: unknown; created?: unknown; data?: Record<string, unknown> };
    try {
      e = JSON.parse(rawBody);
    } catch {
      throw new WebhookRejectedError('malformed', 'the body is not JSON');
    }
    const d = e.data ?? {};
    if (
      typeof e.id !== 'string' ||
      !/^evt_[A-Za-z0-9_-]{3,100}$/.test(e.id) ||
      !['payment.succeeded', 'payment.failed', 'payment.requires_action'].includes(
        String(e.type),
      ) ||
      typeof e.created !== 'number' ||
      typeof d.merchantReference !== 'string'
    )
      throw new WebhookRejectedError('malformed', 'unexpected event shape');
    return {
      id: e.id,
      type: e.type as WebhookEventType,
      createdAt: new Date(e.created * 1000),
      merchantReference: d.merchantReference,
      pspPaymentRef: typeof d.pspPaymentRef === 'string' ? d.pspPaymentRef : null,
      amountMinor: typeof d.amountMinor === 'string' ? d.amountMinor : null,
      currency: typeof d.currency === 'string' ? d.currency : null,
      failureCode: typeof d.failureCode === 'string' ? d.failureCode : null,
    };
  }

  private ref() {
    return `pay_mock_${(++this.seq).toString().padStart(8, '0')}`;
  }
}
