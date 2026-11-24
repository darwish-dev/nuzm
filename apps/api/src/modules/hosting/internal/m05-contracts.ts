/**
 * LOCAL COPY of the M05 adapter contract types this module needs (owner-directed exception: M06 is built before M05 exists on this base).
 * Names and shapes mirror `packages/adapters/contracts` of branch claude/m05-provider-core-05b775 (S16, contractVersion 1.0.0) and docs/09 §1.
 * When M05 is ported onto this base, delete this file and re-point the imports to `@nuzm/adapters-contracts` (see
 * docs/reports/M06-m05-interface-assumptions.md, assumption A-01). Nothing here asserts what a hosting panel can do.
 */
export const CONTRACT_VERSION = '1.0.0';

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
  /** `vault://…` reference; never a secret. */
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
  /** `uncertain` = timeout / ambiguous failure: the effect on the node is UNKNOWN (docs/09 §1 rule 3). */
  status: 'succeeded' | 'accepted' | 'failed' | 'uncertain';
  providerRef?: string;
  data?: T;
  error?: NormalizedError;
  raw: RawEvidence;
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
export const normalizedError = (
  category: ErrorCategory,
  providerCode: string,
  message: string,
): NormalizedError => ({
  category,
  retryable: ERROR_CATEGORY_RETRYABLE[category],
  providerCode,
  message,
});
export class AdapterTimeoutError extends Error {
  constructor(message = 'node call timed out') {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}
