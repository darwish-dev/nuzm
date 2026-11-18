/**
 * M11 S52: per-connector / per-org rate limiting (token bucket) and a circuit breaker. Pure state machines with an injected clock.
 * State is per process (an instance that restarts starts with a full bucket and a closed circuit); the multi-instance guarantee
 * is therefore NOT VERIFIED and the per-org CONCURRENCY cap, which is enforced in the database, is the hard bound.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }
  /** Take `n` tokens; false when the bucket cannot cover it. */
  take(now = Date.now(), n = 1): boolean {
    const dt = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSecond);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  retryAfterSeconds(now = Date.now(), n = 1): number {
    const dt = Math.max(0, now - this.last) / 1000;
    const have = Math.min(this.capacity, this.tokens + dt * this.refillPerSecond);
    return have >= n ? 0 : Math.max(1, Math.ceil((n - have) / this.refillPerSecond));
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  openSeconds: number;
}
export type BreakerState = 'closed' | 'open' | 'half_open';
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  constructor(private readonly o: BreakerOptions = { failureThreshold: 5, openSeconds: 60 }) {}
  status(now = Date.now()): BreakerState {
    if (this.state === 'open' && now - this.openedAt >= this.o.openSeconds * 1000) this.state = 'half_open';
    return this.state;
  }
  /** May a call go out now? Half-open lets exactly one probe through. */
  allow(now = Date.now()): boolean {
    const s = this.status(now);
    if (s === 'closed') return true;
    if (s === 'half_open') {
      this.state = 'open'; // only one probe: further calls wait for the probe's outcome or the next window
      this.openedAt = now;
      return true;
    }
    return false;
  }
  success(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  failure(now = Date.now()): void {
    this.failures++;
    if (this.state !== 'closed' || this.failures >= this.o.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }
}
