import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { BudgetService, GatewayService, withDeadlockRetry } from './index';
import { setupAiEnv, type AiEnv } from './testing/ai-harness';

/**
 * DEFECT-7 (Session 07): calls of ONE run in flight together deadlocked (reserve locked balance → run, settle locked run → balance); a settle that lost left the wallet debited with no
 * usage row. DEFECT-8: one call id sent many times at once reached the provider many times. Mock provider, real PostgreSQL; nothing leaves the process.
 */
let e: AiEnv;
let gw: GatewayService;
let budgets: BudgetService;
const A = () => e.org.A!;
const call = (over: object = {}) => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: [{ role: 'user' as const, content: 'hello bakery' }],
  maxTokens: 40,
  callId: `c-${uuidv7()}`,
  ...over,
});
const newRun = async () => {
  const id = uuidv7();
  await e.sql(
    `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1,$2,'t','SA') ON CONFLICT DO NOTHING`,
    [id, A()],
  );
  await e.sql(
    `INSERT INTO ai.runs (id, org_id, session_id, kind, data_region, budget) VALUES ($1,$2,$1,'chat','SA','{}')`,
    [id, A()],
  );
  return id;
};
const held = async () =>
  Number((await e.sql(`SELECT count(*)::int n FROM ai.reservations WHERE state='held'`))[0]!.n);
const only = (code: string) =>
  e.sql(
    `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code<>$1 AND enabled`,
    [code],
  );

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
  budgets = e.app.get(BudgetService);
  await e.fund(A(), '1000000000');
}, 300_000);
afterAll(() => e.h.close());

describe('DEFECT-7: parallel calls of one run reconcile exactly', () => {
  it('60 calls over 6 runs, 10 in flight per run: every call succeeds; usage = wallet debit = run spend; nothing stays held', async () => {
    const adapter = new MockModelAdapter({
      id: 'mock-conc',
      handler: () => 'w'.repeat(4 * 25),
    });
    adapter.delayMs = 5;
    await e.enableMock('mock-conc', { rate: ['1000000', '1000000'], adapter });
    await only('mock-conc');
    const runs = await Promise.all(Array.from({ length: 6 }, newRun));
    const walletBefore = await e.wallet(A());
    const results = await Promise.allSettled(
      runs.flatMap((runId) => Array.from({ length: 10 }, () => gw.invoke(call({ runId })))),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    expect(
      failed.map((r) => String((r as PromiseRejectedResult).reason)),
      'no call may fail',
    ).toEqual([]);
    const usage = (
      await e.sql(
        `SELECT count(*)::int n, coalesce(sum(credits),0)::text cr FROM ai.model_usage WHERE org_id=$1 AND provider_code='mock-conc' AND outcome='ok'`,
        [A()],
      )
    )[0]!;
    expect(usage.n).toBe(60);
    // 1 credit = 1 minor unit here: the wallet fell by exactly the credits the usage rows record, call by call in total
    expect(walletBefore - (await e.wallet(A()))).toBe(BigInt(usage.cr as string));
    // the per-run counters agree with the usage rows (the run cap counts every call)
    for (const runId of runs) {
      const r = (
        await e.sql(
          `SELECT spent_credits::text s, reserved_credits::text r,
                  (SELECT coalesce(sum(credits),0)::text FROM ai.model_usage WHERE run_id = ai.runs.id) u
             FROM ai.runs WHERE id=$1`,
          [runId],
        )
      )[0]!;
      expect(r.s).toBe(r.u);
      expect(r.r).toBe('0');
    }
    expect(await held()).toBe(0);
    const bal = (
      await e.sql(`SELECT reserved_credits::text r FROM ai.credit_balances WHERE org_id=$1`, [A()])
    )[0]!;
    expect(bal.r).toBe('0');
  });
});

describe('withDeadlockRetry', () => {
  it('reruns a transaction PostgreSQL aborted for a deadlock or serialization failure, and nothing else', async () => {
    let n = 0;
    expect(
      await withDeadlockRetry(async () => {
        if (++n < 3) throw Object.assign(new Error('x'), { code: '40P01' });
        return 'ok';
      }),
    ).toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    await expect(
      withDeadlockRetry(async () => {
        m++;
        throw Object.assign(new Error('x'), { code: '23505' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(m).toBe(1);
    let k = 0;
    await expect(
      withDeadlockRetry(async () => {
        k++;
        throw Object.assign(new Error('x'), { code: '40001' });
      }, 3),
    ).rejects.toMatchObject({ code: '40001' }); // the last failure is thrown, never swallowed
    expect(k).toBe(3);
  });
});

describe('DEFECT-8: one call id, one provider invocation', () => {
  it('the same call id sent 12 times at once reaches the provider once; one answer, the rest are refused as in progress; charged once', async () => {
    const adapter = new MockModelAdapter({ id: 'mock-conc', handler: () => 'w'.repeat(4 * 25) });
    adapter.delayMs = 150; // long enough for every duplicate to arrive while the first is in flight
    e.registry.register('mock-conc', adapter);
    const callId = `dup-${uuidv7()}`;
    const walletBefore = await e.wallet(A());
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => gw.invoke(call({ callId }))),
    );
    expect(adapter.calls.length).toBe(1);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(11);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'conflict' });
    expect((refused[0]!.reason as { detail?: string }).detail).toContain('call_in_progress');
    const usage = await e.sql(
      `SELECT credits::text c FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`,
      [A(), callId],
    );
    expect(usage).toHaveLength(1);
    expect(walletBefore - (await e.wallet(A()))).toBe(BigInt(usage[0]!.c as string));
    expect(await held()).toBe(0);
  });

  it('a claim that is older than any live call can be (a crashed worker) is taken over without a second hold; a fresh claim is refused', async () => {
    const callId = `crash-${uuidv7()}`;
    const first = await budgets.reserve({ orgId: A(), callId, credits: 50n, tokens: 100n });
    await expect(
      budgets.reserve({ orgId: A(), callId, credits: 50n, tokens: 100n }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // age the claim beyond the window of a live call (call timeout x attempts + backoff + margin)
    await e.sql(`UPDATE ai.reservations SET created_at = now() - interval '1 hour' WHERE id=$1`, [
      first.id,
    ]);
    const again = await budgets.reserve({ orgId: A(), callId, credits: 50n, tokens: 100n });
    expect(again.id).toBe(first.id);
    const n = (
      await e.sql(`SELECT count(*)::int n FROM ai.reservations WHERE org_id=$1 AND call_id=$2`, [
        A(),
        callId,
      ])
    )[0]!;
    expect(n.n).toBe(1);
    await budgets.release(A(), first.id);
    expect(await held()).toBe(0);
  });
});
