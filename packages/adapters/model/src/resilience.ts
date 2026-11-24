import { ModelAdapterError, type ModelErrorCode } from './types';

/**
 * Provider resilience primitives (S-AG4, gap G1–G3). PURE and offline: time and randomness are injected, nothing here touches the network, a timer or the database.
 * The gateway owns the instances (one per process) and feeds them the outcome of every attempt; an adapter never decides policy.
 */
export interface Clock {
  now(): number;
}
export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };
/** a random number in [0, 1); injected so tests are deterministic */
export type Rand = () => number;

// ───────────────────────────── retry policy ─────────────────────────────

export interface RetryPolicy {
  /** attempts per candidate, first try included (>= 1) */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** exponential factor between attempts (>= 1) */
  multiplier: number;
  /** `full`: a random delay in [0, computed]; `none`: the computed delay (deterministic) */
  jitter: 'full' | 'none';
  /** a provider-sent Retry-After is honoured up to `maxDelayMs`; a longer one means "do not retry here, fall back" */
  honorRetryAfter: boolean;
}
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  multiplier: 2,
  jitter: 'full',
  honorRetryAfter: true,
};

export function validateRetryPolicy(p: RetryPolicy): RetryPolicy {
  const ok =
    Number.isInteger(p.maxAttempts) &&
    p.maxAttempts >= 1 &&
    p.maxAttempts <= 10 &&
    Number.isFinite(p.baseDelayMs) &&
    p.baseDelayMs >= 0 &&
    Number.isFinite(p.maxDelayMs) &&
    p.maxDelayMs >= p.baseDelayMs &&
    Number.isFinite(p.multiplier) &&
    p.multiplier >= 1;
  if (!ok) throw new RangeError('invalid retry policy');
  return p;
}

/**
 * Should attempt `attempt` (1-based, the one that just failed) be followed by another, and after how long? `null` = do not retry on this candidate.
 * Only errors the adapter marked retryable are retried; `aborted` never is.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  err: ModelAdapterError,
  rand: Rand = Math.random,
): number | null {
  if (!err.retryable || err.code === 'aborted') return null;
  if (attempt >= policy.maxAttempts) return null;
  if (policy.honorRetryAfter && err.retryAfterMs !== undefined) {
    if (err.retryAfterMs > policy.maxDelayMs) return null; // the provider asks for longer than we may wait: fail over instead
    return Math.max(0, Math.floor(err.retryAfterMs));
  }
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** (attempt - 1));
  return policy.jitter === 'full' ? Math.floor(rand() * raw) : Math.floor(raw);
}

/**
 * The provider's wait hint from response headers (`retry-after`, seconds or an HTTP date; also `retry-after-ms`), in whole milliseconds, or `undefined`.
 * Accepts a `Headers` object or a plain record; anything unparsable or negative is ignored (a hint is never trusted beyond the policy's maximum anyway).
 */
