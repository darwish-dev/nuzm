/**
 * MIRROR of the M05 S16 base contracts (`@nuzm/adapter-contracts`, contractVersion 1.0.0, branch claude/m05-provider-core-05b775).
 * M08 was started before M05 reached the shared base (owner-directed exception, M08 report §A). Everything here is named and shaped like M05's
 * file so that integration is mechanical: delete this file and re-export the same names from `@nuzm/adapter-contracts`.
 * The list of assumed names is in `docs/reports/M08-upstream-interface-assumptions.md`. Nothing here asserts what any vendor can do.
 */
import { createHash } from 'node:crypto';

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

/** Only `live` evidence can ever support a LIVE-VERIFIED label (CLAUDE.md §5). */
export type EvidenceKind = 'live' | 'fixture' | 'mock';

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
  /** `vault://…` reference; the adapter resolves it through the VaultClient. */
  credentialRef: string;
  traceId: string;
  deadlineMs: number;
}

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

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
export const ERROR_CATEGORY_RETRYABLE: Record<ErrorCategory, boolean> = {
  auth: false,
  quota: false,
  capacity: true,
  validation: false,
  not_found: false,
  conflict: false,
  rate_limit: true,
  provider_outage: true,
  unsupported: false,
  unknown: false,
};
export const ERROR_CATEGORIES = Object.keys(ERROR_CATEGORY_RETRYABLE) as ErrorCategory[];
export const normalizedError = (
  category: ErrorCategory,
  providerCode: string,
  message: string,
  retryable: boolean = ERROR_CATEGORY_RETRYABLE[category],
): NormalizedError => ({ category, retryable, providerCode, message });

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

/** M05's `CatalogSnapshot` carries compute plans only; data adapters return their own plan shapes (see `DataPlan`). */
export interface DataCatalogSnapshot<P = DataPlan> {
  takenAt: string;
  regions: ProviderRegion[];
  plans: P[];
  evidence: RawEvidence[];
}
export interface DataPlan {
  planRef: string;
  providerRegionId: string | null;
  /** Free-form, provider-neutral descriptors (vcpu, memoryMb, storageGb, mailboxQuotaMb, ...). */
  attributes: Record<string, number | string | boolean>;
  /** Provider cost, integer minor units (never a float). Absent = no price known = never offered. */
  price?: { amountMinor: string; currency: string; period: 'hour' | 'month' };
  availability: 'available' | 'sold_out' | 'unavailable';
}

export interface DataCapabilityReport<C extends string = string> {
  capabilities: Record<C, CapabilityState>;
  evidence: RawEvidence[];
  probedAt: string;
}

export interface DataAdapterBase<K extends AdapterKind, C extends string> {
  readonly id: string;
  readonly kind: K;
  readonly contractVersion: string;
  probe(ctx: AccountContext): Promise<DataCapabilityReport<C>>;
  health(ctx: AccountContext): Promise<HealthReport>;
  catalog(ctx: AccountContext): Promise<DataCatalogSnapshot>;
}

export interface ProviderCostRecord {
  providerRef: string | null;
  periodStart: string;
  periodEnd: string;
  amountMinor: string;
  currency: string;
  description: string;
}

/** Deterministic idempotency token: sha256(orgId|operationId|stepId) (docs/09 §1 rule 2). */
export const idempotencyToken = (orgId: string, operationId: string, stepId: string): string =>
  createHash('sha256').update(`${orgId}|${operationId}|${stepId}`).digest('hex');
/** Opaque, non-reversible org tag for provider-side tags (never the org name). */
export const orgTag = (orgId: string): string =>
  createHash('sha256').update(`nuzm-org|${orgId}`).digest('hex').slice(0, 16);

export const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]{1,200}$/;
export const isVaultRef = (s: unknown): s is string => typeof s === 'string' && VAULT_REF.test(s);
export interface SecretMaterial {
  ref: string;
  fields: Readonly<Record<string, string>>;
  version: string;
}
export interface VaultClient {
  resolve(ref: string): Promise<SecretMaterial>;
}

/** Raised inside an adapter when the vendor call exceeded the deadline: the outcome at the provider is unknown. */
export class AdapterTimeoutError extends Error {
  constructor(message = 'provider call timed out') {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

/** Minimal slice of M05's `ComputeAdapter` that the `self-operated-*` families need (docs/09 §2). */
export interface ComputeInstanceRefPort {
  providerRef: string;
}
export interface ComputeInstanceStatePort {
  providerRef: string;
  status: 'provisioning' | 'running' | 'stopped' | 'deleting' | 'deleted' | 'error';
  providerRegionId: string;
  planRef: string;
  publicIps: string[];
  privateIps?: string[];
  tags: Record<string, string>;
  observedAt: string;
}
export interface ComputeProvisionRequestPort {
  providerRegionId: string;
  planRef: string;
  imageRef: string;
  name: string;
  diskGb?: number;
  sshPublicKeys: string[];
  tags: Record<string, string>;
  idempotencyToken: string;
}
export interface ComputePort {
  provision(
    ctx: AccountContext,
    req: ComputeProvisionRequestPort,
  ): Promise<OperationResult<ComputeInstanceRefPort>>;
  inspect(ctx: AccountContext, ref: string): Promise<OperationResult<ComputeInstanceStatePort>>;
  findByToken(
    ctx: AccountContext,
    token: string,
  ): Promise<OperationResult<ComputeInstanceRefPort | null>>;
  delete(ctx: AccountContext, ref: string): Promise<OperationResult<void>>;
}

/** The evidence record every mock/fixture adapter emits. */
export const evidence = (
  kind: EvidenceKind,
  at: string,
  operation: string,
  summary: string,
): RawEvidence => ({ kind, capturedAt: at, operation, summary });
