import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsService } from './operations';
import { ORG_A, ORG_B, createEnv, type TestEnv } from './testing/harness';

let env: TestEnv;
let ops: OperationsService;
beforeAll(async () => {
  env = await createEnv();
  ops = new OperationsService(env.app);
});
afterAll(() => env.close());

// the worker uses the worker-role pool; API-side calls use the app role
const workerOps = () => new OperationsService(env.worker);

describe('operations', () => {
  it('creates an operation and an outbox event atomically; foreign org cannot see it (404 semantics)', async () => {
    const op = await ops.create(ORG_A, { kind: 'test.create', input: { x: 1 } });
    expect(op.state).toBe('pending');
    expect(await ops.get(ORG_A, op.id)).not.toBeNull();
    expect(await ops.get(ORG_B, op.id)).toBeNull();
    expect((await ops.list(ORG_B)).map((o) => o.id)).not.toContain(op.id);
    const ev = await env.sql(
      `SELECT topic FROM platform.outbox WHERE payload->>'operationId' = $1`,
      [op.id],
    );
    expect(ev.map((r) => r.topic)).toContain('operation.created');
  });

  it('two workers claiming concurrently never receive the same operation', async () => {
    for (let i = 0; i < 20; i++) await ops.create(ORG_A, { kind: 'test.claim' });
    const w = workerOps();
    const [a, b] = await Promise.all([
      w.claimDue('w1', { batch: 12 }),
      w.claimDue('w2', { batch: 12 }),
    ]);
    const ids = [...a, ...b].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.every((c) => c.previousState === 'pending')).toBe(true);
    await env.sql(`UPDATE platform.operations SET state='cancelled' WHERE kind='test.claim'`);
  });

  it("operation_lease_expiry_reclaim: a dead worker's operation is reclaimed; waiting_provider becomes needs_reconcile", async () => {
    const run = await ops.create(ORG_A, { kind: 'test.lease.running' });
    const wait = await ops.create(ORG_A, { kind: 'test.lease.waiting' });
    const w = workerOps();
    const first = await w.claimDue('dead', { batch: 100, leaseSeconds: 30 });
    expect(first.map((c) => c.id)).toEqual(expect.arrayContaining([run.id, wait.id]));
    await env.sql(`UPDATE platform.operations SET state='waiting_provider' WHERE id=$1`, [wait.id]);
    expect((await w.claimDue('other')).map((c) => c.id)).not.toContain(run.id); // lease still valid
    await env.sql(
      `UPDATE platform.operations SET lease_expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])`,
      [[run.id, wait.id]],
    );
    const reclaimed = await w.claimDue('rescuer', { batch: 100 });
    const byId = new Map(reclaimed.map((c) => [c.id, c]));
    expect(byId.get(run.id)?.previousState).toBe('running');
    expect((await ops.get(ORG_A, run.id))?.state).toBe('running');
    expect(byId.get(wait.id)?.previousState).toBe('waiting_provider');
    expect((await ops.get(ORG_A, wait.id))?.state).toBe('needs_reconcile');
    await env.sql(`UPDATE platform.operations SET state='cancelled' WHERE id = ANY($1::uuid[])`, [
      [run.id, wait.id],
    ]);
  });

  it('failure retries with backoff until max attempts, then fails terminally', async () => {
    const op = await ops.create(ORG_B, { kind: 'test.retry', maxAttempts: 2 });
    const w = workerOps();
    const [c1] = (await w.claimDue('w', { batch: 100 })).filter((c) => c.id === op.id);
    expect(c1?.attempts).toBe(1);
    const retried = await ops.fail(ORG_B, op.id, 'w', { msg: 'transient' });
    expect(retried.state).toBe('pending');
    expect(new Date(retried.next_run_at).getTime()).toBeGreaterThan(Date.now() + 3000);
    await env.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id=$1`, [op.id]);
    await w.claimDue('w', { batch: 100 });
    const done = await ops.fail(ORG_B, op.id, 'w', { msg: 'permanent' });
    expect(done.state).toBe('failed');
  });

  it('succeeds only for the lease holder and cannot leave a terminal state', async () => {
    const op = await ops.create(ORG_A, { kind: 'test.succeed' });
    const w = workerOps();
    await w.claimDue('holder', { batch: 100 });
    await expect(ops.succeed(ORG_A, op.id, 'thief', {})).rejects.toMatchObject({
      code: 'lease_lost',
    });
    const ok = await ops.succeed(ORG_A, op.id, 'holder', { done: true });
    expect(ok.state).toBe('succeeded');
    await expect(ops.fail(ORG_A, op.id, 'holder', {})).rejects.toThrow();
  });

  it('provider timeout path: running -> needs_reconcile (never blind retry)', async () => {
    const op = await ops.create(ORG_A, { kind: 'test.timeout' });
    await workerOps().claimDue('w', { batch: 100 });
    const parked = await ops.markNeedsReconcile(ORG_A, op.id, 'w', 'provider timeout after create');
    expect(parked.state).toBe('needs_reconcile');
  });

  it('cancellation: pending cancels immediately; running is flagged; terminal returns 409 code', async () => {
    const pending = await ops.create(ORG_A, { kind: 'test.cancel.pending' });
    expect(await ops.requestCancel(ORG_A, pending.id)).toEqual({
      state: 'cancelled',
      accepted: 'cancelled',
    });
    const running = await ops.create(ORG_A, { kind: 'test.cancel.running' });
    await workerOps().claimDue('w', { batch: 100 });
    expect(await ops.requestCancel(ORG_A, running.id)).toMatchObject({ accepted: 'cancelling' });
    await expect(ops.requestCancel(ORG_A, pending.id)).rejects.toMatchObject({
      code: 'operation_not_cancellable',
    });
    await expect(ops.requestCancel(ORG_B, running.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('heartbeat extends a held lease and fails when the lease is not held', async () => {
    const op = await ops.create(ORG_A, { kind: 'test.heartbeat' });
    await workerOps().claimDue('hb', { batch: 100 });
    await ops.heartbeat(ORG_A, op.id, 'hb', 120);
    await expect(ops.heartbeat(ORG_A, op.id, 'someone-else')).rejects.toMatchObject({
      code: 'lease_lost',
    });
  });
});
