import type { Clock } from './clock';

/** Token bucket (docs/09 §1 rule 5): `capacity` burst, `refillPerSecond` sustained. `tryTake` never blocks. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }
  tryTake(n = 1): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';
export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: string | null;
  /** Earliest time a probe call is let through while open. */
  retryAt: string | null;
}

/**
 * Circuit breaker per provider account. `failureThreshold` consecutive provider failures (outage, uncertain, rate-limit storm) open it
 * for `cooldownMs`; then ONE trial call is allowed (half-open): success closes, failure re-opens. State is exposed to the admin console.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  constructor(
    private readonly clock: Clock,
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  /** Returns true when a call may proceed. A half-open breaker admits exactly one trial call at a time. */
  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
        this.trialInFlight = true;
        return true;
      }
      return false;
    }
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }
  success(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }
  failure(): void {
    this.failures += 1;
    this.trialInFlight = false;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.clock.now();
    }
  }
  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      openedAt: this.openedAt === null ? null : new Date(this.openedAt).toISOString(),
      retryAt:
        this.openedAt === null ? null : new Date(this.openedAt + this.cooldownMs).toISOString(),
    };
  }
}
