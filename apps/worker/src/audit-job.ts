import type { AuditIntegrity, ChainReport } from '@nuzm/platform';

/**
 * Periodic audit integrity job: verifies every hash chain and signs fresh checkpoints. It runs at most once per
 * `everyMs` even though the worker loop ticks faster. A broken chain is reported loudly (error log + the
 * `onBroken` hook for the alerting integration) and is never "repaired": the evidence must stay as found.
 */
export function makeAuditJob(
  integrity: Pick<AuditIntegrity, 'runOnce'>,
  opts: {
    everyMs: number;
    onBroken: (broken: ChainReport[]) => void;
    log: (m: string, x?: Record<string, unknown>) => void;
    now?: () => number;
  },
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    if (now() - last < opts.everyMs) return;
    last = now();
    const r = await integrity.runOnce();
    const broken = r.chains.filter((c) => !c.ok);
    opts.log('audit_verified', {
      chains: r.chains.length,
      checkpointed: r.checkpointed,
      broken: broken.length,
    });
    if (broken.length) opts.onBroken(broken);
  };
}
