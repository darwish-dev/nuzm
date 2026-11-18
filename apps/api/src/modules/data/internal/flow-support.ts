import type { OperationResult } from '@nuzm/adapter-data';
import type { DataConfig } from './model';

/** A provider outcome the flow has to act on. */
export type Outcome<T> =
  | { kind: 'ok'; ref: string | undefined; data: T | undefined }
  | { kind: 'uncertain' }
  | { kind: 'failed'; code: string; message: string; unsupported: boolean; retryable: boolean };

export function outcomeOf<T>(r: OperationResult<T>): Outcome<T> {
  if (r.status === 'succeeded' || r.status === 'accepted')
    return { kind: 'ok', ref: r.providerRef, data: r.data };
  if (r.status === 'uncertain') return { kind: 'uncertain' };
  return {
    kind: 'failed',
    code: r.error?.providerCode ?? 'UNKNOWN',
    message: (r.error?.message ?? 'the provider refused the request').slice(0, 200),
    unsupported: r.error?.category === 'unsupported',
    retryable: r.error?.retryable === true,
  };
}

/**
 * A call that PROVABLY did not happen (a definitive `failed` with a retryable category: rate limit or outage) is retried here a bounded number of
 * times. `uncertain` is never retried here: that is the reconciler's decision (docs/09 §1 rule 3).
 */
export async function retryTransient<T>(
  cfg: DataConfig,
  call: () => Promise<OperationResult<T>>,
): Promise<OperationResult<T>> {
  let r = await call();
  for (let i = 0; i < cfg.transientRetries && r.status === 'failed' && r.error?.retryable; i++) {
    if (cfg.transientRetryDelayMs > 0)
      await new Promise((res) => setTimeout(res, cfg.transientRetryDelayMs * (i + 1)));
    r = await call();
  }
  return r;
}

/** Thrown inside a flow to stop with a definitive failure (instance/backup marked failed, operation failed permanently). */
export class FlowFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FlowFailure';
  }
}
/** Thrown inside a flow to park the operation for the reconciler: the effect at the provider (or the vault) is unknown. */
export class FlowUncertain extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'FlowUncertain';
  }
}
