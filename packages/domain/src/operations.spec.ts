import { describe, expect, it } from 'vitest';
import {
  OPERATION_STATES,
  IllegalTransitionError,
  assertTransition,
  backoffSeconds,
  canTransition,
  isCancellable,
  isTerminal,
  shouldRetry,
} from './operations';

describe('operation state machine', () => {
  it('terminal states allow no transitions (operation_state_machine_forbidden_transitions)', () => {
    for (const from of OPERATION_STATES.filter(isTerminal)) {
      for (const to of OPERATION_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });
  it('never allows pending to jump to a terminal success/failure', () => {
    expect(canTransition('pending', 'succeeded')).toBe(false);
    expect(canTransition('pending', 'failed')).toBe(false);
    expect(() => assertTransition('pending', 'succeeded')).toThrow(IllegalTransitionError);
  });
  it('supports the provider-timeout path: running -> needs_reconcile -> succeeded/failed', () => {
    expect(canTransition('running', 'needs_reconcile')).toBe(true);
    expect(canTransition('needs_reconcile', 'succeeded')).toBe(true);
    expect(canTransition('needs_reconcile', 'failed')).toBe(true);
  });
  it('a state cannot transition to itself', () => {
    for (const s of OPERATION_STATES) expect(canTransition(s, s)).toBe(false);
  });
  it('cancellation is allowed exactly while not terminal', () => {
    for (const s of OPERATION_STATES) expect(isCancellable(s)).toBe(!isTerminal(s));
  });
  it('backoff doubles and is capped; retries stop at max attempts', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffSeconds(n))).toEqual([
      5, 10, 20, 40, 80, 160, 300, 300,
    ]);
    expect(() => backoffSeconds(0)).toThrow(RangeError);
    expect(shouldRetry(4)).toBe(true);
    expect(shouldRetry(5)).toBe(false);
  });
});
