/**
 * S-AG6 (OFFLINE): runtime health checks. A runtime exposes a probe; the monitor turns a stream of probe results into a state with hysteresis (one slow answer does not flap the
 * state) and the admission rule: nothing is placed on a runtime that is not `healthy`. `degraded` still finishes what runs but takes nothing new; `unhealthy` triggers the
 * emergency terminator when the runtime cannot be trusted any more (its own probe failing is not proof of anything else).
 */
export interface HealthProbeResult {
  ok: boolean;
  latencyMs: number;
  /** free slots reported by the runtime; 0 means full, not broken */
  freeSlots: number;
  /** an identifier-only note (e.g. `socket_unreachable`), never an error message with paths */
  note?: string;
}
export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export interface HealthConfig {
  degradedAfterFailures: number;
  unhealthyAfterFailures: number;
  healthyAfterSuccesses: number;
  slowMs: number;
}
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  degradedAfterFailures: 1,
  unhealthyAfterFailures: 3,
  healthyAfterSuccesses: 2,
  slowMs: 2_000,
};
export class RuntimeHealthMonitor {
  private st: HealthState = 'unknown';
  private fails = 0;
  private oks = 0;
  readonly transitions: { from: HealthState; to: HealthState; note: string }[] = [];
  constructor(private readonly cfg: HealthConfig = DEFAULT_HEALTH_CONFIG) {}
  get state(): HealthState {
    return this.st;
  }
  private to(s: HealthState, note: string) {
    if (s !== this.st) {
      this.transitions.push({ from: this.st, to: s, note });
      this.st = s;
    }
  }
  record(r: HealthProbeResult): HealthState {
    const bad = !r.ok || r.latencyMs > this.cfg.slowMs;
    if (bad) {
      this.fails++;
      this.oks = 0;
      if (this.fails >= this.cfg.unhealthyAfterFailures)
        this.to('unhealthy', r.note ?? 'probe_failed');
      else if (this.fails >= this.cfg.degradedAfterFailures)
        this.to('degraded', r.note ?? (r.ok ? 'slow' : 'probe_failed'));
    } else {
      this.oks++;
      this.fails = 0;
      if (this.st === 'unknown' || this.oks >= this.cfg.healthyAfterSuccesses)
        this.to('healthy', 'recovered');
    }
    return this.st;
  }
  /** may a new run be placed? Only on a healthy runtime that reported capacity. */
  admits(lastProbe: HealthProbeResult | null): boolean {
    return this.st === 'healthy' && lastProbe !== null && lastProbe.ok && lastProbe.freeSlots > 0;
  }
  /** an unhealthy runtime should have its running work terminated and its workspaces reaped */
  shouldTerminateRunning(): boolean {
    return this.st === 'unhealthy';
  }
}
