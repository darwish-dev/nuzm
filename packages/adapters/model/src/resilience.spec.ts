import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_RETRY_POLICY,
  HealthMonitor,
  abortableSleep,
  countsAgainstHealth,
  createResilience,
  parseRetryAfterMs,
  retryDelayMs,
  validateRetryPolicy,
  type Clock,
} from './resilience';
import { ModelAdapterError } from './types';

const clockAt = (start = 1_000_000) => {
  let t = start;
  return { clock: { now: () => t } as Clock, advance: (ms: number) => (t += ms) };
};

describe('retry policy', () => {
  const p = { ...DEFAULT_RETRY_POLICY, maxAttempts: 4, jitter: 'none' as const };
  const e = (code: ConstructorParameters<typeof ModelAdapterError>[0], ra?: number) =>
    new ModelAdapterError(code, 'x', undefined, ra);

  it('backs off exponentially, capped, with no jitter in deterministic mode', () => {
    expect(retryDelayMs(p, 1, e('unavailable'))).toBe(200);
    expect(retryDelayMs(p, 2, e('unavailable'))).toBe(400);
    expect(retryDelayMs(p, 3, e('unavailable'))).toBe(800);
    expect(retryDelayMs({ ...p, maxAttempts: 9, maxDelayMs: 500 }, 5, e('timeout'))).toBe(500);
  });
  it('stops at the last attempt', () => {
    expect(retryDelayMs(p, 4, e('unavailable'))).toBeNull();
  });
  it('full jitter stays within [0, computed] and uses the injected random source', () => {
    const j = { ...p, jitter: 'full' as const };
    expect(retryDelayMs(j, 2, e('timeout'), () => 0)).toBe(0);
    expect(retryDelayMs(j, 2, e('timeout'), () => 0.5)).toBe(200);
    expect(retryDelayMs(j, 2, e('timeout'), () => 0.999999)).toBeLessThan(400);
  });
  it('never retries a non-retryable error or a cancel', () => {
    expect(retryDelayMs(p, 1, e('invalid_request'))).toBeNull();
    expect(retryDelayMs(p, 1, e('content_filtered'))).toBeNull();
    expect(retryDelayMs(p, 1, e('invalid_response'))).toBeNull();
    expect(retryDelayMs(p, 1, e('aborted'))).toBeNull();
    expect(retryDelayMs(p, 1, new ModelAdapterError('unavailable', 'x', false))).toBeNull();
  });
  it('honours Retry-After up to the cap and fails over when the hint is longer', () => {
    expect(retryDelayMs(p, 1, e('rate_limited', 1500))).toBe(1500);
    expect(retryDelayMs(p, 1, e('rate_limited', p.maxDelayMs + 1))).toBeNull();
    expect(retryDelayMs({ ...p, honorRetryAfter: false }, 1, e('rate_limited', 1500))).toBe(200);
  });
  it('rejects nonsense policies', () => {
    expect(() => validateRetryPolicy({ ...p, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...p, maxAttempts: 11 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...p, multiplier: 0.5 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...p, maxDelayMs: 1, baseDelayMs: 2 })).toThrow(RangeError);
    expect(() => validateRetryPolicy({ ...p, baseDelayMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('Retry-After parsing', () => {
  it('reads seconds, milliseconds, HTTP dates, Headers objects and plain records', () => {
    expect(parseRetryAfterMs({ 'retry-after': '3' })).toBe(3000);
    expect(parseRetryAfterMs({ 'retry-after-ms': '250', 'retry-after': '9' })).toBe(250);
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '2' }))).toBe(2000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs({ 'retry-after': 'Thu, 01 Jan 2026 00:00:07 GMT' }, now)).toBe(7000);
    expect(parseRetryAfterMs({ 'retry-after': 'Wed, 31 Dec 2025 00:00:00 GMT' }, now)).toBe(0);
  });
  it('ignores junk', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('x')).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': '-5' })).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': '99999999999' })).toBeUndefined();
  });
});

