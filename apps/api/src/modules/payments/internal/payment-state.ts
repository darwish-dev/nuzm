/** Payment intent state machine (docs/11 §2). The database trigger enforces the same table. */
export type IntentStatus =
  | 'requires_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';
export const INTENT_TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  requires_method: ['requires_action', 'processing', 'succeeded', 'failed', 'cancelled'],
  requires_action: ['processing', 'succeeded', 'failed', 'cancelled'],
  processing: ['succeeded', 'failed'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};
export const canIntentTransition = (from: IntentStatus, to: IntentStatus) =>
  INTENT_TRANSITIONS[from].includes(to);
/** Not finished: the PSP may still change it. */
export const isOpenIntent = (s: IntentStatus) =>
  s === 'requires_method' || s === 'requires_action' || s === 'processing';
