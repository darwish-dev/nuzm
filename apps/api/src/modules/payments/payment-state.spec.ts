import { describe, expect, it } from 'vitest';
import {
  INTENT_TRANSITIONS,
  canIntentTransition,
  isOpenIntent,
  type IntentStatus,
} from './internal/payment-state';

const ALL: IntentStatus[] = [
  'requires_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
];
const allowed = new Set([
  'requires_method>requires_action',
  'requires_method>processing',
  'requires_method>succeeded',
  'requires_method>failed',
  'requires_method>cancelled',
  'requires_action>processing',
  'requires_action>succeeded',
  'requires_action>failed',
  'requires_action>cancelled',
  'processing>succeeded',
  'processing>failed',
  'succeeded>partially_refunded',
  'succeeded>refunded',
  'partially_refunded>refunded',
]);

describe('payment intent state machine (docs/11 §2)', () => {
  it.each(ALL.flatMap((a) => ALL.map((b) => [a, b] as const)))('%s → %s', (a, b) =>
    expect(canIntentTransition(a, b)).toBe(allowed.has(`${a}>${b}`)),
  );
  it('failed, cancelled and refunded are terminal; a processing payment can only finish', () => {
    for (const s of ['failed', 'cancelled', 'refunded'] as const)
      expect(INTENT_TRANSITIONS[s]).toEqual([]);
    expect(INTENT_TRANSITIONS.processing).toEqual(['succeeded', 'failed']);
  });
  it('only the first three states are open', () =>
    expect(ALL.filter(isOpenIntent)).toEqual(['requires_method', 'requires_action', 'processing']));
});
