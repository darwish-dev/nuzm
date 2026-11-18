/**
 * Canonical resource lifecycle (docs/05 §9, AC-M05-24): `cloud.resources.state` uses ONLY these values. `UNKNOWN` means the outcome at the
 * provider is uncertain; only the reconciler may leave it. Pure: the database trigger (migration 0610) enforces the same table.
 */
export const RESOURCE_STATES = [
  'DRAFT',
  'QUOTED',
  'AWAITING_PAYMENT',
  'PROVISIONING',
  'ACTIVE',
  'FAILED',
  'DELETING',
  'DELETED',
  'UNKNOWN',
] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];
export type TransitionActor = 'orchestrator' | 'reconciler';

export const RESOURCE_TRANSITIONS: Record<ResourceState, readonly ResourceState[]> = {
  DRAFT: ['QUOTED', 'FAILED'],
  QUOTED: ['AWAITING_PAYMENT', 'PROVISIONING', 'FAILED'],
  AWAITING_PAYMENT: ['PROVISIONING', 'FAILED'],
  PROVISIONING: ['ACTIVE', 'FAILED', 'UNKNOWN'],
  ACTIVE: ['DELETING', 'UNKNOWN', 'FAILED'],
  FAILED: ['DELETING', 'DELETED'],
  DELETING: ['DELETED', 'ACTIVE', 'UNKNOWN', 'FAILED'],
  DELETED: [],
  UNKNOWN: ['ACTIVE', 'PROVISIONING', 'FAILED', 'DELETING', 'DELETED'],
};

export const isResourceState = (s: string): s is ResourceState =>
  (RESOURCE_STATES as readonly string[]).includes(s);

export function canTransitionResource(
  from: ResourceState,
  to: ResourceState,
  actor: TransitionActor,
): boolean {
  if (!RESOURCE_TRANSITIONS[from].includes(to)) return false;
  if (from === 'UNKNOWN' && actor !== 'reconciler') return false;
  return true;
}

export class IllegalResourceTransitionError extends Error {
  constructor(
    readonly from: ResourceState,
    readonly to: ResourceState,
    readonly actor: TransitionActor,
  ) {
    super(`illegal resource transition ${from} -> ${to} by ${actor}`);
  }
}
export function assertResourceTransition(
  from: ResourceState,
  to: ResourceState,
  actor: TransitionActor,
): void {
  if (!canTransitionResource(from, to, actor))
    throw new IllegalResourceTransitionError(from, to, actor);
}
