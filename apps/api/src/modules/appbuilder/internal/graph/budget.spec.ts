import { describe, expect, it } from 'vitest';
import { BudgetExceeded, BudgetLedger, clampBudget } from './budget';

const zero = { tokensIn: 0, tokensOut: 0, costMinor: 0, steps: 0 };
const mk = (
  over: Partial<{ maxTokens: number; maxCostMinor: number; maxMinutes: number }> = {},
  now = () => 0,
) =>
  new BudgetLedger(
    { maxTokens: 10_000, maxCostMinor: 1_000, maxMinutes: 60, ...over },
    zero,
    0,
    now,
  );

describe('budget ledger (AC-M10-04)', () => {
  it('clamps a requested budget to the ceilings of M10 §9', () => {
    expect(clampBudget({ maxTokens: 9_000_000, maxCostMinor: 5, maxMinutes: 600 })).toEqual({
      maxTokens: 2_000_000,
      maxCostMinor: 5,
      maxMinutes: 60,
    });
  });
  it('refuses a call that cannot fit BEFORE it is sent (hard stop)', () => {
    const l = mk({ maxTokens: 1_000 });
    l.reserve(100, 800, 1, 1e9); // 900 reserved
    expect(() => l.reserve(100, 100, 1, 1e9)).toThrow(BudgetExceeded); // 900 + 200 > 1000
  });
  it('cost cap is min(run cap, org remaining)', () => {
    const l = mk({ maxCostMinor: 1_000_000 });
    expect(() => l.reserve(1_000, 1_000, 10, 5)).toThrow(/cost/); // 2000 tokens x 10/1k = 20 > org remaining 5
    expect(() => l.reserve(1_000, 1_000, 10, 50)).not.toThrow();
  });
  it('a settled call frees its reservation and counts its actual usage', () => {
    const l = mk({ maxTokens: 2_000 });
    const r = l.reserve(500, 1_000, 1, 1e9);
    l.settle(r, { tokensIn: 400, tokensOut: 300, costMinor: 1 });
    const s = l.snapshot();
    expect(s.tokens).toEqual({ used: 700, reserved: 0, cap: 2_000 });
  });
  it('a timed-out call (uncertain) is counted as fully spent', () => {
    const l = mk({ maxTokens: 2_000 });
    const r = l.reserve(500, 1_000, 1, 1e9);
    l.settleUncertain(r);
    expect(l.snapshot().tokens.used).toBe(1_500);
  });
  it('a call that provably never happened is released', () => {
    const l = mk({ maxTokens: 2_000 });
    const r = l.reserve(500, 1_000, 1, 1e9);
    l.release(r);
    expect(l.snapshot().tokens).toEqual({ used: 0, reserved: 0, cap: 2_000 });
  });
  it('stops at the minute cap and at the step cap', () => {
    let t = 0;
    const l = mk({ maxMinutes: 1 }, () => t);
    t = 61_000;
    expect(() => l.reserve(1, 1, 1, 1e9)).toThrow(/minutes/);
    const steps = new BudgetLedger(
      { maxTokens: 1e9, maxCostMinor: 1e9, maxMinutes: 60 },
      { ...zero, steps: 200 },
      0,
      () => 0,
    );
    expect(() => steps.reserve(1, 1, 1, 1e9)).toThrow(/steps/);
  });
  it('warns once utilisation reaches 80 %', () => {
    const l = mk({ maxTokens: 1_000 });
    const r = l.reserve(0, 700, 0, 1e9);
    l.settle(r, { tokensIn: 0, tokensOut: 700, costMinor: 0 });
    expect(l.warnedOnce).toBe(false);
    const r2 = l.reserve(0, 150, 0, 1e9);
    l.settle(r2, { tokensIn: 0, tokensOut: 150, costMinor: 0 });
    expect(l.warnedOnce).toBe(true);
    expect(l.snapshot().warn).toBe(true);
  });
  it('property: across 2,000 random runs the spent amount never exceeds the cap by more than one call (reservation - actual) and never when usage <= reservation', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let run = 0; run < 2_000; run++) {
      const cap = 500 + Math.floor(rnd() * 5_000);
      const l = mk({ maxTokens: cap, maxCostMinor: 1e9 });
      let spent = 0;
      for (let call = 0; call < 200; call++) {
        const maxOut = 1 + Math.floor(rnd() * 800);
        try {
          const r = l.reserve(Math.floor(rnd() * 100), maxOut, 1, 1e9);
          const actual = Math.min(r.tokens, Math.floor(rnd() * (r.tokens + 1)));
          l.settle(r, { tokensIn: 0, tokensOut: actual, costMinor: 0 });
          spent += actual;
        } catch (e) {
          expect(e).toBeInstanceOf(BudgetExceeded);
          break;
        }
      }
      expect(spent).toBeLessThanOrEqual(cap); // usage never exceeds the reservation, so the cap holds exactly
    }
  });
  it('runaway loop: a loop that always asks for max tokens stops at the cap', () => {
    const l = mk({ maxTokens: 10_000 });
    let calls = 0;
    for (;;) {
      try {
        const r = l.reserve(100, 900, 1, 1e9);
        l.settle(r, { tokensIn: 100, tokensOut: 900, costMinor: 0 });
        calls++;
      } catch {
        break;
      }
      if (calls > 1_000) throw new Error('did not stop');
    }
    expect(calls).toBe(10);
    expect(l.snapshot().tokens.used).toBeLessThanOrEqual(10_000);
  });
});
