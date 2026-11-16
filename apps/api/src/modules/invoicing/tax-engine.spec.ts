import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { computeTax, divRound, resolveRate, type TaxRate } from './internal/tax-engine';

const std: TaxRate = {
  code: 'STD',
  rateBps: 1500,
  scope: 'domestic',
  jurisdiction: 'SA',
  validFrom: '2020-07-01',
  validTo: null,
  verify: true,
};
const old: TaxRate = {
  code: 'OLD',
  rateBps: 500,
  scope: 'domestic',
  jurisdiction: 'SA',
  validFrom: '2018-01-01',
  validTo: '2020-07-01',
  verify: false,
};
const zero: TaxRate = {
  code: 'ZERO',
  rateBps: 0,
  scope: 'zero',
  jurisdiction: 'SA',
  validFrom: '2020-07-01',
  validTo: null,
  verify: true,
};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

const net = fc.bigInt({ min: 0n, max: 10n ** 13n });
const nets = fc.array(net, { minLength: 1, maxLength: 12 });
const bps = fc.integer({ min: 0, max: 10_000 });

describe('divRound', () => {
  it.each([
    [5n, 10n, 'half_up', 1n],
    [5n, 10n, 'half_even', 0n],
    [15n, 10n, 'half_even', 2n],
    [15n, 10n, 'half_up', 2n],
    [14n, 10n, 'half_up', 1n],
    [16n, 10n, 'half_even', 2n],
    [0n, 7n, 'half_up', 0n],
  ] as const)('%s / %s (%s) = %s', (n, dd, mode, out) => expect(divRound(n, dd, mode)).toBe(out));
  it('refuses negatives and a zero divisor', () => {
    expect(() => divRound(-1n, 10n, 'half_up')).toThrow();
    expect(() => divRound(1n, 0n, 'half_up')).toThrow();
  });
});

describe('invoice_total_equals_sum_of_lines_and_tax (property, AC-M03-05)', () => {
  it('Σlines + Σtax = total with zero minor-unit difference over 10,000 generated invoices', () =>
    fc.assert(
      fc.property(
        nets,
        bps,
        fc.constantFrom('half_up' as const, 'half_even' as const),
        (lines, rate, mode) => {
          const r = computeTax(lines, rate, mode);
          const sumNet = lines.reduce((s, x) => s + x, 0n);
          expect(r.netMinor).toBe(sumNet);
          expect(r.totalMinor).toBe(sumNet + r.taxMinor);
          expect(r.taxMinor).toBe(r.lines.reduce((s, l) => s + l.taxMinor, 0n));
          for (const l of r.lines) {
            expect(l.grossMinor).toBe(l.netMinor + l.taxMinor);
            // each line is within half a minor unit of the exact tax
            expect(l.taxMinor * 10_000n - l.netMinor * BigInt(rate) <= 5_000n).toBe(true);
            expect(l.netMinor * BigInt(rate) - l.taxMinor * 10_000n <= 5_000n).toBe(true);
          }
        },
      ),
      { numRuns: 10_000 },
    ));

  it('rounding_stable_under_line_reorder: any order gives the same totals', () =>
    fc.assert(
      fc.property(nets, bps, fc.integer({ min: 0, max: 1_000_000 }), (lines, rate, seed) => {
        const shuffled = [...lines]
          .sort(
            (a, b) => Number((a * BigInt(seed + 7)) % 997n) - Number((b * BigInt(seed + 7)) % 997n),
          )
          .reverse();
        const a = computeTax(lines, rate);
        const b = computeTax(shuffled, rate);
        expect([b.netMinor, b.taxMinor, b.totalMinor]).toEqual([
          a.netMinor,
          a.taxMinor,
          a.totalMinor,
        ]);
      }),
      { numRuns: 2_000 },
    ));

  it('zero rate gives zero tax; 100 % gives tax = net', () => {
    expect(computeTax([123n, 456n], 0).taxMinor).toBe(0n);
    expect(computeTax([123n, 456n], 10_000).taxMinor).toBe(579n);
  });
  it('rejects negative lines (credits are separate documents) and out-of-range rates', () => {
    expect(() => computeTax([-1n], 1500)).toThrow();
    expect(() => computeTax([1n], 10_001)).toThrow();
    expect(() => computeTax([1n], 1.5)).toThrow();
  });
  it('a known case: 3 lines at 15 % rounds per line, half up', () => {
    // 10.01 → 1.5015 → 150; 0.03 → 0.0045 → 0; 0.10 → 0.015 → 2 (half up)
    const r = computeTax([1001n, 3n, 10n], 1500);
    expect(r.lines.map((l) => l.taxMinor)).toEqual([150n, 0n, 2n]);
    expect(r.taxMinor).toBe(152n);
  });
});

describe('resolveRate (effective-dated, config-driven)', () => {
  const rates = [old, std, zero];
  it('picks the rate in force on the date', () => {
    expect(
      resolveRate(rates, { on: d('2019-05-01'), buyerType: 'b2c', scope: 'domestic' }).rate.code,
    ).toBe('OLD');
    expect(
      resolveRate(rates, { on: d('2020-06-30'), buyerType: 'b2c', scope: 'domestic' }).rate.code,
    ).toBe('OLD');
    expect(
      resolveRate(rates, { on: d('2020-07-01'), buyerType: 'b2c', scope: 'domestic' }).rate.code,
    ).toBe('STD');
    expect(
      resolveRate(rates, { on: d('2026-11-17'), buyerType: 'b2b', scope: 'domestic' }).rate.rateBps,
    ).toBe(1500);
  });
  it('a date with no rate configured is an error, never a silent zero', () => {
    let err: { code?: string; detail?: string } = {};
    try {
      resolveRate(rates, { on: d('2010-01-01'), buyerType: 'b2c', scope: 'domestic' });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe('service_unavailable');
    expect(err.detail).toMatch(/no tax rate/);
  });
  it('unknown cases use the standard rate and are flagged for review', () => {
    const a = resolveRate(rates, { on: d('2026-01-01'), buyerType: 'b2c' }); // scope not configured
    expect(a.rate.code).toBe('STD');
    expect(a.reviewRequired).toBe(true);
    expect(a.reasons).toContain('scope_not_configured');
    const b = resolveRate(rates, {
      on: d('2026-01-01'),
      buyerType: 'b2b',
      scope: 'domestic',
      buyerCountry: 'AE',
    });
    expect(b.reviewRequired).toBe(true);
    expect(b.reasons).toContain('buyer_outside_jurisdiction');
    const c = resolveRate(rates, { on: d('2026-01-01'), buyerType: 'b2b', scope: 'export' }); // export rate not configured → standard + flag
    expect(c.rate.code).toBe('STD');
    expect(c.reasons).toContain('no_rate_for_scope_export');
  });
  it('a configured, advisor-approved case needs no review; an unverified rate is only noted', () => {
    const r = resolveRate(rates, { on: d('2026-01-01'), buyerType: 'b2c', scope: 'zero' });
    expect(r.rate.rateBps).toBe(0);
    expect(r.reviewRequired).toBe(false);
    expect(r.reasons).toEqual(['rate_unverified']);
    const ok = resolveRate([{ ...std, verify: false }], {
      on: d('2026-01-01'),
      buyerType: 'b2c',
      scope: 'domestic',
    });
    expect(ok.reasons).toEqual([]);
  });
  it('the jurisdiction is part of the key', () => {
    expect(() =>
      resolveRate(rates, {
        on: d('2026-01-01'),
        buyerType: 'b2c',
        scope: 'domestic',
        jurisdiction: 'AE',
      }),
    ).toThrow();
  });
});
