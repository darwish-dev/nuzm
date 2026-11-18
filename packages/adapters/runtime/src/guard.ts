import {
  AdapterTimeoutError,
  normalizedError,
  type AccountContext,
  type ComputeAdapter,
  type OperationResult,
  type RawEvidence,
  type Redactor,
} from '@nuzm/adapter-contracts';
import type { Clock } from './clock';
import { CircuitBreaker, TokenBucket, type BreakerSnapshot } from './limits';

export interface GuardOptions {
  clock: Clock;
  redactor: Redactor;
  /** Burst and sustained calls per second per provider account (docs/09 §1 rule 5). */
  rate?: { burst: number; perSecond: number };
  breaker?: { failureThreshold: number; cooldownMs: number };
}

const notSent = <T>(
  clock: Clock,
  code: string,
  message: string,
  category: 'rate_limit' | 'provider_outage',
): OperationResult<T> => ({
  status: 'failed',
  error: normalizedError(category, code, message, true),
  raw: {
    kind: 'mock',
    capturedAt: new Date(clock.now()).toISOString(),
    summary: `${code}: call was not sent`,
  },
});

/**
 * Framework wrapper applied to every ComputeAdapter (docs/09 §1 rules 1, 3, 5): per-account token bucket + circuit breaker, redaction of
 * all evidence, and conversion of thrown errors into normalized results — a timeout during a MUTATING call is `uncertain` (the effect is
 * unknown), never `failed`. A call refused by the limiter/breaker was never sent, so its `failed` result is definitive.
 */
export class GuardedCompute {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(private readonly opts: GuardOptions) {}

  breakerSnapshot(accountId: string): BreakerSnapshot {
    return this.breaker(accountId).snapshot();
  }
  /** Health probes feed the same breaker as operations: an unhealthy report counts as a failure, a healthy one closes it. */
  noteHealth(accountId: string, healthy: boolean): void {
    const b = this.breaker(accountId);
    if (healthy) b.success();
    else b.failure();
  }
  private breaker(id: string): CircuitBreaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = new CircuitBreaker(
        this.opts.clock,
        this.opts.breaker?.failureThreshold,
        this.opts.breaker?.cooldownMs,
      );
      this.breakers.set(id, b);
    }
    return b;
  }
  private bucket(id: string): TokenBucket {
    let b = this.buckets.get(id);
    if (!b) {
      const r = this.opts.rate ?? { burst: 20, perSecond: 10 };
      b = new TokenBucket(r.burst, r.perSecond, this.opts.clock);
      this.buckets.set(id, b);
    }
    return b;
  }

  private scrub<T>(r: OperationResult<T>): OperationResult<T> {
    const rd = this.opts.redactor;
    const raw: RawEvidence = rd.deep(r.raw);
    const error = r.error ? rd.scrubValues(r.error) : undefined;
    return {
      ...r,
      raw,
      ...(r.providerRef !== undefined ? { providerRef: rd.string(r.providerRef) } : {}),
      ...(r.data !== undefined ? { data: rd.scrubValues(r.data) } : {}),
      ...(error ? { error } : {}),
    };
  }

  private async run<T>(
    ctx: AccountContext,
    mutating: boolean,
    call: () => Promise<OperationResult<T>>,
  ): Promise<OperationResult<T>> {
    const br = this.breaker(ctx.providerAccountId);
    if (!br.allow())
      return notSent<T>(
        this.opts.clock,
        'circuit_open',
        'circuit breaker is open for this account',
        'provider_outage',
      );
    if (!this.bucket(ctx.providerAccountId).tryTake())
      return notSent<T>(
        this.opts.clock,
        'local_rate_limit',
        'account rate limit reached',
        'rate_limit',
      );
    try {
      const r = await call();
      if (
        r.status === 'uncertain' ||
        (r.status === 'failed' && r.error?.category === 'provider_outage')
      )
        br.failure();
      else br.success();
      return this.scrub(r);
    } catch (e) {
      br.failure();
      const msg = this.opts.redactor.string((e as Error).message ?? 'error');
      const raw: RawEvidence = {
        kind: 'mock',
        capturedAt: new Date(this.opts.clock.now()).toISOString(),
        summary: msg.slice(0, 500),
      };
      if (e instanceof AdapterTimeoutError || (e as Error).name === 'AdapterTimeoutError')
        return mutating
          ? {
              status: 'uncertain',
              error: normalizedError('provider_outage', 'timeout', msg, true),
              raw,
            }
          : {
              status: 'failed',
              error: normalizedError('provider_outage', 'timeout', msg, true),
              raw,
            };
      return {
        status: mutating ? 'uncertain' : 'failed',
        error: normalizedError('unknown', 'exception', msg, false),
        raw,
      };
    }
  }

  /** Returns a ComputeAdapter whose operation methods are guarded; probe/health/catalog/list* pass through (read-only; callers redact their evidence). */
  wrap(a: ComputeAdapter): ComputeAdapter {
    const run = this.run.bind(this);
    const out: ComputeAdapter = {
      id: a.id,
      kind: a.kind,
      contractVersion: a.contractVersion,
      probe: (c) => a.probe(c),
      health: (c) => a.health(c),
      catalog: (c) => a.catalog(c),
      listRegions: (c) => a.listRegions(c),
      listPlans: (c, r) => a.listPlans(c, r),
      listImages: (c, r) => a.listImages(c, r),
      quote: (c, r) => a.quote(c, r),
      provision: (c, r) => run(c, true, () => a.provision(c, r)),
      inspect: (c, ref) => run(c, false, () => a.inspect(c, ref)),
      findByToken: (c, t) => run(c, false, () => a.findByToken(c, t)),
      delete: (c, ref) => run(c, true, () => a.delete(c, ref)),
    };
    if (a.act) out.act = (c, ref, act, p) => run(c, true, () => a.act!(c, ref, act, p));
    if (a.metrics) out.metrics = (c, ref, w) => run(c, false, () => a.metrics!(c, ref, w));
    if (a.fetchBilling) out.fetchBilling = (c, p) => a.fetchBilling!(c, p);
    return out;
  }
}