export function parseRetryAfterMs(headers: unknown, now: number = Date.now()): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const get = (name: string): string | undefined => {
    const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>;
    if (typeof h.get === 'function') return h.get(name) ?? undefined;
    const v = h[name] ?? h[name.toLowerCase()];
    return typeof v === 'string' ? v : undefined;
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined && /^\d{1,9}$/.test(ms.trim())) return Number(ms.trim());
  const ra = get('retry-after');
  if (ra === undefined) return undefined;
  const t = ra.trim();
  if (/^\d{1,6}$/.test(t)) return Number(t) * 1000;
  if (!/^[A-Za-z]{3},? /.test(t)) return undefined; // an HTTP date starts with the day name; Date.parse would accept junk such as "-5"
  const date = Date.parse(t);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Wait `ms`, or reject with an `aborted` ModelAdapterError as soon as the signal fires (a cancelled call never sleeps on). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ModelAdapterError('aborted', 'cancelled'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ModelAdapterError('aborted', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ───────────────────────────── circuit breaker ─────────────────────────────

/** Error codes that say something about the PROVIDER's health. A bad request, a content filter, a caller's cancel or an unsupported capability are not the provider's fault. */
const HEALTH_FAILURES: ReadonlySet<ModelErrorCode> = new Set([
  'timeout',
  'unavailable',
  'rate_limited',
]);
export const countsAgainstHealth = (code: ModelErrorCode): boolean => HEALTH_FAILURES.has(code);

export type BreakerState = 'closed' | 'open' | 'half_open';
export interface BreakerConfig {
  /** consecutive health failures that open the circuit */
  failureThreshold: number;
  /** how long an open circuit refuses calls before one trial is allowed */
  openMs: number;
  /** trial calls allowed at once while half-open; one success closes, one failure re-opens */
  halfOpenMaxProbes: number;
}
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  openMs: 30_000,
  halfOpenMaxProbes: 1,
};
interface BreakerRec {
  state: BreakerState;
  failures: number;
  openedAt: number;
  probes: number;
}

/**
 * One breaker record per key (the gateway uses `provider/model`). State machine:
 * closed --N consecutive health failures--> open --openMs elapsed--> half_open --success--> closed
 *                                                                              --failure--> open
 * `acquire` must be paired with exactly one `success` or `failure` (or `release` when the attempt says nothing about health, e.g. a cancel).
 */
export class CircuitBreaker {
  private readonly recs = new Map<string, BreakerRec>();
  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    if (cfg.failureThreshold < 1 || cfg.openMs < 0 || cfg.halfOpenMaxProbes < 1)
      throw new RangeError('invalid breaker config');
  }
  private rec(key: string): BreakerRec {
    let r = this.recs.get(key);
    if (!r) this.recs.set(key, (r = { state: 'closed', failures: 0, openedAt: 0, probes: 0 }));
    return r;
  }
  /** the state as of now (an open circuit whose wait has elapsed reads as half_open); does not reserve a probe */
  state(key: string): BreakerState {
    const r = this.recs.get(key);
    if (!r) return 'closed';
    if (r.state === 'open' && this.clock.now() - r.openedAt >= this.cfg.openMs) return 'half_open';
    return r.state;
  }
  /** May a call go out? A half-open circuit lets `halfOpenMaxProbes` through and refuses the rest. */
  acquire(key: string): boolean {
    const r = this.rec(key);
    if (r.state === 'open') {
      if (this.clock.now() - r.openedAt < this.cfg.openMs) return false;
      r.state = 'half_open';
      r.probes = 0;
    }
    if (r.state === 'half_open') {
      if (r.probes >= this.cfg.halfOpenMaxProbes) return false;
      r.probes++;
    }
    return true;
  }
  success(key: string): void {
    const r = this.rec(key);
    r.state = 'closed';
    r.failures = 0;
    r.probes = 0;
  }
  /** Record a failed attempt. Only health failures count; anything else just frees a half-open probe slot. */
  failure(key: string, code: ModelErrorCode): void {
    const r = this.rec(key);
    if (!countsAgainstHealth(code)) return this.release(key);
    if (r.state === 'half_open') return this.open(r);
    r.failures++;
    if (r.failures >= this.cfg.failureThreshold) this.open(r);
  }
  /** An attempt that says nothing about health (cancelled, refused by content filter, bad request): frees a probe slot, changes nothing else. */
  release(key: string): void {
    const r = this.rec(key);
    if (r.state === 'half_open' && r.probes > 0) r.probes--;
  }
  private open(r: BreakerRec): void {
    r.state = 'open';
    r.openedAt = this.clock.now();
    r.probes = 0;
  }
  /** operator action: close the circuit now */
  reset(key: string): void {
    this.recs.delete(key);
  }
}

