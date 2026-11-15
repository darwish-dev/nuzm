import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyService, requestHash } from './idempotency';
import { ORG_A, ORG_B, createEnv, type TestEnv } from './testing/harness';

let env: TestEnv;
let svc: IdempotencyService;
beforeAll(async () => {
  env = await createEnv();
  svc = new IdempotencyService(env.app);
});
afterAll(() => env.close());

const h = (body: unknown) => requestHash('POST', '/v1/things', body);

describe('Idempotency-Key', () => {
  it('replays the original response and runs the side effect once', async () => {
    let calls = 0;
    const exec = async () => ({ status: 201, body: { id: ++calls } });
    const first = await svc.run(ORG_A, 'k-replay', h({ a: 1 }), exec);
    const second = await svc.run(ORG_A, 'k-replay', h({ a: 1 }), exec);
    expect(first).toMatchObject({ status: 201, body: { id: 1 }, replayed: false });
    expect(second).toMatchObject({ status: 201, body: { id: 1 }, replayed: true });
    expect(calls).toBe(1);
  });

  it('rejects the same key with a changed body (idempotency_conflict_on_changed_body)', async () => {
    await svc.run(ORG_A, 'k-conflict', h({ a: 1 }), async () => ({ status: 201, body: {} }));
    await expect(
      svc.run(ORG_A, 'k-conflict', h({ a: 2 }), async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({
      code: 'idempotency_key_reuse',
    });
  });

  it('scopes keys per org: the same key in another org is independent', async () => {
    let calls = 0;
    const exec = async () => ({ status: 201, body: { n: ++calls } });
    await svc.run(ORG_A, 'k-scope', h(1), exec);
    const b = await svc.run(ORG_B, 'k-scope', h(1), exec);
    expect(b.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('50 parallel requests with one key produce exactly one effect', async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return { status: 201, body: { ok: true } };
    };
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => svc.run(ORG_A, 'k-parallel', h('p'), exec)),
    );
    expect(calls).toBe(1);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(
      rejected.every((r) => (r.reason as { code: string }).code === 'idempotency_in_progress'),
    ).toBe(true);
    // after completion every retry replays the stored response
    const again = await svc.run(ORG_A, 'k-parallel', h('p'), exec);
    expect(again).toMatchObject({ replayed: true, body: { ok: true } });
    expect(calls).toBe(1);
  });

  it('releases the key when the handler throws so the client can retry', async () => {
    await expect(
      svc.run(ORG_A, 'k-fail', h('f'), async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const retry = await svc.run(ORG_A, 'k-fail', h('f'), async () => ({
      status: 201,
      body: { ok: 1 },
    }));
    expect(retry.replayed).toBe(false);
  });

  it('re-executes after the key has expired', async () => {
    await svc.run(ORG_A, 'k-exp', h('e'), async () => ({ status: 201, body: { v: 1 } }));
    await env.sql(
      `UPDATE platform.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE key = 'k-exp'`,
    );
    const r = await svc.run(ORG_A, 'k-exp', h('e'), async () => ({ status: 201, body: { v: 2 } }));
    expect(r).toMatchObject({ replayed: false, body: { v: 2 } });
  });

  it('rejects an empty or oversized key', async () => {
    await expect(
      svc.run(ORG_A, '', h(0), async () => ({ status: 200, body: null })),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      svc.run(ORG_A, 'x'.repeat(256), h(0), async () => ({ status: 200, body: null })),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
