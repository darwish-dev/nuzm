import { estimateCostMinor, type ExecRates } from './limits';
import type { ExecLimits } from './policy';

/**
 * S-AG6 (OFFLINE): per-organization admission ceilings and the in-memory ledger that enforces them: concurrent runs, runs per window, CPU-seconds per window and a budget cap in
 * integer minor units. Admission RESERVES the worst case (the profile's CPU limit); `release` replaces the reservation with the measured usage. Organizations never see each
 * other's counters. The durable version (a table behind RLS) is a later migration; the contract here is what it must satisfy.
 */
export interface OrgCeilings {
  maxConcurrent: number;
  maxRunsPerWindow: number;
  windowMs: number;
  maxCpuSecondsPerWindow: number;
  /** budget in minor units; 0 = no budget granted: nothing is admitted (the restrictive default) */
  budgetCapMinor: number;
  rates: ExecRates;
}
export const DEFAULT_ORG_CEILINGS: OrgCeilings = {
  maxConcurrent: 2,
  maxRunsPerWindow: 30,
  windowMs: 3_600_000,
  maxCpuSecondsPerWindow: 3_600,
  budgetCapMinor: 0,
  rates: { currency: 'SAR', minorPerKiloCpuSecond: 0 },
};
export interface Reservation {
  id: string;
  orgId: string;
  runId: string;
  reservedCpuSeconds: number;
  reservedCostMinor: number;
  at: number;
}
export type AdmitResult = { ok: true; reservation: Reservation } | { ok: false; reasons: string[] };
interface Spent {
  at: number;
  cpuSeconds: number;
  costMinor: number;
}
interface OrgState {
  active: Map<string, Reservation>;
  spent: Spent[];
  /** budget spent in total (never expires within the ledger's life; a billing period reset is the durable layer's job) */
  totalCostMinor: number;
}

export class QuotaLedger {
  private readonly orgs = new Map<string, OrgState>();
  private seq = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  private st(orgId: string): OrgState {
    let s = this.orgs.get(orgId);
    if (!s) this.orgs.set(orgId, (s = { active: new Map(), spent: [], totalCostMinor: 0 }));
    return s;
  }
  private prune(s: OrgState, windowMs: number) {
    const cutoff = this.now() - windowMs;
    s.spent = s.spent.filter((x) => x.at > cutoff);
  }
  /** Would this run be admitted? Reserves nothing. `ignoreConcurrency` is for the early check at submit time: queued jobs do not hold a concurrency slot. */
  check(orgId: string, limits: ExecLimits, c: OrgCeilings, ignoreConcurrency = false): string[] {
    return this.evaluate(orgId, '', limits, c, ignoreConcurrency).reasons;
  }
  private evaluate(
    orgId: string,
    runId: string,
    limits: ExecLimits,
    c: OrgCeilings,
    ignoreConcurrency: boolean,
  ) {
    const s = this.st(orgId);
    this.prune(s, c.windowMs);
    const reasons: string[] = [];
    const reservedCpu = [...s.active.values()].reduce((n, r) => n + r.reservedCpuSeconds, 0);
    const reservedCost = [...s.active.values()].reduce((n, r) => n + r.reservedCostMinor, 0);
    const usedCpu = s.spent.reduce((n, x) => n + x.cpuSeconds, 0);
    if (!ignoreConcurrency && s.active.size >= c.maxConcurrent) reasons.push('concurrency_ceiling');
    if (s.spent.length + s.active.size >= c.maxRunsPerWindow)
      reasons.push('runs_per_window_ceiling');
    if (usedCpu + reservedCpu + limits.cpuSeconds > c.maxCpuSecondsPerWindow)
      reasons.push('cpu_seconds_ceiling');
    const cost = estimateCostMinor(limits.cpuSeconds, c.rates);
    if (s.totalCostMinor + reservedCost + cost > c.budgetCapMinor || c.budgetCapMinor <= 0)
      reasons.push('budget_cap');
    if (runId !== '' && [...s.active.values()].some((r) => r.runId === runId))
      reasons.push('run_already_admitted');
    return { reasons, cost, s };
  }
  /** Check every ceiling and, only when all hold, reserve. A refusal lists every reason (no partial reservation). */
  admit(orgId: string, runId: string, limits: ExecLimits, c: OrgCeilings): AdmitResult {
    const { reasons, cost, s } = this.evaluate(orgId, runId, limits, c, false);
    if (reasons.length) return { ok: false, reasons };
    const reservation: Reservation = {
      id: `rsv-${++this.seq}`,
      orgId,
      runId,
      reservedCpuSeconds: limits.cpuSeconds,
      reservedCostMinor: cost,
      at: this.now(),
    };
    s.active.set(reservation.id, reservation);
    return { ok: true, reservation };
  }
  /** Replace the reservation with the measured CPU time. Idempotent: a second release of the same reservation is a no-op returning null. */
  release(
    reservationId: string,
    orgId: string,
    actualCpuSeconds: number,
    rates: ExecRates,
  ): { costMinor: number } | null {
    const s = this.orgs.get(orgId);
    const r = s?.active.get(reservationId);
    if (!s || !r) return null; // unknown, already released, or ANOTHER organization's reservation
    s.active.delete(reservationId);
    const cpu = Math.min(Math.max(0, actualCpuSeconds), r.reservedCpuSeconds);
    const costMinor = estimateCostMinor(cpu, rates);
    s.spent.push({ at: this.now(), cpuSeconds: cpu, costMinor });
    s.totalCostMinor += costMinor;
    return { costMinor };
  }
  snapshot(orgId: string) {
    const s = this.st(orgId);
    return {
      active: s.active.size,
      runsInWindow: s.spent.length,
      totalCostMinor: s.totalCostMinor,
    };
  }
}
