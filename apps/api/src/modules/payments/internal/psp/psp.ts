/**
 * PSP adapter contract (docs/09 §6, docs/11 §7). Card data NEVER crosses this interface: methods are attached from a token produced by
 * the PSP's hosted fields / redirect, and everything returned is a token, brand, last4, expiry and fingerprint. The contract lives in
 * the payments module until `packages/adapters` is created in M05; adapters register in `PspRegistry`.
 */
export type PspPaymentStatus = 'succeeded' | 'failed' | 'requires_action' | 'processing';
export interface PspPaymentResult {
  status: PspPaymentStatus;
  pspPaymentRef: string;
  failureCode?: string;
  nextAction?: { type: 'redirect'; url: string };
}
export interface PspRefundResult {
  /** `pending`: the PSP accepted the refund but has not finished it; the outcome is learned by asking again. */
  status: 'succeeded' | 'failed' | 'pending';
  pspRefundRef: string;
  failureCode?: string;
}
export interface MethodDetails {
  /** The PSP's token for the stored method (opaque). */
  token: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  fingerprint: string;
}
export type WebhookEventType = 'payment.succeeded' | 'payment.failed' | 'payment.requires_action';
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  /** PSP time of the event: used to ignore stale (out-of-order) deliveries. */
  createdAt: Date;
  merchantReference: string;
  pspPaymentRef: string | null;
  amountMinor: string | null;
  currency: string | null;
  failureCode: string | null;
}

/** The request may or may not have reached the PSP: the result is UNKNOWN. Callers must reconcile before any retry. */
export class PspTimeoutError extends Error {
  constructor(message = 'the PSP did not answer in time') {
    super(message);
    this.name = 'PspTimeoutError';
  }
}
/** Bad signature, malformed payload or a delivery outside the replay window. */
export class WebhookRejectedError extends Error {
  constructor(
    readonly reason: 'bad_signature' | 'replay' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookRejectedError';
  }
}

export interface PspAdapter {
  readonly provider: string;
  readonly environment: 'sandbox' | 'production';
  /** Create the PSP-side customer for an organization (idempotent per org). */
  createCustomer(orgId: string): Promise<{ customerRef: string }>;
  /** Turn a hosted-field/redirect setup token into a stored method. Rejects expired or already-used tokens. */
  attachMethod(customerRef: string, setupToken: string): Promise<MethodDetails>;
  detachMethod(token: string): Promise<void>;
  /** Start a payment. May throw PspTimeoutError (unknown outcome). `idempotencyKey` is per attempt. */
  createPayment(input: {
    merchantReference: string;
    idempotencyKey: string;
    amountMinor: string;
    currency: string;
    token: string;
    customerRef: string;
    returnUrl: string;
  }): Promise<PspPaymentResult>;
  /** What the PSP knows about this merchant reference (null = nothing): the reconcile-before-retry probe. */
  retrievePayment(merchantReference: string): Promise<PspPaymentResult | null>;
  /** Start a refund of a captured payment. May throw PspTimeoutError (unknown outcome). `idempotencyKey` is per refund (not per call). */
  createRefund(input: {
    merchantReference: string;
    paymentMerchantReference: string;
    pspPaymentRef: string;
    idempotencyKey: string;
    amountMinor: string;
    currency: string;
  }): Promise<PspRefundResult>;
  /** What the PSP knows about this refund merchant reference (null = nothing): the reconcile-before-retry probe for refunds. */
  retrieveRefund(merchantReference: string): Promise<PspRefundResult | null>;
  /** Verify the signature over the RAW body and the replay window; returns the parsed event or throws WebhookRejectedError. */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    now?: Date,
  ): WebhookEvent;
}
