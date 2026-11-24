import { describe, expect, it } from 'vitest';
import {
  EXEC_PROFILES,
  ZERO_USAGE,
  QuotaLedger,
  DEFAULT_ORG_CEILINGS,
  estimateCostMinor,
  evaluateUsage,
  narrowLimits,
  runTimeouts,
  type OrgCeilings,
} from './index';

const L = EXEC_PROFILES.typecheck!.limits;

describe('evaluateUsage', () => {
  it('passes usage within every limit, including exactly at the limit', () => {
    expect(evaluateUsage(L, ZERO_USAGE)).toEqual([]);
    expect(
      evaluateUsage(L, {
        cpuSeconds: L.cpuSeconds,
        wallMs: L.wallSeconds * 1000,
        memoryMb: L.memoryMb,
        pids: L.pids,
        outputBytes: L.outputKb * 1024,
        diskMb: L.diskMb,
      }),
    ).toEqual([]);
  });
  it.each([
    ['cpuSeconds', 'cpu', 'kill'],
    ['wallMs', 'wall', 'kill'],
    ['memoryMb', 'memory', 'kill'],
    ['pids', 'pids', 'kill'],
    ['diskMb', 'disk', 'kill'],
    ['outputBytes', 'output', 'truncate'],
  ] as const)('%s over the limit is %s -> %s', (key, resource, action) => {
    const v = evaluateUsage(L, { ...ZERO_USAGE, [key]: 1e12 });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ resource, action });
  });
  it('treats NaN, Infinity and negative readings as violations (an unreliable runtime is not trusted)', () => {
    for (const bad of [NaN, Infinity, -1])
      expect(evaluateUsage(L, { ...ZERO_USAGE, memoryMb: bad }).map((x) => x.resource)).toEqual([
        'memory',
      ]);
  });
});

describe('narrowLimits: limits only shrink', () => {
  it('takes the component-wise minimum and never raises a profile limit', () => {
    const r = narrowLimits(L, { memoryMb: 256, wallSeconds: 99_999, pids: 8 });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.limits.memoryMb).toBe(256);
      expect(r.limits.pids).toBe(8);
      expect(r.limits.wallSeconds).toBe(L.wallSeconds);
    }
  });
  it('refuses a zero, negative or non-finite ceiling instead of ignoring it', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const r = narrowLimits(L, { cpuSeconds: bad });
      expect(r).toEqual({ ok: false, reasons: ['ceiling_invalid_cpuSeconds'] });
    }
  });
});

describe('runTimeouts', () => {
  it('soft stop at the wall limit, hard kill after a bounded grace', () => {
    expect(runTimeouts(L)).toEqual({ softMs: 180_000, hardMs: 185_000 });
    expect(runTimeouts({ ...L, wallSeconds: 1 }, 5_000)).toEqual({ softMs: 1000, hardMs: 2000 });
  });
});

describe('estimateCostMinor (integer minor units)', () => {
  const rates = { currency: 'SAR', minorPerKiloCpuSecond: 50 };
  it('rounds up and never returns a fraction', () => {
    expect(estimateCostMinor(1, rates)).toBe(1);
    expect(estimateCostMinor(120, rates)).toBe(6);
    expect(Number.isInteger(estimateCostMinor(33.3, rates))).toBe(true);
    expect(estimateCostMinor(-5, rates)).toBe(0);
  });
  it('rejects a fractional or negative rate', () => {
    expect(() => estimateCostMinor(1, { currency: 'SAR', minorPerKiloCpuSecond: 0.5 })).toThrow();
    expect(() => estimateCostMinor(1, { currency: 'SAR', minorPerKiloCpuSecond: -1 })).toThrow();
  });
});

