import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeTx } from './db';
import { ORG_A, createEnv, type TestEnv } from './testing/harness';

/**
 * Regression (found by the browser tests, 2026-11-25): a connection that broke while a transaction HELD it emitted 'error' on the client, nothing listened, and Node
 * ended the whole API process. `pool.on('error')` covers idle connections only.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(() => env.close());

const pause = () => new Promise((r) => setTimeout(r, 300));
const one = () =>
  env.app.withoutScope(async (c) => (await c.query('SELECT 1 AS one')).rows[0].one as number);

describe('a database connection that breaks while checked out (real PostgreSQL)', () => {
  it('between two queries: fails that transaction only, and the next one gets a working connection', async () => {
    await expect(
      env.app.withoutScope(async (c) => {
        const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        await env.sql('SELECT pg_terminate_backend($1)', [pid]);
        await pause(); // the break arrives while no query is in flight: only an 'error' event can report it
        await c.query('SELECT 1');
      }),
    ).rejects.toThrow();
    await expect(one()).resolves.toBe(1);
  });

  it('while the work is outside the database, even if it then returns normally, the transaction is reported failed', async () => {
    await expect(
      env.app.withoutScope(async (c) => {
        const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        await env.sql('SELECT pg_terminate_backend($1)', [pid]);
        await pause();
        return 'done';
      }),
    ).rejects.toThrow();
    await expect(one()).resolves.toBe(1);
  });

  const append = (c: { query: (q: string, v?: unknown[]) => Promise<unknown> }, action: string) =>
    c.query(
      `INSERT INTO audit.audit_logs (id, actor_type, actor_user_id, org_id, action, outcome, detail)
       VALUES (gen_random_uuid(), 'system', NULL, $1, $2, 'success', '{}')`,
      [ORG_A, action],
    );
  const written = async (action: string) =>
    (
      await env.sql(`SELECT count(*)::int AS n FROM audit.audit_logs WHERE action = $1`, [action])
    )[0]!.n as number;
  const kill = async (c: {
    query: (q: string) => Promise<{ rows: Record<string, unknown>[] }>;
  }) => {
    const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
    await env.sql('SELECT pg_terminate_backend($1)', [pid]);
    await pause();
  };

  it('integrity: nothing a broken transaction wrote is committed, whether more work follows or only COMMIT is left', async () => {
    // the break is followed by more work
    await expect(
      env.app.withOrg(ORG_A, async (c) => {
        await append(c, 'test.broken.midway');
        await kill(c);
        await append(c, 'test.broken.midway');
      }),
    ).rejects.toThrow();
    // the break comes after the last statement: only COMMIT remains, so success must NOT be reported to the caller
    let reportedSuccess = false;
    await env.app
      .withOrg(ORG_A, async (c) => {
        await append(c, 'test.broken.before_commit');
        await kill(c);
      })
      .then(() => (reportedSuccess = true))
      .catch(() => undefined);
    expect(reportedSuccess).toBe(false);
    expect(await written('test.broken.midway')).toBe(0);
    expect(await written('test.broken.before_commit')).toBe(0);
    // and the same write succeeds, once, on the next request; the tenant context is applied again on the new connection
    await env.app.withOrg(ORG_A, (c) => append(c, 'test.after.recovery'));
    expect(await written('test.after.recovery')).toBe(1);
    expect(
      await env.app.withOrg(
        ORG_A,
        async (c) => (await c.query(`SELECT current_setting('app.org_id') AS o`)).rows[0].o,
      ),
    ).toBe(ORG_A);
    expect(activeTx()).toBeUndefined();
  });

  it('recovery: more broken transactions than the pool has connections leak no slot, and later requests are served', async () => {
    const rounds = (env.app.pool.options.max ?? 10) + 5;
    for (let i = 0; i < rounds; i++)
      await expect(
        env.app.withoutScope(async (c) => {
          await kill(c);
          await c.query('SELECT 1');
        }),
      ).rejects.toThrow();
    const results = await Promise.all(Array.from({ length: 30 }, () => one()));
    expect(results).toEqual(Array(30).fill(1));
    expect(env.app.pool.totalCount).toBeLessThanOrEqual(env.app.pool.options.max ?? 10);
    expect(env.app.pool.waitingCount).toBe(0);
    expect(env.app.pool.idleCount).toBe(env.app.pool.totalCount);
  });

  it('isolation: transactions running beside a broken one commit normally', async () => {
    const [broken, ...others] = await Promise.allSettled([
      env.app.withOrg(ORG_A, async (c) => {
        await append(c, 'test.concurrent.broken');
        await kill(c);
        await c.query('SELECT 1');
      }),
      ...Array.from({ length: 5 }, () =>
        env.app.withOrg(ORG_A, async (c) => {
          await append(c, 'test.concurrent.healthy');
          await pause();
        }),
      ),
    ]);
    expect(broken!.status).toBe('rejected');
    expect(others.map((o) => o.status)).toEqual(Array(5).fill('fulfilled'));
    expect(await written('test.concurrent.healthy')).toBe(5);
    expect(await written('test.concurrent.broken')).toBe(0);
  });

  it('leaves no listener behind on a healthy connection that is reused', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 5; i++)
      await env.app.withoutScope(async (c) => {
        counts.push((c as unknown as { listenerCount(e: string): number }).listenerCount('error'));
      });
    expect(new Set(counts).size).toBe(1);
  });
});
