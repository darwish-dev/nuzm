import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type TestEnv } from './testing/harness';

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

  it('leaves no listener behind on a healthy connection that is reused', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 5; i++)
      await env.app.withoutScope(async (c) => {
        counts.push((c as unknown as { listenerCount(e: string): number }).listenerCount('error'));
      });
    expect(new Set(counts).size).toBe(1);
  });
});
