import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { MockModelAdapter, ModelAdapterError } from '@nuzm/adapter-model';
import { BudgetService, GatewayService } from '../modules/ai';
import {
  CANARY_A,
  CANARY_B,
  setupAiEnv,
  type AiEnv,
  type Row,
} from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA), Phase 2 - dynamic integrity of money and audit under the AI flows, on the REAL hash-chained audit sink (own Postgres, in-process server).
 * Evidence class: SIMULATED model (MockModelAdapter, dev-reference provider). Nothing here says anything about a real provider, a real price or a real charge.
 *
 *  1. duplicate-charge prevention: a replayed / concurrently repeated call id is charged once; the provider is also called once
 *  2. reconciliation after a concurrent mixed workload: usage = ledger = wallet, no reservation left open, every ledger transaction balanced
 *  3. the audit chain under concurrency: no gap, no fork, time never goes backwards, every chain verifies, no secret or prompt body in any audit row
 *  4. tamper detection through the verifier (database-level attacker) and what the RUNTIME roles cannot do to the audit tables
 */
let e: AiEnv;
let gw: GatewayService;
let budgets: BudgetService;
const A = () => e.org.A!;
const msg = (content: string) => [{ role: 'user' as const, content }];
const call = (over: Partial<Parameters<GatewayService['invoke']>[0]> = {}) => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: msg('hello bakery'),
  maxTokens: 40,
  callId: `c-${uuidv7()}`,
  ...over,
});
const num = async (sql: string, args: unknown[] = []) => Number((await e.sql(sql, args))[0]!.n);
const verify = async (chain: string) =>
  (
    await e.h.env.worker.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM audit.verify_chain($1)`, [chain])).rows,
    )
  )[0] as { ok: boolean; checked: string; first_bad_seq: string | null; reason: string | null };
const PLATFORM_CHAIN = '00000000-0000-0000-0000-000000000000';
const createKey = (who: string, org: string) =>
  e.call(who, 'POST', '/v1/api-keys', { name: `qa-${Math.random()}`, scopes: ['ai:read'] }, org);

let providerCalls = 0;
let mock: MockModelAdapter;

beforeAll(async () => {
  e = await setupAiEnv({ realAudit: true });
  gw = e.app.get(GatewayService);
  budgets = e.app.get(BudgetService);
  mock = new MockModelAdapter({
    id: 'mock-model',
    handler: () => {
      providerCalls++;
      return 'w'.repeat(40);
    },
  });
  await e.enableMock('mock-model', { adapter: mock });
  await e.fund(A(), '50000000');
}, 180_000);
afterAll(() => e.h.close());

describe('QA integrity 1: duplicate-charge prevention', () => {
  it('a call id repeated one after another is refused and charged once', async () => {
    const id = `dup-${uuidv7()}`;
    const w0 = await e.wallet(A());
    await gw.invoke(call({ callId: id }));
    const w1 = await e.wallet(A());
    expect(w0 - w1).toBeGreaterThan(0n);
    for (let i = 0; i < 3; i++) await expect(gw.invoke(call({ callId: id }))).rejects.toBeTruthy();
    expect(await e.wallet(A())).toBe(w1);
    expect(
      await num(`SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`, [A(), id]),
    ).toBe(1);
    expect(
      await num(
        `SELECT count(*) n FROM billing.ledger_transactions WHERE org_id=$1 AND idempotency_key=$2`,
        [A(), `ai:call:${A()}:${id}`],
      ),
    ).toBe(1);
  });

  it('the same call id sent 12 times AT ONCE: one usage row, one ledger transaction, one wallet debit (customer side)', async () => {
    const id = `race-${uuidv7()}`;
    const w0 = await e.wallet(A());
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => gw.invoke(call({ callId: id }))),
    );
    const charged = w0 - (await e.wallet(A()));
    expect(
      await num(`SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`, [A(), id]),
    ).toBe(1);
    expect(
      await num(
        `SELECT count(*) n FROM billing.ledger_transactions WHERE org_id=$1 AND idempotency_key=$2`,
        [A(), `ai:call:${A()}:${id}`],
      ),
    ).toBe(1);
    expect(charged).toBeGreaterThan(0n);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(
      await num(
        `SELECT count(*) n FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2 AND state='held'`,
        [A(), `${id}%`],
      ),
    ).toBe(0);
  });

  it('DEFECT-8 (fixed by Session 02): the same call id sent 12 times AT ONCE reaches the provider once; every duplicate is refused with a 409 (in progress, or already settled) and none is charged', async () => {
    const id = `race2-${uuidv7()}`;
    const p0 = providerCalls;
    const w0 = await e.wallet(A());
    const res = await Promise.allSettled(
      Array.from({ length: 12 }, () => gw.invoke(call({ callId: id }))),
    );
    expect(providerCalls - p0, 'provider invocations for one call id').toBe(1);
    const failed = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const f of failed) {
      const r = f.reason as { code?: string; detail?: string; message?: string };
      expect(r.code, String(f.reason)).toBe('conflict'); // HTTP 409
      // a duplicate that arrives while the call is live is told so; one that arrives after it finished is told the id is settled: both are 409, neither dispatches
      expect(`${r.detail ?? ''} ${r.message ?? ''}`).toMatch(/call_in_progress|already settled/);
    }
    const charged = w0 - (await e.wallet(A()));
    expect(charged).toBeGreaterThan(0n);
    expect(
      await num(`SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`, [A(), id]),
    ).toBe(1);
  });

  it('a call that fails at the provider is not charged and leaves no open reservation; its id stays closed (no later charge under it)', async () => {
    const id = `fail-${uuidv7()}`;
    const w0 = await e.wallet(A());
    // the gateway may try another model of the same provider after a rejection: fail every candidate
    mock.failNext(new ModelAdapterError('invalid_request', 'rejected'), 20);
    try {
      await expect(gw.invoke(call({ callId: id }))).rejects.toBeTruthy();
    } finally {
      mock.clearFaults();
    }
    expect(await e.wallet(A())).toBe(w0);
    expect(
      await num(
        `SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND call_id=$2 AND outcome='ok'`,
        [A(), id],
      ),
    ).toBe(0);
    expect(
      await num(
        `SELECT count(*) n FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2 AND state='held'`,
        [A(), `${id}%`],
      ),
    ).toBe(0);
    // the id of a failed call is closed: re-sending it is refused (a retry uses a new id), so a failure can never be paid later under the old one
    await expect(gw.invoke(call({ callId: id }))).rejects.toMatchObject({ code: 'conflict' });
    expect(await e.wallet(A())).toBe(w0);
    await gw.invoke(call({ callId: `${id}-retry` }));
    expect(await e.wallet(A())).toBeLessThan(w0);
  });

  it('a reservation is released once and a second release or a sweep changes nothing (no double refund)', async () => {
    const r = await budgets.reserve({
      orgId: A(),
      callId: `rel-${uuidv7()}`,
      credits: 25n,
      tokens: 25n,
    });
    const reserved = async () =>
      (await e.sql(`SELECT reserved_credits r FROM ai.credit_balances WHERE org_id=$1`, [A()]))[0]!
        .r as string;
    const held = BigInt(await reserved());
    await Promise.all([
      budgets.release(A(), r.id),
      budgets.release(A(), r.id),
      budgets.release(A(), r.id),
    ]);
    expect(BigInt(await reserved())).toBe(held - 25n);
    await budgets.release(A(), r.id);
    await budgets.sweepExpired();
    expect(BigInt(await reserved())).toBe(held - 25n);
  });

  it('two concurrent reservations that together exceed the balance: exactly the affordable ones succeed (no oversell)', async () => {
    // a tiny organization of its own: the wallet holds 100 credits (unit = 1 minor)
    const orgC = (
      await e.call('bob', 'POST', '/v1/organizations', { name: 'QA Tiny' }, e.org.B!)
    ).json().id as string;
    await e.fund(orgC, '100');
    const tries = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        budgets.reserve({
          orgId: orgC,
          callId: `tiny-${i}-${uuidv7()}`,
          credits: 30n,
          tokens: 30n,
        }),
      ),
    );
    expect(tries.filter((t) => t.status === 'fulfilled').length).toBe(3); // 3 x 30 = 90 <= 100 < 120
    const held = await e.sql(
      `SELECT coalesce(sum(credits),0) c FROM ai.reservations WHERE org_id=$1 AND state='held'`,
      [orgC],
    );
    expect(Number(held[0]!.c)).toBe(90);
    expect(
      Number(
        (
          await e.sql(`SELECT reserved_credits r FROM ai.credit_balances WHERE org_id=$1`, [orgC])
        )[0]!.r,
      ),
    ).toBe(90);
  });
});

describe('QA integrity 2: reconciliation after a concurrent mixed workload', () => {
  const ledgerDebits = (key = 'ai:call:%') =>
    `SELECT t.idempotency_key k, sum(p.amount_minor) amt FROM billing.ledger_transactions t
       JOIN billing.ledger_postings p ON p.transaction_id = t.id
       JOIN billing.ledger_accounts a ON a.id = p.account_id AND a.code = '2100' AND p.direction = 'debit'
      WHERE t.org_id = $1 AND t.idempotency_key LIKE '${key}' GROUP BY 1`;

  /** Runs `perRun` calls in each of `runs` runs (concurrent across runs; `parallelInRun` decides whether the calls of ONE run are concurrent), with provider failures, key creation and top-ups racing alongside. */
  async function workload(o: {
    runs: number;
    perRun: number;
    parallelInRun: boolean;
    cap: number;
    faults: number;
    tag: string;
  }) {
    const w0 = await e.wallet(A());
    const u0 = BigInt(
      String(
        (
          await e.sql(
            `SELECT coalesce(sum(credits),0) c FROM ai.model_usage WHERE org_id=$1 AND outcome='ok'`,
            [A()],
          )
        )[0]!.c,
      ),
    );
    const runIds = Array.from({ length: o.runs }, () => uuidv7());
    for (const id of runIds) {
      await e.sql(
        `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1,$2,'t','SA')`,
        [id, A()],
      );
      await e.sql(
        `INSERT INTO ai.runs (id, org_id, session_id, kind, data_region) VALUES ($1,$2,$1,'chat','SA')`,
        [id, A()],
      );
    }
    mock.failNext(new ModelAdapterError('invalid_request', 'scripted failure'), o.faults);
    const outcomes = new Map<string, string>();
    let ok = 0;
    const one = (runId: string, i: number) => {
      const callId = `${o.tag}-${i}-${uuidv7()}`;
      return gw.invoke(call({ runId, callId, runBudget: { maxCredits: o.cap } })).then(
        () => {
          ok++;
          outcomes.set(callId, 'ok');
        },
        (err: { code?: string; message?: string }) =>
          void outcomes.set(
            callId,
            `${err.code ?? 'noncode'}: ${String(err.message).slice(0, 80)}`,
          ),
      );
    };
    const jobs: Promise<unknown>[] = runIds.map(async (runId, r) => {
      if (o.parallelInRun)
        await Promise.all(Array.from({ length: o.perRun }, (_, i) => one(runId, r * 1000 + i)));
      else for (let i = 0; i < o.perRun; i++) await one(runId, r * 1000 + i);
    });
    for (let i = 0; i < 8; i++) jobs.push(createKey('alice', A()));
    for (let i = 0; i < 4; i++) jobs.push(e.fund(A(), '1000'));
    await Promise.all(jobs);
    mock.clearFaults();
    // per call: the ledger debit and the usage row must agree, both ways
    const wrong = (await e.sql(
      `WITH led AS (SELECT substring(k from 'ai:call:[0-9a-f-]+:(.*)$') call_id, amt FROM (${ledgerDebits(`ai:call:%:${o.tag}-%`)}) x),
            use AS (SELECT call_id, sum(credits) amt FROM ai.model_usage WHERE org_id = $1 AND outcome = 'ok' AND call_id LIKE '${o.tag}-%' GROUP BY 1)
       SELECT coalesce(led.call_id, use.call_id) call_id, led.amt ledger_amt, use.amt usage_amt
         FROM led FULL JOIN use ON use.call_id = led.call_id
        WHERE led.amt IS DISTINCT FROM use.amt`,
      [A()],
    )) as Row[];
    const detail = [];
    for (const w of wrong.slice(0, 5))
      detail.push({ ...w, outcome: outcomes.get(String(w.call_id)) });
    const u1 = BigInt(
      String(
        (
          await e.sql(
            `SELECT coalesce(sum(credits),0) c FROM ai.model_usage WHERE org_id=$1 AND outcome='ok'`,
            [A()],
          )
        )[0]!.c,
      ),
    );
    const walletMoved = (await e.wallet(A())) - w0;
    return {
      ok,
      outcomes,
      runIds,
      perCallMismatches: detail,
      mismatchCount: wrong.length,
      // wallet = before + top-ups - credits recorded in usage (credit unit = 1 minor in the test env)
      walletGap: walletMoved - (4000n - (u1 - u0)),
    };
  }

  it('calls of one run in sequence (runs concurrent), with provider failures, key creation and top-ups racing: usage = ledger = wallet, per call and in total', async () => {
    await e.fund(A(), '3000000');
    const w = await workload({
      runs: 6,
      perRun: 8,
      parallelInRun: false,
      cap: 600,
      faults: 6,
      tag: 'seq',
    });
    expect(w.ok).toBeGreaterThan(20);
    expect(w.perCallMismatches).toEqual([]);
    expect(w.walletGap).toBe(0n);
  }, 180_000);

  it('DEFECT-7 (fixed by Session 02): calls of ONE run in parallel never leave a wallet charge without a usage record, in 4 rounds of 60 calls (6 runs, 10 in flight per run, provider failures, key creation and top-ups racing); nothing stays held; no settle was left incomplete', async () => {
    for (let round = 0; round < 4; round++) {
      const w = await workload({
        runs: 6,
        perRun: 10,
        parallelInRun: true,
        cap: 600,
        faults: 6,
        tag: `par${round}`,
      });
      expect({
        round,
        chargedWithoutUsage: w.mismatchCount,
        walletGap: String(w.walletGap),
        detail: w.perCallMismatches,
      }).toEqual({
        round,
        chargedWithoutUsage: 0,
        walletGap: '0',
        detail: [],
      });
    }
    expect(
      await num(`SELECT count(*) n FROM ai.reservations WHERE org_id=$1 AND state='held'`, [A()]),
    ).toBe(0);
    expect(
      await num(
        `SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1 AND action='ai.settle.incomplete'`,
        [A()],
      ),
    ).toBe(0);
  }, 300_000);

  it('every ledger transaction of the organization balances (debits = credits) and no posting is orphaned', async () => {
    const unbalanced = await e.sql(
      `SELECT transaction_id FROM billing.ledger_postings WHERE org_id=$1 GROUP BY transaction_id
        HAVING sum(CASE WHEN direction='debit' THEN amount_minor ELSE 0 END) <> sum(CASE WHEN direction='credit' THEN amount_minor ELSE 0 END)`,
      [A()],
    );
    expect(unbalanced).toEqual([]);
    const orphan = await e.sql(
      `SELECT p.id FROM billing.ledger_postings p LEFT JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.id IS NULL`,
    );
    expect(orphan).toEqual([]);
  });

  it('the sweeper is the safety net: after expiry no reservation stays open and the reserved counter returns to zero', async () => {
    await e.sql(
      `UPDATE ai.reservations SET expires_at = now() - interval '1 minute' WHERE org_id=$1 AND state='held'`,
      [A()],
    );
    await budgets.sweepExpired();
    expect(
      await num(
        `SELECT coalesce(sum(credits),0) n FROM ai.reservations WHERE org_id=$1 AND state='held'`,
        [A()],
      ),
    ).toBe(0);
    expect(
      await num(`SELECT reserved_credits n FROM ai.credit_balances WHERE org_id=$1`, [A()]),
    ).toBe(0);
  });

  it('no run exceeded its cap (sequential workload)', async () => {
    const over = await e.sql(
      `SELECT run_id, sum(credits) c FROM ai.model_usage WHERE org_id=$1 AND run_id IS NOT NULL AND outcome='ok' AND call_id LIKE 'seq-%' GROUP BY run_id HAVING sum(credits) > 600`,
      [A()],
    );
    expect(over).toEqual([]);
  });
});

describe('QA integrity 3: the audit chain under concurrency and what never reaches it', () => {
  it('after the workload the organization chain and the platform chain verify; sequence is contiguous and time never goes backwards', async () => {
    for (const chain of [A(), PLATFORM_CHAIN]) {
      const v = await verify(chain);
      expect(v, chain).toMatchObject({ ok: true });
      const rows = await e.sql(
        `SELECT chain_seq::int s, occurred_at t FROM audit.audit_logs WHERE chain_key=$1 ORDER BY chain_seq`,
        [chain],
      );
      expect(
        rows.map((r) => r.s),
        chain,
      ).toEqual(rows.map((_, i) => i + 1));
      for (let i = 1; i < rows.length; i++)
        expect((rows[i]!.t as Date).getTime(), `${chain} seq ${rows[i]!.s}`).toBeGreaterThanOrEqual(
          (rows[i - 1]!.t as Date).getTime(),
        );
      expect(Number(v.checked)).toBe(rows.length);
    }
    expect(
      await num(`SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1`, [A()]),
    ).toBeGreaterThan(12); // 12 key creations alone
  });

  it('25 simultaneous mutations of one organization leave 25 new audit rows and an intact chain', async () => {
    const before = await num(`SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1`, [A()]);
    const rs = await Promise.all(Array.from({ length: 25 }, () => createKey('alice', A())));
    const made = rs.filter((r) => r.statusCode === 201).length;
    expect(made).toBeGreaterThan(0);
    const after = await num(`SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1`, [A()]);
    expect(after - before).toBeGreaterThanOrEqual(made);
    expect(await verify(A())).toMatchObject({ ok: true });
  });

  it('a refused mutation (viewer) is audited as a denial or not at all, never as a success', async () => {
    const before = await num(
      `SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1 AND outcome='success'`,
      [A()],
    );
    const r = await e.call(
      'carol',
      'POST',
      '/v1/api-keys',
      { name: 'nope', scopes: ['ai:read'] },
      A(),
    );
    expect(r.statusCode).toBe(403);
    expect(
      await num(
        `SELECT count(*) n FROM audit.audit_logs WHERE chain_key=$1 AND outcome='success'`,
        [A()],
      ),
    ).toBe(before);
  });

  it('no audit row of any chain carries a canary, a key-looking string or a prompt body', async () => {
    // plant material that must never be stored: a canary in a prompt (blocked before dispatch) and a key-looking string
    await expect(
      gw.invoke(call({ messages: msg(`please use ${CANARY_A} and ${CANARY_B}`) })),
    ).rejects.toBeTruthy();
    await expect(
      gw.invoke(
        call({
          messages: msg(`my key is ${'AKIA' + 'ABCDEFGHIJKLMNOP'} and the file vault://org/ai/key`),
        }),
      ),
    ).rejects.toBeTruthy();
    const bad = await e.sql(
      `SELECT id, action FROM audit.audit_logs
        WHERE (coalesce(before::text,'') || coalesce(after::text,'') || detail::text) ~* ('(' || $1 || '|' || $2 || '|sk-ant-|hello bakery|BEGIN [A-Z ]*PRIVATE KEY)')`,
      [CANARY_A, CANARY_B],
    );
    expect(bad).toEqual([]);
  });

  it('the AI mutations are audited with actor, resource and trace id', async () => {
    const etag = async () =>
      (await e.call('alice', 'GET', '/v1/ai/budgets', undefined, A())).headers.etag as string;
    const put = await e.call(
      'alice',
      'PUT',
      '/v1/ai/budgets',
      { org: { dailyCredits: 123456 } },
      A(),
      { 'if-match': await etag() },
    );
    expect(put.statusCode, put.body).toBe(200);
    const rows = (await e.sql(
      `SELECT action, actor_type, actor_user_id, trace_id, outcome FROM audit.audit_logs WHERE chain_key=$1 AND action LIKE 'ai.budget%' ORDER BY chain_seq DESC LIMIT 5`,
      [A()],
    )) as Row[];
    expect(
      rows.length,
      JSON.stringify(
        await e.sql(
          `SELECT DISTINCT action FROM audit.audit_logs WHERE chain_key=$1 AND action LIKE 'ai.%'`,
          [A()],
        ),
      ),
    ).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actor_type).toBe('user');
      expect(row.actor_user_id).toBe(e.ids.alice);
      expect(row.trace_id).toBeTruthy();
    }
    await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': await etag() });
  });
});

