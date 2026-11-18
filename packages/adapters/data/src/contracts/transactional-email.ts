import type {
  AccountContext,
  DataAdapterBase,
  OperationResult,
  ProviderCostRecord,
} from '../upstream';
import type { TransactionalEmailCapabilityId } from './capabilities';
import type { RequiredDnsRecord, UsageWindow } from './common';

export interface EmailDomainRef {
  providerRef: string;
  domain: string;
}
export type DomainVerificationState = 'pending' | 'verified' | 'failed';
export interface EmailDomainStatus {
  providerRef: string;
  domain: string;
  state: DomainVerificationState;
  /** The records the provider needs (SPF/DKIM/return-path/ownership); DMARC guidance is added by Nuzm. */
  requiredRecords: RequiredDnsRecord[];
  checkedAt: string;
}
export interface OutboundMessage {
  /** Verified sender identity address of the org (anti-spoofing is enforced BEFORE the adapter is called). */
  from: string;
  to: string[];
  subject: string;
  /** Already sanitized HTML (the template engine, not the adapter, sanitizes). */
  html: string;
  text?: string;
  /** Provider-neutral custom headers; header injection is rejected upstream. */
  headers?: Record<string, string>;
  /** Opaque correlation tags (org hash, message id): never PII. */
  tags: Record<string, string>;
}
export interface SentMessage {
  providerMessageRef: string;
  acceptedAt: string;
}
export type EmailEventType =
  'delivered' | 'bounce_hard' | 'bounce_soft' | 'complaint' | 'rejected' | 'deferred';
/** A webhook payload after signature verification. `providerEventId` is the dedupe key. */
export interface VerifiedEmailEvent {
  providerEventId: string;
  type: EmailEventType;
  providerMessageRef: string | null;
  /** The affected recipient address (the orchestrator hashes it before storing). */
  recipient: string | null;
  occurredAt: string;
  /** Redacted provider payload (no addresses, no content). */
  payload: Record<string, unknown>;
}
export interface ProviderSuppression {
  address: string;
  reason: 'bounce_hard' | 'complaint' | 'manual';
  since: string;
}
export interface EmailUsage {
  accepted: number | null;
  delivered: number | null;
  bounced: number | null;
  complaints: number | null;
}

/** docs/09 §5: `TransactionalEmailAdapter` (D-08; shortlist SES/Postmark/Mailgun, none selected). */
export interface TransactionalEmailAdapter extends DataAdapterBase<
  'transactional-email',
  TransactionalEmailCapabilityId
> {
  /** Register a sending domain; returns the required DNS records declaratively. Idempotent per domain. */
  verifyDomain(
    ctx: AccountContext,
    domain: string,
    idempotencyToken: string,
  ): Promise<OperationResult<EmailDomainStatus>>;
  checkDomain(
    ctx: AccountContext,
    providerRef: string,
  ): Promise<OperationResult<EmailDomainStatus>>;
  /** `idempotencyKey` is the Nuzm message idempotency token: a replay MUST NOT produce a second provider send. */
  send(
    ctx: AccountContext,
    message: OutboundMessage,
    idempotencyKey: string,
  ): Promise<OperationResult<SentMessage>>;
  findByToken(
    ctx: AccountContext,
    idempotencyKey: string,
  ): Promise<OperationResult<SentMessage | null>>;
  /**
   * Signature + replay-window verification of an inbound webhook. Throws `WebhookSignatureError` when the signature is invalid or the timestamp is
   * outside the window. Pure (no I/O): the endpoint stores the verified event durably before answering 2xx.
   */
  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    now: Date,
  ): VerifiedEmailEvent[];
  listSuppressions(
    ctx: AccountContext,
    since?: string,
  ): Promise<OperationResult<ProviderSuppression[]>>;
  addSuppression?(
    ctx: AccountContext,
    address: string,
    reason: ProviderSuppression['reason'],
  ): Promise<OperationResult<void>>;
  removeSuppression?(ctx: AccountContext, address: string): Promise<OperationResult<void>>;
  usage(ctx: AccountContext, window: UsageWindow): Promise<OperationResult<EmailUsage>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}

export class WebhookSignatureError extends Error {
  constructor(
    readonly reason: 'invalid_signature' | 'replay_window' | 'malformed',
    message: string = reason,
  ) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