describe('QuotaLedger: per-organization admission', () => {
  const ceilings: OrgCeilings = {
    maxConcurrent: 2,
    maxRunsPerWindow: 4,
    windowMs: 60_000,
    maxCpuSecondsPerWindow: 1000,
    budgetCapMinor: 100,
    rates: { currency: 'SAR', minorPerKiloCpuSecond: 100 },
  };
  const small = { ...L, cpuSeconds: 100 };
  let t = 0;
  const ledger = () => new QuotaLedger(() => t);
  it('the restrictive default admits nothing (no budget granted)', () => {
    const r = ledger().admit('o', 'r1', small, DEFAULT_ORG_CEILINGS);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reasons).toContain('budget_cap');
  });
  it('enforces the concurrency ceiling and frees a slot on release', () => {
    t = 0;
    const q = ledger();
    const a = q.admit('o', 'r1', small, ceilings);
    const b = q.admit('o', 'r2', small, ceilings);
    expect(a.ok && b.ok).toBe(true);
    const c = q.admit('o', 'r3', small, ceilings);
    expect(c).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['concurrency_ceiling']),
    });
    if (a.ok) q.release(a.reservation.id, 'o', 10, ceilings.rates);
    expect(q.admit('o', 'r3', small, ceilings).ok).toBe(true);
  });
  it("a release is idempotent and an organization cannot release another one's reservation", () => {
    t = 0;
    const q = ledger();
    const a = q.admit('o1', 'r1', small, ceilings);
    if (!a.ok) throw new Error('admit');
    expect(q.release(a.reservation.id, 'o2', 1, ceilings.rates)).toBeNull();
    expect(q.snapshot('o1').active).toBe(1);
    expect(q.release(a.reservation.id, 'o1', 1, ceilings.rates)).not.toBeNull();
    expect(q.release(a.reservation.id, 'o1', 1, ceilings.rates)).toBeNull();
  });
  it('charges measured CPU, capped at the reservation, and enforces the budget across runs', () => {
    t = 0;
    const q = ledger();
    const a = q.admit('o', 'r1', small, ceilings);
    if (!a.ok) throw new Error('admit');
    // measured above the reservation is capped at it: 100 cpu-s * 100 / 1000 = 10 minor
    expect(q.release(a.reservation.id, 'o', 9_999, ceilings.rates)).toEqual({ costMinor: 10 });
    // worst-case estimate of each further run is 10; the cap of 100 is reached after ten runs of the full limit
    // (the window ceiling of 4 runs stops it first, which is also correct)
    expect(q.snapshot('o').totalCostMinor).toBe(10);
  });
  it('rejects a budget that the worst case would exceed', () => {
    t = 0;
    const q = ledger();
    const r = q.admit('o', 'r1', { ...L, cpuSeconds: 900 }, { ...ceilings, budgetCapMinor: 50 });
    expect(r).toMatchObject({ ok: false, reasons: expect.arrayContaining(['budget_cap']) });
  });
  it('slides the window: old runs stop counting, the budget does not reset', () => {
    t = 0;
    const q = ledger();
    for (let i = 0; i < 4; i++) {
      const r = q.admit('o', `r${i}`, { ...L, cpuSeconds: 1 }, ceilings);
      if (!r.ok) throw new Error('admit ' + i);
      q.release(r.reservation.id, 'o', 1, ceilings.rates);
    }
    expect(q.admit('o', 'r9', { ...L, cpuSeconds: 1 }, ceilings)).toMatchObject({
      ok: false,
      reasons: ['runs_per_window_ceiling'],
    });
    t = 61_000;
    expect(q.admit('o', 'r9', { ...L, cpuSeconds: 1 }, ceilings).ok).toBe(true);
  });
  it('the CPU-second window ceiling counts reservations and spend', () => {
    t = 0;
    const q = ledger();
    const big = { ...L, cpuSeconds: 600 };
    expect(q.admit('o', 'r1', big, ceilings).ok).toBe(true);
    expect(q.admit('o', 'r2', big, ceilings)).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['cpu_seconds_ceiling']),
    });
  });
  it('another organization has its own counters', () => {
    t = 0;
    const q = ledger();
    q.admit('o1', 'r1', small, ceilings);
    q.admit('o1', 'r2', small, ceilings);
    expect(q.admit('o1', 'r3', small, ceilings).ok).toBe(false);
    expect(q.admit('o2', 'r3', small, ceilings).ok).toBe(true);
  });
  it('refuses the same run admitted twice', () => {
    t = 0;
    const q = ledger();
    q.admit('o', 'r1', small, ceilings);
    expect(q.admit('o', 'r1', small, ceilings)).toMatchObject({
      ok: false,
      reasons: ['run_already_admitted'],
    });
  });
});
