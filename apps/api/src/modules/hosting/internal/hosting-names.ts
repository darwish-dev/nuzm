import { createHash } from 'node:crypto';

/** `s-` + 20 hex of the idempotency token: the on-node site name (the hosting account) IS the reconcile key (findByToken). */
export const siteNameFor = (idempotencyToken: string): string => `s-${idempotencyToken.slice(0, 20)}`;
/** The deterministic token of one step of one operation. */
export const tokenFor = (orgId: string, operationId: string, stepId: string): string =>
  createHash('sha256').update(`${orgId}|${operationId}|${stepId}`).digest('hex');
