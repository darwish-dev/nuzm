/**
 * RegistrarAdapter contract (docs/09 §4), contractVersion 1.0.0. These are OUR interfaces: they do not assert what any vendor API can do.
 * Money is integer minor units as strings (never floats). Personal data (contacts) only ever travels IN a request; it is never part of the
 * evidence (`RawEvidence`) an adapter returns.
 */
import type {
  AccountContext,
  AdapterBase,
  CapabilityState,
  EvidenceKind,
  OperationResult,
  ProviderCostRecord,
  RawEvidence,
} from './mirror/base';
import type { RegistrarCapabilityId } from './capabilities';

export interface RegistrarCapabilityReport {
  capabilities: Record<RegistrarCapabilityId, CapabilityState>;
  evidence: RawEvidence[];
  probedAt: string;
}

export interface Money {
  amountMinor: string;
  currency: string;
}

/** What one TLD supports at one registrar account (a probe result; absent TLD = unsupported). */
export interface TldSupport {
  /** lower-case, no leading dot, punycode for IDN TLDs: `com`, `co.uk`. */
  tld: string;
  register: CapabilityState;
  transfer: CapabilityState;
  renew: CapabilityState;
  dns: CapabilityState;
  privacy: CapabilityState;
  dnssec: CapabilityState;
  /** `none` = the vendor says there are no extra rules; `registry` = the registry has eligibility rules (see `eligibility()`); `unknown` = not stated. */
  eligibilityRules: 'none' | 'registry' | 'unknown';
  /** A TLD flagged restricted by the vendor/registry (local presence, nexus, sponsor). The platform never treats `restricted` as sellable without policy. */
  restricted: boolean;
  minYears: number;
  maxYears: number;
  /** Contact fields beyond the base set that the registry requires (`org`, `idNumber`, …), as documented by the vendor. */
  requiredContactFields: string[];
  /** Reseller COST per year in the vendor's account currency, when the vendor's catalogue states it; null = no price known (never offered). */
  prices?: { register: Money | null; renew: Money | null; transfer: Money | null };
}

export interface AvailabilityResult {
  name: string;
  tld: string;
  /** `unknown` when the registry did not answer: never shown as available. */
  available: boolean | 'unknown';
  premium: boolean;
  /** Registration price for ONE year at the reseller's cost; null = no price known = not offered. */
  registerPrice: Money | null;
  renewPrice: Money | null;
  transferPrice: Money | null;
  cacheTtlSeconds: number;
  observedAt: string;
}

export const CONTACT_ROLES = ['registrant', 'admin', 'tech', 'billing'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];
/** PERSONAL data (classification `personal`). Never logged, never in evidence. */
export interface ContactPayload {
  firstName: string;
  lastName: string;
  organization?: string;
  email: string;
  /** E.164, e.g. +966500000000 */
  phone: string;
  address: { street: string; city: string; state?: string; postalCode: string; country: string };
  /** TLD-specific extra fields (`requiredContactFields`). */
  extra?: Record<string, string>;
}
export type ContactSet = Record<ContactRole, ContactPayload>;

export type ProviderDomainState =
  'pending' | 'active' | 'expired' | 'redemption' | 'transferring' | 'failed' | 'unknown';
export interface DomainRef {
  providerRef: string;
  name: string;
  state: ProviderDomainState;
  expiresAt: string | null;
  nameservers: string[];
  locked: boolean | null;
  autoRenew: boolean | null;
  privacy: 'on' | 'off' | 'unsupported' | null;
}

export interface RegisterRequest {
  name: string;
  years: number;
  contacts: ContactSet;
  nameservers?: string[];
  privacy: boolean;
  autoRenew: boolean;
  /** sha256(orgId|operationId|stepId). A replay with the same token must never create a second registration. */
  idempotencyToken: string;
}
export interface RenewRequest {
  name: string;
  providerRef: string;
  years: number;
  /** The current expiry the order was placed against; an adapter refuses a mismatching renewal (double-renew guard). */
  currentExpiresAt: string | null;
  idempotencyToken: string;
}
export interface TransferInRequest {
  name: string;
  /** `vault://…` reference to the transfer authorization code. The adapter resolves it; the code is never returned or logged. */
  authCodeRef: string;
  contacts: ContactSet;
  nameservers?: string[];
  privacy: boolean;
  idempotencyToken: string;
}

/** One record of a zone as the registrar's DNS hosting presents it. `name` is relative to the zone apex (`@` = apex). */
export interface DnsRecordData {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA' | 'NS';
  ttl: number;
  /** type-specific value: A/AAAA/CNAME/NS/TXT = string; MX = {priority, host}; SRV = {priority,weight,port,target}; CAA = {flags,tag,value}. */
  value: unknown;
}
export interface DnsZoneState {
  zone: string;
  providerZoneRef: string;
  records: DnsRecordData[];
  observedAt: string;
}
export type DnsChange =
  | { op: 'create'; record: DnsRecordData }
  | { op: 'update'; match: { name: string; type: DnsRecordData['type'] }; record: DnsRecordData }
  | { op: 'delete'; match: { name: string; type: DnsRecordData['type'] } };