describe('abortableSleep', () => {
  it('resolves immediately for 0 ms and rejects at once for an aborted signal', async () => {
    await expect(abortableSleep(0)).resolves.toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(1000, ac.signal)).rejects.toMatchObject({ code: 'aborted' });
  });
  it('is cut short by an abort during the wait', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = abortableSleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('waits for the delay otherwise', async () => {
    const started = Date.now();
    await abortableSleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});

describe('circuit breaker', () => {
  const cfg = { failureThreshold: 3, openMs: 1000, halfOpenMaxProbes: 1 };
  it('opens after N consecutive health failures and refuses calls', () => {
    const { clock } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (let i = 0; i < 3; i++) {
      expect(b.acquire('p/m')).toBe(true);
      b.failure('p/m', 'unavailable');
    }
    expect(b.state('p/m')).toBe('open');
    expect(b.acquire('p/m')).toBe(false);
  });
  it('a success resets the consecutive count', () => {
    const { clock } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    b.failure('k', 'timeout');
    b.failure('k', 'timeout');
    b.success('k');
    b.failure('k', 'timeout');
    b.failure('k', 'timeout');
    expect(b.state('k')).toBe('closed');
  });
  it('errors that are not the provider\'s fault never open it', () => {
    const { clock } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (const code of ['invalid_request', 'content_filtered', 'aborted', 'unsupported_capability', 'invalid_response'] as const) {
      expect(countsAgainstHealth(code)).toBe(false);
      for (let i = 0; i < 10; i++) b.failure('k', code);
    }
    expect(b.state('k')).toBe('closed');
  });
  it('half-opens after the wait, allows exactly one probe, closes on success', () => {
    const { clock, advance } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (let i = 0; i < 3; i++) b.failure('k', 'unavailable');
    advance(999);
    expect(b.acquire('k')).toBe(false);
    advance(1);
    expect(b.state('k')).toBe('half_open');
    expect(b.acquire('k')).toBe(true); // the probe
    expect(b.acquire('k')).toBe(false); // everyone else waits
    b.success('k');
    expect(b.state('k')).toBe('closed');
    expect(b.acquire('k')).toBe(true);
  });
  it('a failed probe re-opens for a full wait', () => {
    const { clock, advance } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (let i = 0; i < 3; i++) b.failure('k', 'unavailable');
    advance(1000);
    expect(b.acquire('k')).toBe(true);
    b.failure('k', 'timeout');
    expect(b.state('k')).toBe('open');
    advance(500);
    expect(b.acquire('k')).toBe(false);
    advance(500);
    expect(b.acquire('k')).toBe(true);
  });
  it('a probe that says nothing about health (a cancel) frees its slot', () => {
    const { clock, advance } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (let i = 0; i < 3; i++) b.failure('k', 'unavailable');
    advance(1000);
    expect(b.acquire('k')).toBe(true);
    b.failure('k', 'aborted');
    expect(b.state('k')).toBe('half_open');
    expect(b.acquire('k')).toBe(true);
  });
  it('keys are independent and reset closes a circuit', () => {
    const { clock } = clockAt();
    const b = new CircuitBreaker(cfg, clock);
    for (let i = 0; i < 3; i++) b.failure('a/x', 'unavailable');
    expect(b.acquire('a/x')).toBe(false);
    expect(b.acquire('a/y')).toBe(true);
    b.reset('a/x');
    expect(b.acquire('a/x')).toBe(true);
  });
  it('rejects a nonsense config', () => {
    expect(() => new CircuitBreaker({ ...cfg, failureThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ ...cfg, halfOpenMaxProbes: 0 })).toThrow(RangeError);
  });
});

describe('health monitor', () => {
  const hc = { windowMs: 60_000, maxSamples: 5, minSamples: 3, healthyPerMille: 900, unhealthyPerMille: 500 };
  it('is unknown with too few samples', () => {
    const { clock } = clockAt();
    const h = new HealthMonitor(hc, clock);
    h.recordSuccess('k', 10);
    expect(h.snapshot('k').status).toBe('unknown');
    expect(h.snapshot('never-seen')).toMatchObject({ status: 'unknown', samples: 0, successPerMille: null, p50LatencyMs: null });
  });
  it('derives healthy / degraded / unhealthy from the success rate, in integers', () => {
    const { clock } = clockAt();
    const h = new HealthMonitor({ ...hc, maxSamples: 100 }, clock);
    for (let i = 0; i < 10; i++) h.recordSuccess('good', 100 + i);
    expect(h.snapshot('good')).toMatchObject({ status: 'healthy', successPerMille: 1000 });
    for (let i = 0; i < 7; i++) h.recordSuccess('mid', 50);
    for (let i = 0; i < 3; i++) h.recordFailure('mid', 'timeout', 5000);
    expect(h.snapshot('mid')).toMatchObject({ status: 'degraded', successPerMille: 700, lastErrorCode: 'timeout' });
    for (let i = 0; i < 2; i++) h.recordSuccess('bad', 50);
    for (let i = 0; i < 4; i++) h.recordFailure('bad', 'unavailable', 10);
    expect(h.snapshot('bad')).toMatchObject({ status: 'unhealthy', successPerMille: 333 });
  });
  it('computes latency percentiles over successful calls only', () => {
    const { clock } = clockAt();
    const h = new HealthMonitor({ ...hc, maxSamples: 100 }, clock);
    for (let i = 1; i <= 20; i++) h.recordSuccess('k', i * 10);
    h.recordFailure('k', 'timeout', 99_999);
    const s = h.snapshot('k');
    expect(s.p50LatencyMs).toBe(100);
    expect(s.p95LatencyMs).toBe(190);
  });
  it('forgets samples outside the window and bounds memory', () => {
    const { clock, advance } = clockAt();
    const h = new HealthMonitor(hc, clock);
    for (let i = 0; i < 10; i++) h.recordFailure('k', 'unavailable', 1);
    expect(h.snapshot('k').samples).toBe(5); // maxSamples
    advance(60_001);
    expect(h.snapshot('k')).toMatchObject({ samples: 0, status: 'unknown' });
    expect(h.snapshot('k').lastErrorCode).toBe('unavailable'); // the last error stays visible for the operator
  });
  it('a caller cancel is not a health sample', () => {
    const { clock } = clockAt();
    const h = new HealthMonitor(hc, clock);
    h.recordFailure('k', 'aborted', 1);
    h.recordFailure('k', 'content_filtered', 1);
    expect(h.snapshot('k').samples).toBe(0);
  });
  it('an open breaker makes the key unhealthy whatever the window says', () => {
    const r = createResilience({ breaker: { failureThreshold: 2, openMs: 10_000, halfOpenMaxProbes: 1 } });
    for (let i = 0; i < 10; i++) r.health.recordSuccess('k', 1);
    r.breaker.failure('k', 'timeout');
    r.breaker.failure('k', 'timeout');
    expect(r.health.snapshot('k')).toMatchObject({ status: 'unhealthy', breaker: 'open' });
    expect(r.health.all().map((s) => s.key)).toEqual(['k']);
  });
});
