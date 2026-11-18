import { createHash } from 'node:crypto';
import {
  normalizedError,
  type ErrorCategory,
  type OperationResult,
  type RawEvidence,
} from '../upstream';

export interface Clock {
  now(): number;
}
export class ManualClock implements Clock {
  constructor(private t = Date.parse('2026-11-18T08:00:00.000Z')) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export type FaultKind =
  'timeout_after_side_effect' | 'timeout_before_side_effect' | 'rate_limit' | 'outage';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Canonical JSON (sorted keys) so that checksums do not depend on insertion order. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Shared behaviour of every mock adapter: deterministic clock, fault injection, evidence that is ALWAYS tagged `mock`
 * (so that no result can ever be mistaken for live verification), and the uncertain-result semantics of docs/09 §1 rule 3.
 */
export class MockCore {
  readonly evidenceKind = 'mock' as const;
  private readonly faults = new Map<string, { kind: FaultKind; times: number }[]>();
  protected calls = new Map<string, number>();
  constructor(protected readonly clock: Clock) {}

  inject(op: string, kind: FaultKind, times = 1): void {
    const l = this.faults.get(op) ?? [];
    l.push({ kind, times });
    this.faults.set(op, l);
  }
  callCount(op: string): number {
    return this.calls.get(op) ?? 0;
  }
  protected iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
  protected ev(operation: string, summary: string): RawEvidence {
    return { kind: 'mock', capturedAt: this.iso(), operation, summary };
  }
  private take(op: string): FaultKind | null {
    const l = this.faults.get(op);
    const f = l?.[0];
    if (!l || !f) return null;
    if (--f.times <= 0) l.shift();
    return f.kind;
  }
  protected ok<T>(
    op: string,
    summary: string,
    data?: T,
    providerRef?: string,
    status: 'succeeded' | 'accepted' = 'succeeded',
  ): OperationResult<T> {
    return { status, providerRef, data, raw: this.ev(op, summary) };
  }
  protected fail<T>(
    op: string,
    category: ErrorCategory,
    code: string,
    message: string,
  ): OperationResult<T> {
    return {
      status: 'failed',
      error: normalizedError(category, code, message),
      raw: this.ev(op, `${code}: ${message}`),
    };
  }
  protected uncertain<T>(op: string): OperationResult<T> {
    return {
      status: 'uncertain',
      error: normalizedError('provider_outage', 'TIMEOUT', 'the provider call timed out', true),
      raw: this.ev(op, 'timeout: the effect at the provider is unknown'),
    };
  }
  /** A MUTATING call: a timeout is `uncertain`, a refusal (rate limit/outage) was never applied and is a definitive failure. */
  protected async mutating<T>(
    op: string,
    effect: () => OperationResult<T>,
  ): Promise<OperationResult<T>> {
    this.calls.set(op, (this.calls.get(op) ?? 0) + 1);
    const f = this.take(op);
    if (f === 'outage') return this.fail(op, 'provider_outage', 'OUTAGE', 'provider unavailable');
    if (f === 'rate_limit') return this.fail(op, 'rate_limit', 'RATE_LIMIT', 'too many requests');
    if (f === 'timeout_before_side_effect') return this.uncertain(op);
    const r = effect();
    return f === 'timeout_after_side_effect' ? this.uncertain(op) : r;
  }
  /** A READ: never has an unknown effect; a timeout is a retryable failure. */
  protected async reading<T>(
    op: string,
    effect: () => OperationResult<T>,
  ): Promise<OperationResult<T>> {
    this.calls.set(op, (this.calls.get(op) ?? 0) + 1);
    const f = this.take(op);
    if (f === 'outage' || f === 'timeout_before_side_effect' || f === 'timeout_after_side_effect')
      return this.fail(op, 'provider_outage', 'OUTAGE', 'provider unavailable');
    if (f === 'rate_limit') return this.fail(op, 'rate_limit', 'RATE_LIMIT', 'too many requests');
    return effect();
  }
}
