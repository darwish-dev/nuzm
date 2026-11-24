import type { ExecLimits } from './policy';

/**
 * S-AG6 (OFFLINE): resource limits and timeouts as pure functions. A runtime reports observed usage; this module says which limit was crossed and what to do. Limits only ever
 * SHRINK on the way from the profile to the run (organization ceilings, remaining budget): nothing can raise a profile's limit.
 */
export type LimitResource = 'cpu' | 'wall' | 'memory' | 'pids' | 'output' | 'disk';
export interface ExecUsage {
  cpuSeconds: number;
  wallMs: number;
  memoryMb: number;
  pids: number;
  outputBytes: number;
  diskMb: number;
}
export const ZERO_USAGE: ExecUsage = {
  cpuSeconds: 0,
  wallMs: 0,
  memoryMb: 0,
  pids: 0,
  outputBytes: 0,
  diskMb: 0,
};
export interface LimitViolation {
  resource: LimitResource;
  limit: number;
  observed: number;
  /** `kill`: the process group is killed (cpu, wall, memory, pids, disk). `truncate`: output over the cap is cut and flagged, the run is not killed. */
  action: 'kill' | 'truncate';
}
const finite = (n: number) => (Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY);

/** Which limits does this usage cross? A non-finite or negative reading is treated as a violation (a runtime that cannot report is not trusted). */
export function evaluateUsage(limits: ExecLimits, u: ExecUsage): LimitViolation[] {
  const v: LimitViolation[] = [];
  const chk = (
    resource: LimitResource,
    limit: number,
    observed: number,
    action: LimitViolation['action'],
  ) => {
    if (finite(observed) > limit) v.push({ resource, limit, observed, action });
  };
  chk('cpu', limits.cpuSeconds, u.cpuSeconds, 'kill');
  chk('wall', limits.wallSeconds * 1000, u.wallMs, 'kill');
  chk('memory', limits.memoryMb, u.memoryMb, 'kill');
  chk('pids', limits.pids, u.pids, 'kill');
  chk('disk', limits.diskMb, u.diskMb, 'kill');
  chk('output', limits.outputKb * 1024, u.outputBytes, 'truncate');
  return v;
}

/** The component-wise minimum of two limit sets: the way a ceiling narrows a profile. A non-positive or non-finite ceiling REFUSES (it is never ignored). */
export function narrowLimits(
  profile: ExecLimits,
  ceiling: Partial<ExecLimits>,
): { ok: true; limits: ExecLimits } | { ok: false; reasons: string[] } {
  const out: ExecLimits = { ...profile };
  const reasons: string[] = [];
  for (const k of Object.keys(profile) as (keyof ExecLimits)[]) {
    const c = ceiling[k];
    if (c === undefined) continue;
    if (!Number.isFinite(c) || c <= 0) {
      reasons.push(`ceiling_invalid_${k}`);
      continue;
    }
    out[k] = Math.min(profile[k], c);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, limits: out };
}

export interface RunTimeouts {
  /** deliver a polite stop (SIGTERM to the process group) */
  softMs: number;
  /** SIGKILL the whole process group and tear the sandbox down */
  hardMs: number;
}
/** wall limit -> soft stop at the limit, hard kill after a fixed grace (never longer than the limit itself, so the hard deadline is at most 2x). */
export function runTimeouts(limits: ExecLimits, graceMs = 5_000): RunTimeouts {
  const softMs = limits.wallSeconds * 1000;
  return { softMs, hardMs: softMs + Math.min(graceMs, softMs) };
}

/** Integer minor units only (CLAUDE.md money rule). The rate is configuration (owner decision, synthetic in tests): minor units per 1000 CPU-seconds. */
export interface ExecRates {
  currency: string;
  minorPerKiloCpuSecond: number;
}
export function estimateCostMinor(cpuSeconds: number, rates: ExecRates): number {
  if (!Number.isInteger(rates.minorPerKiloCpuSecond) || rates.minorPerKiloCpuSecond < 0)
    throw new RangeError('minorPerKiloCpuSecond must be a non-negative integer');
  return Math.ceil((Math.max(0, cpuSeconds) * rates.minorPerKiloCpuSecond) / 1000);
}
