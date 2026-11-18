import { describe, expect, it } from 'vitest';
import { ProblemException } from '../../../common/errors';
import { mulRoundHalfUp, retailAmount, ruleAt, validateRules, type StoredRule } from './pricing';

const now = new Date('2026-11-18T00:00:00Z');
const later = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ProblemException ? e.code : 'other';
  }
  return 'none';
};

describe('reseller price rules', () => {
  it('computes retail exactly (integer arithmetic only)', () => {
    expect(retailAmount(10_000n, '1', { type: 'percent', bps: 1500 })).toBe(11_500n);
    expect(retailAmount(333n, '1', { type: 'percent', bps: 1500 })).toBe(333n + 49n); // floor(333 × 0.15) = 49
    expect(
      retailAmount(10_000n, '2.5', { type: 'fixed', amountMinor: '10', currency: 'SAR' }),
    ).toBe(10_025n);
    expect(retailAmount(10_000n, '1', null)).toBe(10_000n);
    expect(retailAmount(0n, '5', { type: 'percent', bps: 9999 })).toBe(0n);
    expect(mulRoundHalfUp(3n, '0.5')).toBe(2n); // 1.5 → 2
    expect(mulRoundHalfUp(1n, '0.49999999')).toBe(0n);
    expect(mulRoundHalfUp(7n, '1000000.12345678')).toBe(7_000_001n); // 7000000.86… rounds to 7000001
  });
  it('never yields retail below wholesale', () => {
    for (const w of [0n, 1n, 17n, 999_999n, 10n ** 12n])
      for (const bps of [0, 1, 1500, 99_999])
        expect(retailAmount(w, '3.3', { type: 'percent', bps }) >= w).toBe(true);
  });
  it('rejects below-cost (negative) markups with below_cost, and other bad input with validation_failed', () => {
    const ok = {
      scope: 'meter',
      scopeKey: 'compute.vcpu_hours',
      markup: { type: 'percent', bps: 1000 },
      effectiveFrom: later(2),
    };
    expect(validateRules([ok], now, 'SAR')).toHaveLength(1);
    expect(
      code(() => validateRules([{ ...ok, markup: { type: 'percent', bps: -1 } }], now, 'SAR')),
    ).toBe('below_cost');
    expect(
      code(() =>
        validateRules(
          [{ ...ok, markup: { type: 'fixed', amountMinor: '-5', currency: 'SAR' } }],
          now,
          'SAR',
        ),
      ),
    ).toBe('below_cost');
    for (const bad of [
      { ...ok, effectiveFrom: later(0) },
      { ...ok, effectiveFrom: 'tomorrow' },
      { ...ok, scope: 'region' },
      { ...ok, scopeKey: 'UPPER' },
      { ...ok, markup: { type: 'percent', bps: 1.5 } },
      { ...ok, markup: { type: 'percent', bps: 100_001 } },
      { ...ok, markup: { type: 'fixed', amountMinor: '5', currency: 'USD' } },
      { ...ok, markup: { type: 'discount' } },
      { ...ok, markup: undefined },
    ])
      expect(
        code(() => validateRules([bad], now, 'SAR')),
        JSON.stringify(bad),
      ).toBe('validation_failed');
    expect(code(() => validateRules([ok, ok], now, 'SAR'))).toBe('validation_failed');
    expect(code(() => validateRules([], now, 'SAR'))).toBe('validation_failed');
    expect(code(() => validateRules('x', now, 'SAR'))).toBe('validation_failed');
    expect(code(() => validateRules([{ ...ok, effectiveFrom: later(1) }], now, 'SAR'))).toBe(
      'none',
    ); // exactly one day: allowed
  });
  it('effective dating and versioning: the newest rule set whose date has passed wins; a meter rule beats a plan rule', () => {
    const r = (
      scope: 'plan' | 'meter',
      key: string,
      bps: number,
      from: string,
      v: number,
    ): StoredRule => ({
      scope,
      scopeKey: key,
      markup: { type: 'percent', bps },
      effectiveFrom: new Date(from),
      ruleSetVersion: v,
    });
    const rules = [
      r('meter', 'm', 1000, '2026-01-01T00:00:00Z', 1),
      r('meter', 'm', 2000, '2026-12-01T00:00:00Z', 2),
      r('plan', 'p', 500, '2026-01-01T00:00:00Z', 1),
    ];
    const at = (s: string) => ruleAt(rules, { meterId: 'm', planKey: 'p' }, new Date(s));
    expect((at('2026-11-30T23:59:59Z')!.markup as { bps: number }).bps).toBe(1000);
    expect((at('2026-12-01T00:00:00Z')!.markup as { bps: number }).bps).toBe(2000);
    expect(at('2025-01-01T00:00:00Z')).toBeNull();
    expect(
      (
        ruleAt(rules, { meterId: 'other', planKey: 'p' }, new Date('2026-11-18T00:00:00Z'))!
          .markup as { bps: number }
      ).bps,
    ).toBe(500);
    expect(ruleAt(rules, { meterId: 'other' }, new Date('2026-11-18T00:00:00Z'))).toBeNull();
  });
});
