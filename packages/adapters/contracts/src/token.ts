import { createHash } from 'node:crypto';

/** Deterministic idempotency token for a mutating provider call: sha256(orgId|operationId|stepId) (docs/09 §1 rule 2). */
export const idempotencyToken = (orgId: string, operationId: string, stepId: string): string =>
  createHash('sha256').update(`${orgId}|${operationId}|${stepId}`).digest('hex');

/** Opaque, non-reversible org tag for provider-side tags (M05 §9: never the org name). */
export const orgTag = (orgId: string): string =>
  createHash('sha256').update(`nuzm-org|${orgId}`).digest('hex').slice(0, 16);
