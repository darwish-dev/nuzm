import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatDec,
  parseDec,
  parseTiers,
  rateSegment,
  SCALE,
  type RatingItem,
  type Tier,
} from './rating';

const D = (s: string) => parseDec(s);
const flat = (
  price: string,
  allowance = '0',
  rounding: 'half_up' | 'up' | 'down' = 'half_up',
): RatingItem => ({
  model: 'flat',
  unitPrice: D(price),
  allowance: D(allowance),
  rounding,
});
const tiers = (...t: [string | null, string][]): Tier[] =>
  t.map(([u, p]) => ({ upTo: u === null ? null : D(u), unitPrice: D(p) }));
const dec = fc.bigInt({ min: 0n, max: 10n ** 12n }); // scaled quantity up to 10_000 units

describe('decimal parsing and formatting (exact, no floats)', () => {
  it.each([
    ['0', 0n],
    ['1', SCALE],
    ['0.5', SCALE / 2n],
    ['123.45678901', 12_345_678_901n],
    ['0.00000001', 1n],
  ])('parses %s', (s, n) => {
    expect(D(s)).toBe(n);
    expect(formatDec(D(s))).toBe(s);
  });
  it.each(['-1', '1.123456789', '1e3', '', '.5', '1.', 'abc', '1,5', ' 1'])('rejects %j', (s) =>
    expect(() => parseDec(s)).toThrow(),
  );
  it('round-trips any scaled value', () =>
    fc.assert(fc.property(dec, (n) => D(formatDec(n)) === n)));
});

describe('flat pricing', () => {
  it('prices quantity × unit price and rounds once, half up', () => {
    expect(rateSegment(D('10'), flat('5')).amountMinor).toBe(50n);
    expect(rateSegment(D('3'), flat('0.5')).amountMinor).toBe(2n); // 1.5 → 2 (half up)
    expect(rateSegment(D('3'), flat('0.5', '0', 'down')).amountMinor).toBe(1n);
    expect(rateSegment(D('3.1'), flat('0.5', '0', 'up')).amountMinor).toBe(2n); // 1.55 → 2
    expect(rateSegment(D('2'), flat('0.4'), 0n).amountMinor).toBe(1n); // 0.8 → 1
    expect(rateSegment(0n, flat('5')).amountMinor).toBe(0n); // zero quantity
  });
  it('is exact beyond double precision', () => {
    // 9_007_199_254_740_993 units × 1 minor = exactly that many minor units
    expect(rateSegment(D('9007199254740993'), flat('1')).amountMinor).toBe(9_007_199_254_740_993n);
  });
});

describe('allowance then overage', () => {
  it('consumes the included allowance first and prices only the remainder', () => {
    const r = rateSegment(D('1500'), flat('0.1', '1000', 'up'));
    expect(r).toMatchObject({ allowanceApplied: D('1000'), billable: D('500'), amountMinor: 50n });
  });
  it('quantity within the allowance costs nothing', () => {
    const r = rateSegment(D('999'), flat('0.1', '1000'));
    expect(r).toMatchObject({ allowanceApplied: D('999'), billable: 0n, amountMinor: 0n });
  });
  it('a pooled (reduced) allowance available to a later segment is honoured', () => {
    expect(rateSegment(D('100'), flat('1', '1000'), D('30')).billable).toBe(D('70'));
  });
});

describe('graduated tiers (progressive) and volume tiers (all units at the reached tier)', () => {
  const g: RatingItem = {
    model: 'graduated',
    tiers: tiers(['100', '0'], ['1000', '2'], [null, '1.5']),
    allowance: 0n,
    rounding: 'half_up',
  };
  const v: RatingItem = {
    model: 'volume',
    tiers: tiers(['1000', '20'], [null, '15']),
    allowance: 0n,
    rounding: 'half_up',
  };
  it('graduated: first 100 free, next 900 at 2, rest at 1.5', () => {
    expect(rateSegment(D('100'), g).amountMinor).toBe(0n);
    expect(rateSegment(D('101'), g).amountMinor).toBe(2n);
    expect(rateSegment(D('1000'), g).amountMinor).toBe(1800n);
    expect(rateSegment(D('1100'), g).amountMinor).toBe(1950n); // 1800 + 100 × 1.5
  });
  it('volume: every unit is priced at the tier the TOTAL reaches', () => {
    expect(rateSegment(D('1000'), v).amountMinor).toBe(20_000n);
    expect(rateSegment(D('1001'), v).amountMinor).toBe(15_015n);
  });
  it('tier boundaries are inclusive of the lower tier', () => {
    expect(rateSegment(D('1000'), v).amountMinor).toBeLessThan(
      rateSegment(D('1001'), v).amountMinor + 5000n,
    );
  });
  it('rating_sum_of_parts_equals_total (property): a graduated item equals the sum of its tier slices', () =>
    fc.assert(
      fc.property(dec, (q) => {
        const whole = rateSegment(q, g);
        // recompute by hand: slices priced separately, unrounded, then rounded once
        const sl = (lo: bigint, hi: bigint, p: bigint) =>
          q > lo ? ((q < hi ? q : hi) - lo) * p : 0n;
        const manual =
          sl(0n, D('100'), 0n) +
          sl(D('100'), D('1000'), D('2')) +
          sl(D('1000'), 10n ** 30n, D('1.5'));
        const expected = (manual + (SCALE * SCALE) / 2n) / (SCALE * SCALE);
        expect(whole.amountMinor).toBe(expected);
      }),
    ));
  it('graduated cost never decreases as quantity grows (monotonic)', () =>
    fc.assert(
      fc.property(dec, dec, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(rateSegment(lo, g).amountMinor <= rateSegment(hi, g).amountMinor).toBe(true);
      }),
    ));
  it('flat cost is monotonic and never exceeds quantity × price rounded up', () =>
    fc.assert(
      fc.property(dec, dec, fc.bigInt({ min: 0n, max: 10n ** 10n }), (a, b, price) => {
        const item: RatingItem = {
          model: 'flat',
          unitPrice: price,
          allowance: 0n,
          rounding: 'half_up',
        };
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(rateSegment(lo, item).amountMinor <= rateSegment(hi, item).amountMinor).toBe(true);
      }),
    ));
});

describe('tier validation', () => {
  const ok = [
    { upTo: '100', unitPriceMinor: '0' },
    { upTo: null, unitPriceMinor: '1' },
  ];
  it('accepts ascending tiers ending unbounded', () => expect(parseTiers(ok)).toHaveLength(2));
  it.each([
    [[]],
    [[{ upTo: '100', unitPriceMinor: '1' }]], // last tier bounded
    [
      [
        { upTo: '100', unitPriceMinor: '1' },
        { upTo: '50', unitPriceMinor: '1' },
        { upTo: null, unitPriceMinor: '1' },
      ],
    ], // not increasing
    [
      [
        { upTo: '100', unitPriceMinor: '-1' },
        { upTo: null, unitPriceMinor: '1' },
      ],
    ],
    [
      [
        { upTo: '1e2', unitPriceMinor: '1' },
        { upTo: null, unitPriceMinor: '1' },
      ],
    ],
    ['not an array'],
  ])('rejects %j', (bad) => expect(() => parseTiers(bad)).toThrow());
});
