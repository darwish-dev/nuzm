import { evaluateUsage, type ExecUsage, type LimitViolation } from './limits';
import type { ExecLimits } from './policy';

/**
 * S-AG6 (OFFLINE): the resource monitor. A runtime (or its sidecar) reports samples; the monitor decides: ok, warn (>= 80 % of a limit), kill (a limit crossed or the readings stop
 * arriving). Wall time is measured by the MONITOR from the start of the run, not trusted from the runtime. A run that goes silent (no sample for `staleMs`) is killed: a monitor
 * that cannot see a process cannot say it is within limits.
 */
export interface MonitorSample {
  at: number;
  usage: ExecUsage;
}
export type MonitorAction =
  | { kind: 'ok' }
  | { kind: 'warn'; resources: string[] }
  | { kind: 'kill'; reason: 'limit' | 'stale' | 'wall'; violations: LimitViolation[] };
export interface MonitorConfig {
  warnRatio: number;
  staleMs: number;
}
export const DEFAULT_MONITOR_CONFIG: MonitorConfig = { warnRatio: 0.8, staleMs: 15_000 };

export class ResourceMonitor {
  private readonly runs = new Map<
    string,
    { limits: ExecLimits; startedAt: number; last: MonitorSample | null; peak: ExecUsage }
  >();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly cfg: MonitorConfig = DEFAULT_MONITOR_CONFIG,
  ) {}
  start(runId: string, limits: ExecLimits) {
    this.runs.set(runId, {
      limits,
      startedAt: this.now(),
      last: null,
      peak: { cpuSeconds: 0, wallMs: 0, memoryMb: 0, pids: 0, outputBytes: 0, diskMb: 0 },
    });
  }
  stop(runId: string) {
    return this.runs.delete(runId);
  }
  active(): string[] {
    return [...this.runs.keys()];
  }
  /** Feed a sample and get the action. The wall member is overwritten with the monitor's own clock. */
  observe(runId: string, usage: ExecUsage): MonitorAction {
    const r = this.runs.get(runId);
    if (!r) return { kind: 'ok' };
    const t = this.now();
    const u: ExecUsage = { ...usage, wallMs: t - r.startedAt };
    r.last = { at: t, usage: u };
    for (const k of Object.keys(r.peak) as (keyof ExecUsage)[])
      r.peak[k] = Math.max(r.peak[k], Number.isFinite(u[k]) ? u[k] : Infinity);
    return this.classify(r.limits, u);
  }
  /** Called on a timer: silent runs are killed, and a run past its wall limit is killed even if no sample arrives. */
  tick(): { runId: string; action: MonitorAction }[] {
    const t = this.now();
    const out: { runId: string; action: MonitorAction }[] = [];
    for (const [runId, r] of this.runs) {
      const wallMs = t - r.startedAt;
      if (wallMs > r.limits.wallSeconds * 1000)
        out.push({
          runId,
          action: {
            kind: 'kill',
            reason: 'wall',
            violations: [
              {
                resource: 'wall',
                limit: r.limits.wallSeconds * 1000,
                observed: wallMs,
                action: 'kill',
              },
            ],
          },
        });
      else if (t - (r.last?.at ?? r.startedAt) > this.cfg.staleMs)
        out.push({ runId, action: { kind: 'kill', reason: 'stale', violations: [] } });
    }
    return out;
  }
  peak(runId: string): ExecUsage | undefined {
    return this.runs.get(runId)?.peak;
  }
  private classify(limits: ExecLimits, u: ExecUsage): MonitorAction {
    const violations = evaluateUsage(limits, u);
    const kills = violations.filter((v) => v.action === 'kill');
    if (kills.length)
      return {
        kind: 'kill',
        reason: kills.some((v) => v.resource === 'wall') ? 'wall' : 'limit',
        violations,
      };
    const ratio = (n: number, lim: number) => n / lim >= this.cfg.warnRatio;
    const warn: string[] = [];
    if (ratio(u.cpuSeconds, limits.cpuSeconds)) warn.push('cpu');
    if (ratio(u.wallMs, limits.wallSeconds * 1000)) warn.push('wall');
    if (ratio(u.memoryMb, limits.memoryMb)) warn.push('memory');
    if (ratio(u.pids, limits.pids)) warn.push('pids');
    if (ratio(u.diskMb, limits.diskMb)) warn.push('disk');
    if (violations.length) warn.push('output');
    return warn.length ? { kind: 'warn', resources: warn } : { kind: 'ok' };
  }
}
