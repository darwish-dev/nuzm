/**
 * Durable operation state machine (docs/02 §3). Pure: no I/O. Persistence and leasing live in
 * apps/api (platform module). `needs_reconcile` means the outcome at the provider is uncertain:
 * the only ways out are reconcile results (succeeded/failed) or a deliberate re-run once the
 * reconciler proved the effect is absent.
 */
export const OPERATION_STATES = [
  'pending',
  'running',
  'waiting_provider',
  'succeeded',
  'failed',
  'cancelled',
  'needs_reconcile',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_STATES: readonly OperationState[] = ['succeeded', 'failed', 'cancelled'];

const TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  pending: ['running', 'cancelled'],
  running: ['pending', 'waiting_provider', 'succeeded', 'failed', 'needs_reconcile', 'cancelled'],
  waiting_provider: ['running', 'succeeded', 'failed', 'needs_reconcile', 'cancelled'],
  needs_reconcile: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: OperationState, to: OperationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OperationState,
    readonly to: OperationState,
  ) {
    super(`illegal operation transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: OperationState, to: OperationState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Cancellation is allowed until the operation is terminal (docs/04: 409 on non-cancellable). */
export function isCancellable(state: OperationState): boolean {
  return !isTerminal(state);
}

export interface RetryPolicy {
  baseSeconds: number;
  maxSeconds: number;
  maxAttempts: number;
}
export const DEFAULT_RETRY: RetryPolicy = { baseSeconds: 5, maxSeconds: 300, maxAttempts: 5 };

/** Exponential backoff without jitter (jitter is added by the caller so this stays testable). */
export function backoffSeconds(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  if (attempt < 1) throw new RangeError('attempt starts at 1');
  return Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** (attempt - 1));
}

export function shouldRetry(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): boolean {
  return attempt < policy.maxAttempts;
}
