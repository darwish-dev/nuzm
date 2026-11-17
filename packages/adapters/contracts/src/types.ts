/**
 * Provider adapter contracts, contractVersion 1.0.0 (docs/09 §1-§2). These are OUR interfaces: they do not assert what any vendor API
 * can do. An adapter proves its capability set with `probe()`; unprobed capabilities are `unknown` and treated as unsupported.
 */
import type { CapabilityId, CapabilityState, ComputeAction } from './capabilities';

export const CONTRACT_VERSION = '1.0.0';

export type AdapterKind =
  | 'compute'
  | 'hosting'
  | 'registrar'
  | 'database'
  | 'cache'
  | 'object-storage'
  | 'transactional-email'
  | 'mailbox'
  | 'psp'
  | 'einvoice'
  | 'model';

/** Where a piece of evidence came from. Only `live` evidence can ever support a LIVE-VERIFIED label (CLAUDE.md §5). */
export type EvidenceKind = 'live' | 'fixture' | 'mock';

/** Redacted request/response metadata. Never contains secrets (the framework redacts it again before storing). */
export interface RawEvidence {
  kind: EvidenceKind;
  capturedAt: string;
  operation?: string;
  summary: string;
  redactedRequest?: unknown;
  redactedResponse?: unknown;
}

export interface AccountContext {
  providerAccountId: string;
  /** `vault://…` reference; the adapter resolves it through the VaultClient, it never receives the secret from the caller. */
  credentialRef: string;
  traceId: string;
  deadlineMs: number;
}

export interface CapabilityReport {
  capabilities: Record<CapabilityId, CapabilityState>;
  evidence: RawEvidence[];
  probedAt: string;
}

export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export interface HealthReport {
  state: HealthState;
  checkedAt: string;
  latencyMs?: number;
  detail?: string;
  evidence?: RawEvidence[];
}

export type ErrorCategory =
  | 'auth'
  | 'quota'
  | 'capacity'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'provider_outage'
  | 'unsupported'
  | 'unknown';
export interface NormalizedError {
  category: ErrorCategory;
  retryable: boolean;
  providerCode: string;
  message: string;
}

export interface OperationResult<T> {
  /** `uncertain` = a timeout or ambiguous failure: the effect at the provider is UNKNOWN (docs/09 §1 rule 3). */
  status: 'succeeded' | 'accepted' | 'failed' | 'uncertain';
  providerRef?: string;
  data?: T;
  error?: NormalizedError;
  raw: RawEvidence;
}

export interface ProviderRegion {
  providerRegionId: string;
  countryCode: string;
  displayName?: string;
  /** Set only when the region was observed in the account's own region listing (a probe), together with its evidence. */
  verifiedAt: string | null;
  evidence: RawEvidence[];
}
export type PlanAvailability = 'available' | 'sold_out' | 'unavailable';
export interface ProviderPlan {
  planRef: string;
  providerRegionId: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  bandwidth?: string;
  /** Provider cost in integer minor units of `currency` per `period` (never a float). Absent = no price known = never offered. */
  price?: { amountMinor: string; currency: string; period: 'hour' | 'month' };
  availability: PlanAvailability;
}
export interface ProviderImage {
  imageRef: string;
  providerRegionId: string;
  name: string;
  osFamily?: string;
}
export interface CatalogSnapshot {
  takenAt: string;
  regions: ProviderRegion[];
  plans: ProviderPlan[];
  images: ProviderImage[];
  evidence: RawEvidence[];
}

export interface ProvisionRequest {
  providerRegionId: string;
  planRef: string;
  imageRef: string;
  name: string;
  diskGb?: number;
  sshPublicKeys: string[];
  /** Opaque org hash and operation id only: never names or PII (M05 §9). */
  tags: Record<string, string>;
}
export interface ProviderQuote {
  planRef: string;
  providerRegionId: string;
  price: { amountMinor: string; currency: string; period: 'hour' | 'month' } | null;
  derivedFromCatalog: boolean;
}
export interface InstanceRef {
  providerRef: string;
}
export type InstanceStatus =
  'provisioning' | 'running' | 'stopped' | 'deleting' | 'deleted' | 'error';
export interface InstanceState {
  providerRef: string;
  status: InstanceStatus;
  providerRegionId: string;
  planRef: string;
  publicIps: string[];
  tags: Record<string, string>;
  observedAt: string;
}
export interface Metrics {
  window: { from: string; to: string };
  series: { name: string; unit: string; points: { t: string; v: number }[] }[];
}
export interface ProviderCostRecord {
  providerRef: string | null;
  periodStart: string;
  periodEnd: string;
  amountMinor: string;
  currency: string;
  description: string;
}

export interface AdapterBase {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly contractVersion: string;
  probe(ctx: AccountContext): Promise<CapabilityReport>;
  health(ctx: AccountContext): Promise<HealthReport>;
  catalog(ctx: AccountContext): Promise<CatalogSnapshot>;
}

export interface ComputeAdapter extends AdapterBase {
  readonly kind: 'compute';
  listRegions(ctx: AccountContext): Promise<ProviderRegion[]>;
  listPlans(ctx: AccountContext, region: string): Promise<ProviderPlan[]>;
  listImages(ctx: AccountContext, region: string): Promise<ProviderImage[]>;
  quote(ctx: AccountContext, req: ProvisionRequest): Promise<ProviderQuote>;
  /** `idempotencyToken` = sha256(orgId|operationId|stepId). A replay with the same token must never create a second billable resource. */
  provision(
    ctx: AccountContext,
    req: ProvisionRequest & { idempotencyToken: string },
  ): Promise<OperationResult<InstanceRef>>;
  inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceState>>;
  findByToken(ctx: AccountContext, token: string): Promise<OperationResult<InstanceRef | null>>;
  /** Each action is individually capability-gated; an unsupported action is `failed` with category `unsupported`, never a silent no-op. */
  act?(
    ctx: AccountContext,
    ref: string,
    action: ComputeAction,
    params: Record<string, unknown>,
  ): Promise<OperationResult<void>>;
  delete(ctx: AccountContext, ref: string): Promise<OperationResult<void>>;
  metrics?(
    ctx: AccountContext,
    ref: string,
    window: { from: string; to: string },
  ): Promise<OperationResult<Metrics>>;
  fetchBilling?(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]>;
}
