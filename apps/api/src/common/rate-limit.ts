/** In-memory sliding-window limiter. NOT VERIFIED for multi-instance: move to Redis once D-03/Redis lands. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Returns true when the call is allowed, false when the limit is exceeded. */
  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
