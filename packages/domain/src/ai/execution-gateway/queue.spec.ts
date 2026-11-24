import { describe, expect, it } from 'vitest';
import { ExecutionQueue, DEFAULT_QUEUE_CONFIG, type QueueConfig } from './index';

let t = 0;
const mk = (cfg: Partial<QueueConfig> = {}) =>
  new ExecutionQueue<string>({ ...DEFAULT_QUEUE_CONFIG, ...cfg }, () => t);
const add = (q: ExecutionQueue<string>, org: string, n: string) =>
  q.enqueue({ orgId: org, runId: `run-${n}`, idempotencyKey: `key-${org}-${n}`, payload: n });
const must = (r: ReturnType<ExecutionQueue<string>['enqueue']>) => {
  if (!r.ok) throw new Error('expected ok');
  return r;
};
const allow = () => 5;

describe('ExecutionQueue', () => {
  it('is idempotent per organization and key', () => {
    t = 0;
    const q = mk();
    const a = add(q, 'o1', 'aaaaaaaa');
    const b = add(q, 'o1', 'aaaaaaaa');
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(q.depth()).toBe(1);
    // the same key in another organization is a different job
    expect(
      q.enqueue({ orgId: 'o2', runId: 'r', idempotencyKey: 'key-o1-aaaaaaaa', payload: 'x' }),
    ).toMatchObject({ duplicate: false });
  });
  it('rejects malformed idempotency keys', () => {
    const q = mk();
    for (const k of ['', 'short', 'has space here', 'a'.repeat(200)])
      expect(q.enqueue({ orgId: 'o', runId: 'r', idempotencyKey: k, payload: 'x' })).toEqual({
        ok: false,
        reason: 'idempotency_key_invalid',
      });
  });
  it('bounds the depth per organization and in total', () => {
    const q = mk({ maxDepthPerOrg: 2, maxDepthTotal: 3 });
    add(q, 'o1', 'a1a1a1a1');
    add(q, 'o1', 'a2a2a2a2');
    expect(add(q, 'o1', 'a3a3a3a3')).toEqual({ ok: false, reason: 'org_depth_ceiling' });
    add(q, 'o2', 'b1b1b1b1');
    expect(add(q, 'o3', 'c1c1c1c1')).toEqual({ ok: false, reason: 'total_depth_ceiling' });
  });
  it('is FIFO within an organization and round-robin across organizations', () => {
    t = 0;
    const q = mk();
    for (const n of ['a1a1a1a1', 'a2a2a2a2', 'a3a3a3a3']) {
      add(q, 'A', n);
      t++;
    }
    add(q, 'B', 'b1b1b1b1');
    t++;
    add(q, 'B', 'b2b2b2b2');
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      const j = q.claim('w', () => 10)!;
      order.push(j.payload);
      q.complete(j.id, j.lease!.token, 'succeeded');
    }
    expect(order).toEqual(['a1a1a1a1', 'b1b1b1b1', 'a2a2a2a2', 'b2b2b2b2', 'a3a3a3a3']);
  });
  it('skips an organization at its concurrency allowance so it cannot block others', () => {
    t = 0;
    const q = mk();
    add(q, 'A', 'a1a1a1a1');
    add(q, 'A', 'a2a2a2a2');
    add(q, 'B', 'b1b1b1b1');
    const limit = (o: string) => (o === 'A' ? 1 : 5);
    const first = q.claim('w1', limit)!;
    expect(first.orgId).toBe('A');
    const second = q.claim('w2', limit)!;
    expect(second.orgId).toBe('B');
    expect(q.claim('w3', limit)).toBeNull(); // A is saturated, nothing else waits
    q.complete(first.id, first.lease!.token, 'succeeded');
    expect(q.claim('w3', limit)!.payload).toBe('a2a2a2a2');
  });
  it('only the lease holder completes; a stale worker is refused after a requeue', () => {
    t = 0;
    const q = mk({ leaseMs: 1000 });
    const j = must(add(q, 'o', 'a1a1a1a1')).job;
    const c1 = q.claim('w1', allow)!;
    const stale = c1.lease!.token;
    expect(q.complete(j.id, 'forged', 'succeeded')).toEqual({
      ok: false,
      reason: 'not_the_lease_holder',
    });
    t = 2000;
    expect(q.sweep().requeued).toEqual([j.id]);
    const c2 = q.claim('w2', allow)!;
    expect(c2.attempts).toBe(2);
    expect(q.complete(j.id, stale, 'succeeded')).toEqual({
      ok: false,
      reason: 'not_the_lease_holder',
    });
    expect(q.complete(j.id, c2.lease!.token, 'succeeded')).toEqual({ ok: true });
  });
  it('fails a job whose lease expired too many times (never retried forever)', () => {
    t = 0;
    const q = mk({ leaseMs: 100, maxAttempts: 2 });
    const j = must(add(q, 'o', 'a1a1a1a1')).job;
    q.claim('w', allow);
    t = 200;
    q.sweep();
    q.claim('w', allow);
    t = 400;
    expect(q.sweep().failed).toEqual([j.id]);
    expect(q.get(j.id)!.state).toBe('failed');
  });
  it('heartbeats extend the lease', () => {
    t = 0;
    const q = mk({ leaseMs: 1000 });
    const j = must(add(q, 'o', 'a1a1a1a1')).job;
    const c = q.claim('w', allow)!;
    t = 900;
    expect(q.heartbeat(j.id, c.lease!.token)).toBe(true);
    t = 1500;
    expect(q.sweep()).toEqual({ expired: [], requeued: [], failed: [] });
    expect(q.heartbeat(j.id, 'nope')).toBe(false);
  });
  it('expires jobs that waited too long', () => {
    t = 0;
    const q = mk({ maxWaitMs: 1000 });
    const j = must(add(q, 'o', 'a1a1a1a1')).job;
    t = 1000;
    expect(q.claim('w', allow)).toBeNull();
    expect(q.get(j.id)!.state).toBe('expired');
  });
  it('cancel works only for the owning organization and only while queued', () => {
    t = 0;
    const q = mk();
    const j = must(add(q, 'o1', 'a1a1a1a1')).job;
    expect(q.cancel(j.id, 'o2')).toBe(false);
    expect(q.cancel(j.id, 'o1')).toBe(true);
    expect(q.cancel(j.id, 'o1')).toBe(false);
    const k = must(add(q, 'o1', 'a2a2a2a2')).job;
    q.claim('w', allow);
    expect(q.cancel(k.id, 'o1')).toBe(false);
  });
  it('terminateAll ends queued and running jobs (the kill switch), scoped to one organization when asked', () => {
    t = 0;
    const q = mk();
    add(q, 'o1', 'a1a1a1a1');
    add(q, 'o2', 'b1b1b1b1');
    q.claim('w', allow);
    expect(q.terminateAll('o1')).toHaveLength(1);
    expect(q.depth('o2')).toBe(1);
    expect(q.terminateAll()).toHaveLength(1);
    expect(q.claim('w', allow)).toBeNull();
  });
});
