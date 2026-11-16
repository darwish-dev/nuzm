import { describe, expect, it } from 'vitest';
import { makeAuditJob } from './audit-job';

const report = (ok: boolean) => ({ chainKey: 'c', ok, checked: 1, checkpointsVerified: 0 });

describe('makeAuditJob', () => {
  it('runs at most once per interval and reports broken chains without hiding them', async () => {
    let t = 0;
    let runs = 0;
    const broken: unknown[][] = [];
    const logs: string[] = [];
    const job = makeAuditJob(
      {
        runOnce: async () => (
          runs++,
          { chains: [report(true), report(runs > 1)], checkpointed: 1 }
        ),
      },
      { everyMs: 1000, now: () => t, onBroken: (b) => broken.push(b), log: (m) => logs.push(m) },
    );
    await job();
    expect(runs).toBe(1);
    expect(broken).toHaveLength(1); // second chain ok=false on the first run (runs === 1 → ok false)
    await job();
    expect(runs).toBe(1); // inside the interval
    t = 1000;
    await job();
    expect(runs).toBe(2);
    expect(broken).toHaveLength(1); // second run is healthy
    expect(logs.every((m) => m === 'audit_verified')).toBe(true);
  });

  it('a failing run propagates (the loop reports it) and is retried at the next interval', async () => {
    let t = 0;
    let n = 0;
    const job = makeAuditJob(
      {
        runOnce: async () => {
          n++;
          if (n === 1) throw new Error('db down');
          return { chains: [], checkpointed: 0 };
        },
      },
      { everyMs: 10, now: () => t, onBroken: () => undefined, log: () => undefined },
    );
    await expect(job()).rejects.toThrow('db down');
    t = 10;
    await expect(job()).resolves.toBeUndefined();
  });
});