// ───────────────────────────── health monitor ─────────────────────────────

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
export interface HealthConfig {
  /** only samples newer than this count */
  windowMs: number;
  /** keep at most this many samples per key (memory bound) */
  maxSamples: number;
  /** fewer samples than this in the window = `unknown` */
  minSamples: number;
  /** success rate (per mille) at or above which a key is healthy / below which it is unhealthy */
  healthyPerMille: number;
  unhealthyPerMille: number;
}
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  windowMs: 5 * 60_000,
  maxSamples: 200,
  minSamples: 5,
  healthyPerMille: 950,
  unhealthyPerMille: 500,
};
export interface HealthSample {
  at: number;
  ok: boolean;
  latencyMs: number;
  errorCode?: ModelErrorCode;
}
export interface HealthSnapshot {
  key: string;
  status: HealthStatus;
  samples: number;
  /** integer per mille (0–1000): no floats in a status that may end up in a report */
  successPerMille: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastErrorCode: ModelErrorCode | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  breaker: BreakerState;
}

/** Rolling-window health per key. Only samples that speak about the provider count (see `countsAgainstHealth`); a caller's cancel is not a sample. */
export class HealthMonitor {
  private readonly samples = new Map<string, HealthSample[]>();
  private readonly lastErr = new Map<string, { code: ModelErrorCode; at: number }>();
  private readonly lastOk = new Map<string, number>();
  constructor(
    private readonly cfg: HealthConfig = DEFAULT_HEALTH_CONFIG,
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly breaker?: CircuitBreaker,
  ) {}
  recordSuccess(key: string, latencyMs: number): void {
    const at = this.clock.now();
    this.lastOk.set(key, at);
    this.push(key, { at, ok: true, latencyMs: Math.max(0, Math.floor(latencyMs)) });
  }
  recordFailure(key: string, code: ModelErrorCode, latencyMs: number): void {
    if (!countsAgainstHealth(code)) return;
    const at = this.clock.now();
    this.lastErr.set(key, { code, at });
    this.push(key, { at, ok: false, latencyMs: Math.max(0, Math.floor(latencyMs)), errorCode: code });
  }
  private push(key: string, s: HealthSample): void {
    const arr = this.samples.get(key) ?? [];
    arr.push(s);
    if (arr.length > this.cfg.maxSamples) arr.splice(0, arr.length - this.cfg.maxSamples);
    this.samples.set(key, arr);
  }
  snapshot(key: string): HealthSnapshot {
    const cutoff = this.clock.now() - this.cfg.windowMs;
    const live = (this.samples.get(key) ?? []).filter((s) => s.at >= cutoff);
    const ok = live.filter((s) => s.ok);
    const lat = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
    const pct = (p: number): number | null =>
      lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)]!;
    const rate = live.length === 0 ? null : Math.floor((ok.length * 1000) / live.length);
    const breaker = this.breaker?.state(key) ?? 'closed';
    let status: HealthStatus;
    if (breaker === 'open') status = 'unhealthy';
    else if (live.length < this.cfg.minSamples || rate === null) status = 'unknown';
    else if (rate >= this.cfg.healthyPerMille) status = 'healthy';
    else if (rate < this.cfg.unhealthyPerMille) status = 'unhealthy';
    else status = 'degraded';
    const le = this.lastErr.get(key);
    return {
      key,
      status,
      samples: live.length,
      successPerMille: rate,
      p50LatencyMs: pct(50),
      p95LatencyMs: pct(95),
      lastErrorCode: le?.code ?? null,
      lastErrorAt: le?.at ?? null,
      lastSuccessAt: this.lastOk.get(key) ?? null,
      breaker,
    };
  }
  keys(): string[] {
    return [...this.samples.keys()].sort();
  }
  all(): HealthSnapshot[] {
    return this.keys().map((k) => this.snapshot(k));
  }
}

/** The pieces the gateway holds together. */
export interface Resilience {
  retry: RetryPolicy;
  breaker: CircuitBreaker;
  health: HealthMonitor;
}
export function createResilience(
  o: {
    retry?: Partial<RetryPolicy>;
    breaker?: Partial<BreakerConfig>;
    health?: Partial<HealthConfig>;
    clock?: Clock;
  } = {},
): Resilience {
  const clock = o.clock ?? SYSTEM_CLOCK;
  const breaker = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, ...o.breaker }, clock);
  return {
    retry: validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...o.retry }),
    breaker,
    health: new HealthMonitor({ ...DEFAULT_HEALTH_CONFIG, ...o.health }, clock, breaker),
  };
}
