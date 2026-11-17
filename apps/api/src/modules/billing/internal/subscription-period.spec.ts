import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { prorate } from './proration';
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  nextPeriodEnd,
  parseYmd,
} from './subscription-period';

describe('subscription periods', () => {
  it('clamps to the end of short months without drifting', () => {
    expect(addMonths('2026-01-31', 31, 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 31, 1)).toBe('2028-02-29'); // leap year
    expect(addMonths('2026-01-31', 31, 2)).toBe('2026-03-31'); // back on the anchor
    expect(addMonths('2026-12-15', 15, 1)).toBe('2027-01-15');
    expect(addMonths('2026-11-30', 30, 3)).toBe('2027-02-28');
  });
  it('rejects impossible dates', () => {
    for (const s of ['2026-02-30', '2026-13-01', '2026-00-10', 'x', '2026-1-1'])
      expect(() => parseYmd(s)).toThrow();
  });
  it('counts days across month and year ends', () => {
    expect(daysBetween('2026-11-17', '2026-12-17')).toBe(30);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('property (10,000 runs): periods are contiguous, 28..31 days, and stay on the anchor when the month allows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 1, max: 60 }),
        (y, m, anchor, n) => {
          let start = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(anchor, daysInMonth(y, m))).padStart(2, '0')}`;
          for (let i = 0; i < n; i++) {
            const end = nextPeriodEnd(start, anchor);
            const days = daysBetween(start, end);
            if (days < 28 || days > 31) return false;
            const e = parseYmd(end);
            if (e.d !== Math.min(anchor, daysInMonth(e.y, e.m))) return false;
            start = end; // the next period starts exactly where this one ended
          }
          return true;
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe('proration', () => {
  const base = { periodStart: '2026-11-01', periodEnd: '2026-12-01' };
  it('charges the difference for the days left (upgrade at mid period)', () => {
    const p = prorate({
      ...base,
      oldAmountMinor: 3000n,
      newAmountMinor: 6000n,
      changeDate: '2026-11-16',
    });
    expect(p).toMatchObject({
      daysTotal: 30,
      daysLeft: 15,
      unusedCreditMinor: 1500n,
      newChargeMinor: 3000n,
      netMinor: 1500n,
    });
  });
  it('credits a downgrade; a change on the first day is the full difference', () => {
    expect(
      prorate({ ...base, oldAmountMinor: 6000n, newAmountMinor: 3000n, changeDate: '2026-11-16' })
        .netMinor,
    ).toBe(-1500n);
    expect(
      prorate({ ...base, oldAmountMinor: 3000n, newAmountMinor: 5000n, changeDate: '2026-11-01' })
        .netMinor,
    ).toBe(2000n);
  });
  it('rounds half up on each side and refuses a date outside the period', () => {
    const p = prorate({
      ...base,
      oldAmountMinor: 1n,
      newAmountMinor: 1n,
      changeDate: '2026-11-16',
    }); // 15/30 of 1 = 0.5 → 1
    expect(p.unusedCreditMinor).toBe(1n);
    expect(() =>
      prorate({ ...base, oldAmountMinor: 1n, newAmountMinor: 1n, changeDate: '2026-12-01' }),
    ).toThrow();
    expect(() =>
      prorate({ ...base, oldAmountMinor: 1n, newAmountMinor: 1n, changeDate: '2026-10-31' }),
    ).toThrow();
  });
  it('property (10,000 runs): same terms net to zero; net is monotonic in the new amount; credit never exceeds the old amount', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 29 }),
        (a, b, off) => {
          const changeDate = addDays('2026-11-01', off);
          const same = prorate({ ...base, oldAmountMinor: a, newAmountMinor: a, changeDate });
          const p = prorate({ ...base, oldAmountMinor: a, newAmountMinor: b, changeDate });
          const bigger = prorate({
            ...base,
            oldAmountMinor: a,
            newAmountMinor: b + 1000n,
            changeDate,
          });
          return (
            same.netMinor === 0n &&
            bigger.netMinor >= p.netMinor &&
            p.unusedCreditMinor <= a &&
            p.newChargeMinor <= b
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
