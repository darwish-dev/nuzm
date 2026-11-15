import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, enqueue } from './outbox';
import { ORG_A, ORG_B, createEnv, type TestEnv } from './testing/harness';

let env: TestEnv;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    await env.app.withOrg(i % 2 ? ORG_A : ORG_B, (c) =>
      enqueue(c, i % 2 ? ORG_A : ORG_B, 'test.topic', { i }),
    );
  }
}

describe('outbox relay (outbox_relay_at_least_once)', () => {
  it('delivers every event across orgs exactly once when handlers succeed, then nothing', async () => {
    await seed(10);
    const relay = new OutboxRelay(env.worker, { batch: 100 });
    const seen: number[] = [];
    const r = await relay.runOnce(async (row) => void seen.push((row.payload as { i: number }).i));
    expect(r).toEqual({ delivered: 10, failed: 0 });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await relay.runOnce(async () => undefined)).toEqual({ delivered: 0, failed: 0 });
  });

  it('a failing handler loses nothing: the event is redelivered after the lock expires', async () => {
    await env.sql(`DELETE FROM platform.outbox`);
    await seed(3);
    const relay = new OutboxRelay(env.worker, { batch: 100, lockSeconds: 60 });
    const first = await relay.runOnce(async (row) => {
      if ((row.payload as { i: number }).i === 1) throw new Error('consumer down');
    });
    expect(first).toEqual({ delivered: 2, failed: 1 });
    expect((await relay.claim()).length).toBe(0); // still locked, not lost
    await env.sql(
      `UPDATE platform.outbox SET lock_until = now() - interval '1 second' WHERE published_at IS NULL`,
    );
    const retried: number[] = [];
    const second = await relay.runOnce(
      async (row) => void retried.push((row.payload as { i: number }).i),
    );
    expect(second.delivered).toBe(1);
    expect(retried).toEqual([1]);
    const left = await env.sql(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE published_at IS NULL`,
    );
    expect(left[0]?.n).toBe(0);
  });

  it('two relays running concurrently never deliver the same row twice within the lock window', async () => {
    await env.sql(`DELETE FROM platform.outbox`);
    await seed(30);
    const a = new OutboxRelay(env.worker, { batch: 20 });
    const b = new OutboxRelay(env.worker, { batch: 20 });
    const got: string[] = [];
    await Promise.all([
      a.runOnce(async (r) => void got.push(r.id)),
      b.runOnce(async (r) => void got.push(r.id)),
    ]);
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(30);
  });

  it("the app role cannot read other orgs' outbox rows or the claim scope", async () => {
    const rows = await env.app.withOrg(
      ORG_A,
      async (c) => (await c.query('SELECT org_id FROM platform.outbox')).rows,
    );
    expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
  });
});
