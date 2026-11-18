/** Injectable time source: production uses the system clock, tests and the mock adapter a deterministic simulated one. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export class SimClock implements Clock {
  constructor(private t: number = Date.parse('2026-01-01T00:00:00Z')) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): number {
    if (ms < 0) throw new RangeError('time only moves forward');
    this.t += ms;
    return this.t;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Tracks wall-clock time plus an offset that tests can advance: the simulator's clock in a running dev stack (timestamps stay current). */
export class OffsetClock extends SimClock {
  private offset = 0;
  override now(): number {
    return Date.now() + this.offset;
  }
  override advance(ms: number): number {
    if (ms < 0) throw new RangeError('time only moves forward');
    this.offset += ms;
    return this.now();
  }
}
