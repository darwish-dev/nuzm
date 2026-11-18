/* MIRROR of the common parts of @nuzm/adapter-contracts types.ts (M05 S16, contractVersion 1.0.0; docs/09 §1), copied READ-ONLY on 2026-11-18.
 * Only the types the registrar contract needs are mirrored, names and shapes unchanged, so replacing this file by a re-export of the real package
 * is mechanical (docs/reports/M07-m05-interface-assumptions.md §1). `AdapterBase` differs in ONE place: capabilities are keyed by
 * REGISTRAR capability ids (M05's `CapabilityId` union is compute-only today). */
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

export interface OperationResult<T> {
  /** `uncertain` = a timeout or ambiguous failure: the effect at the provider is UNKNOWN (docs/09 §1 rule 3). */
  status: 'succeeded' | 'accepted' | 'failed' | 'uncertain';
  providerRef?: string;
  data?: T;
  error?: NormalizedError;
  raw: RawEvidence;
}

export interface ProviderCostRecord {
  providerRef: string | null;
  periodStart: string;
  periodEnd: string;
  amountMinor: string;
  currency: string;
  description: string;
}

/** docs/09 §1. M05 types `probe`/`catalog` with compute-shaped reports; here the report and catalog types are parameters so each kind keeps its own capability ids. */
export interface AdapterBase<TReport = unknown, TCatalog = unknown> {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly contractVersion: string;
  probe(ctx: AccountContext): Promise<TReport>;
  health(ctx: AccountContext): Promise<HealthReport>;
  catalog(ctx: AccountContext): Promise<TCatalog>;
}