export interface DnsChangeResult {
  index: number;
  status: 'applied' | 'failed' | 'skipped';
  error?: string;
}
export interface DnsChangeSetOutcome {
  /** `applied` = every change took effect; `partial` = some did and the rest did not (the orchestrator snapshots/rolls back). */
  outcome: 'applied' | 'rejected' | 'partial';
  results: DnsChangeResult[];
}
export interface AuthCodeStore {
  put(code: string, label: string): Promise<string>;
}
export interface DnsCapability {
  /** True only when the vendor documents all-or-nothing change application. Otherwise the orchestrator snapshots, applies, verifies and rolls back. */
  readonly atomicChangeSet: boolean;
  createZone(ctx: AccountContext, zone: string): Promise<OperationResult<DnsZoneState>>;
  listZone(ctx: AccountContext, zone: string): Promise<OperationResult<DnsZoneState>>;
  applyChangeSet(
    ctx: AccountContext,
    zone: string,
    changes: DnsChange[],
  ): Promise<OperationResult<DnsChangeSetOutcome>>;
}

export type EligibilityState = 'allowed' | 'blocked' | 'needs_info';
export interface EligibilityResult {
  state: EligibilityState;
  rule: string;
  reason: string;
  evidence: Record<string, unknown>;
}

export type VerifiedEventKind =
  | 'domain.registered'
  | 'domain.renewed'
  | 'domain.transfer_completed'
  | 'domain.transfer_failed'
  | 'domain.expired'
  | 'domain.deleted'
  | 'unknown';
export interface VerifiedEvent {
  /** The provider's own event id: the dedupe key (platform.webhook_events_inbound unique(provider,event_id)). */
  eventId: string;
  kind: VerifiedEventKind;
  /** The vendor's own type string, kept for audit (never executed). */
  rawType: string;
  occurredAt: string;
  domainName: string | null;
  providerRef: string | null;
}
export class WebhookRejectedError extends Error {
  constructor(
    readonly reason: 'bad_signature' | 'replay' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookRejectedError';
  }
}

export interface TldCatalogSnapshot {
  takenAt: string;
  tlds: TldSupport[];
  evidence: RawEvidence[];
}

export interface RegistrarAdapter extends AdapterBase<
  RegistrarCapabilityReport,
  TldCatalogSnapshot
> {
  readonly kind: 'registrar';
  /** Free-form, stable provider code used in URLs and tables: `openprovider`, `resellerclub`. */
  readonly providerCode: string;
  probe(ctx: AccountContext): Promise<RegistrarCapabilityReport>;
  supportedTlds(ctx: AccountContext): Promise<TldSupport[]>;
  search(ctx: AccountContext, names: string[], tlds: string[]): Promise<AvailabilityResult[]>;
  register(ctx: AccountContext, req: RegisterRequest): Promise<OperationResult<DomainRef>>;
  transferIn(ctx: AccountContext, req: TransferInRequest): Promise<OperationResult<DomainRef>>;
  renew(ctx: AccountContext, req: RenewRequest): Promise<OperationResult<DomainRef>>;
  inspect(ctx: AccountContext, name: string): Promise<OperationResult<DomainRef | null>>;
  setContacts(
    ctx: AccountContext,
    name: string,
    contacts: ContactSet,
  ): Promise<OperationResult<DomainRef>>;
  setNameservers(
    ctx: AccountContext,
    name: string,
    nameservers: string[],
  ): Promise<OperationResult<DomainRef>>;
  setLock(ctx: AccountContext, name: string, locked: boolean): Promise<OperationResult<DomainRef>>;
  setAutoRenew(
    ctx: AccountContext,
    name: string,
    autoRenew: boolean,
  ): Promise<OperationResult<DomainRef>>;
  /** Fetches the transfer auth code and hands it to `store`, which writes it to the vault and returns a `vault://` reference. The code is never returned or logged. */
  authCode?(
    ctx: AccountContext,
    name: string,
    store: AuthCodeStore,
  ): Promise<OperationResult<{ authCodeRef: string }>>;
  dns?: DnsCapability;
  /**
   * Looks a registration up by its idempotency token. When the vendor has no client token this is a DOCUMENTED lookup (domain name + the order
   * reference/comment the adapter attached at registration time): the adapter stores the token as the vendor-side order comment/reference and
   * `findByToken` searches for it. `data: null` with `status:'succeeded'` means PROVABLY ABSENT; anything unclear is `uncertain`/`failed`.
   */
  findByToken(
    ctx: AccountContext,
    token: string,
    hint: { name: string },
  ): Promise<OperationResult<DomainRef | null>>;
  eligibility?(
    ctx: AccountContext,
    tld: string,
    registrant: ContactPayload,
  ): Promise<EligibilityResult>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
  /** Verifies the signature over the RAW body and the replay window; throws `WebhookRejectedError`. `secret` is resolved by the caller from the vault. */
  parseWebhook?(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    opts: { secret: string; now: Date; toleranceMs: number },
  ): VerifiedEvent;
}

export const evidenceKindOf = (k: EvidenceKind): EvidenceKind => k;