describe('QA integrity 4: tamper detection by the verifier, and the limits of the runtime roles', () => {
  const freshOrg = async (name: string) => {
    const id = (await e.call('alice', 'POST', '/v1/organizations', { name }, A())).json()
      .id as string;
    for (let i = 0; i < 5; i++) expect((await createKey('alice', id)).statusCode).toBe(201);
    return id;
  };
  const trigger = (on: boolean) =>
    e.sql(`ALTER TABLE audit.audit_logs ${on ? 'ENABLE' : 'DISABLE'} TRIGGER audit_logs_no_update`);

  it('an edited row is found and named; restoring the original value makes the chain verify again', async () => {
    const org = await freshOrg('QA Tamper Edit');
    expect(await verify(org)).toMatchObject({ ok: true });
    const row = (
      await e.sql(
        `SELECT id, detail, chain_seq::int s FROM audit.audit_logs WHERE chain_key=$1 AND chain_seq=3`,
        [org],
      )
    )[0]!;
    await trigger(false);
    try {
      await e.sql(`UPDATE audit.audit_logs SET detail = '{"forged":true}'::jsonb WHERE id=$1`, [
        row.id,
      ]);
      const v = await verify(org);
      expect(v.ok).toBe(false);
      expect(Number(v.first_bad_seq)).toBe(3);
      expect(v.reason).toMatch(/does not match its hash/);
      await e.sql(`UPDATE audit.audit_logs SET detail = $2::jsonb WHERE id=$1`, [
        row.id,
        JSON.stringify(row.detail),
      ]);
    } finally {
      await trigger(true);
    }
    expect(await verify(org)).toMatchObject({ ok: true });
  });

  it('a deleted middle row (sequence gap), a deleted tail (chain tip) and a replaced actor are all detected', async () => {
    const gapOrg = await freshOrg('QA Tamper Gap');
    const tailOrg = await freshOrg('QA Tamper Tail');
    const actorOrg = await freshOrg('QA Tamper Actor');
    await trigger(false);
    try {
      await e.sql(`DELETE FROM audit.audit_logs WHERE chain_key=$1 AND chain_seq=2`, [gapOrg]);
      await e.sql(
        `DELETE FROM audit.audit_logs WHERE chain_key=$1 AND chain_seq=(SELECT max(chain_seq) FROM audit.audit_logs WHERE chain_key=$1)`,
        [tailOrg],
      );
      await e.sql(
        `UPDATE audit.audit_logs SET actor_user_id=$2 WHERE chain_key=$1 AND chain_seq=1`,
        [actorOrg, randomUUID()],
      );
    } finally {
      await trigger(true);
    }
    const gap = await verify(gapOrg);
    expect(gap.ok).toBe(false);
    expect(gap.reason).toMatch(/gap|reordered|prev_hash/);
    const tail = await verify(tailOrg);
    expect(tail.ok).toBe(false);
    expect(tail.reason).toMatch(/tip|truncat/);
    const actor = await verify(actorOrg);
    expect(actor.ok).toBe(false);
    expect(Number(actor.first_bad_seq)).toBe(1);
    // the damage of one chain never spreads: the others still verify
    expect(await verify(A())).toMatchObject({ ok: true });
  });

  it('a runtime role cannot rewrite, delete, truncate, read the chain heads, or switch the protections off', async () => {
    const attempts: [string, string][] = [
      ['update', `UPDATE audit.audit_logs SET detail='{}'::jsonb`],
      ['delete', `DELETE FROM audit.audit_logs`],
      ['truncate', `TRUNCATE audit.audit_logs`],
      ['read chain heads', `SELECT * FROM audit.chain_heads`],
      ['rewrite chain heads', `UPDATE audit.chain_heads SET last_hash = repeat('f', 64)`],
      ['disable the trigger', `ALTER TABLE audit.audit_logs DISABLE TRIGGER audit_logs_no_update`],
      ['skip triggers', `SET session_replication_role = replica`],
      ['drop the trigger function', `DROP FUNCTION audit.deny_mutation() CASCADE`],
    ];
    for (const url of [e.h.env.appUrl, e.h.env.workerUrl]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(`SELECT set_config('app.org_id', $1, false)`, [A()]);
        for (const [what, sql] of attempts) {
          await expect(c.query(sql), `${what} as ${new URL(url).username}`).rejects.toThrow(
            /permission denied|append-only|must be owner|insufficient|not permitted|only superusers/i,
          );
        }
      } finally {
        await c.end();
      }
    }
    expect(await verify(A())).toMatchObject({ ok: true });
  });
});
