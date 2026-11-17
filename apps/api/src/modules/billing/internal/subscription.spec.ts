import { describe, expect, it } from 'vitest';
import { amountOf, planFeeMeter, type SubscriptionItem } from './subscription.service';

const item = (
  unitPriceMinor: string,
  rounding: SubscriptionItem['rounding'] = 'half_up',
): SubscriptionItem => ({
  kind: 'plan_fee',
  planKey: 'starter',
  meterId: 'plan.starter_months',
  unitPriceMinor,
  rounding,
  priceBookVersionId: 'v',
});

describe('subscription amounts', () => {
  it('multiplies the frozen unit price by the quantity exactly, with the item rounding', () => {
    expect(amountOf([item('3000')], 3)).toBe(9000n);
    expect(amountOf([item('2999.5')], 3)).toBe(8999n); // 8998.5 half-up
    expect(amountOf([item('2999.5', 'down')], 3)).toBe(8998n);
    expect(amountOf([item('2999.5', 'up')], 3)).toBe(8999n);
    expect(amountOf([item('0.1')], 7)).toBe(1n); // 0.7 → 1
    expect(amountOf([item('3000'), item('500')], 2)).toBe(7000n);
  });
  it('maps plan keys to their fee meter', () => {
    expect(planFeeMeter('starter')).toBe('plan.starter_months');
    expect(planFeeMeter('pro-plus')).toBe('plan.pro_plus_months');
    expect(planFeeMeter('enterprise_2')).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});
