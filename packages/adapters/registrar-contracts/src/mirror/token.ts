/* MIRROR of @nuzm/adapter-contracts (M05 S16, contractVersion 1.0.0) token.ts, copied READ-ONLY on 2026-11-18 so M07 can build before M05 lands.
 * Integration: replace this file by `export * from "@nuzm/adapter-contracts"`-style re-exports (docs/reports/M07-m05-interface-assumptions.md §1). */
import { createHash } from 'node:crypto';

/** Deterministic idempotency token for a mutating provider call: sha256(orgId|operationId|stepId) (docs/09 §1 rule 2). */
export const idempotencyToken = (orgId: string, operationId: string, stepId: string): string =>
  createHash('sha256').update(`${orgId}|${operationId}|${stepId}`).digest('hex');

/** Opaque, non-reversible org tag for provider-side tags (M05 §9: never the org name). */
export const orgTag = (orgId: string): string =>
  createHash('sha256').update(`nuzm-org|${orgId}`).digest('hex').slice(0, 16);
