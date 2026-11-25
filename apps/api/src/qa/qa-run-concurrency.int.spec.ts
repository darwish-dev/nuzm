import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import {
  AI_CONFIG,
  RunKindRegistry,
  RunService,
  type AiConfig,
  type RunContext,
  type RunKindHandler,
} from '../modules/ai';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA), Phase 2 - the run engine under concurrency: the scaffold for the agent-loop lifecycle tests (cancellation, retry/iteration limits, budget stop, approval
 * gating, idempotency, concurrent runs). It drives the CURRENT run engine with a scripted two-step run kind that ends in a human approval (the shape the builder agent loop will
 * take); when Session 05 registers its agent-loop kind the same helpers run against it. SIMULATED model (MockModelAdapter); own Postgres, in-process server.
 *
 *  - concurrent creates: one active run per session, one run per idempotency key, the organization's concurrent-run ceiling
 *  - a run claimed by several workers at once runs its steps once and pays each call once
 *  - two humans deciding one approval at the same time: exactly one decision wins; the run resumes once
 *  - cancellation racing the run and itself
 */
let e: AiEnv;
let runs: RunService;
let registry: RunKindRegistry;
let cfg: AiConfig;
let adapter: MockModelAdapter;
const A = () => e.org.A!;
let steps: string[] = [];

const handler: RunKindHandler = {
  kind: 'website',
  toolKind: 'website',
  validateInput() {},
  async execute(ctx: RunContext) {
    if (ctx.resumedWith) {
      steps.push(`resumed:${ctx.resumedWith.decision}`);
      if (ctx.resumedWith.decision === 'approved') return ctx.succeed({ built: true });
    }
    for (const s of ['s1', 's2'] as const) {
      if (ctx.checkpoint[s]) continue;
      await ctx.call({ task: 'chat', instruction: s, schema: { type: 'object' }, maxTokens: 50 });
      steps.push(s);
      await ctx.save({ [s]: true }, s);
    }
    if (ctx.run.input.slow)
      await ctx.call({
        task: 'chat',
        instruction: 'slow',
        schema: { type: 'object' },
        maxTokens: 50,
      });
    return ctx.requestApproval('plan', { title: 'Approve the plan' }, { plan: 'x' });
  },
};

const session = async () =>
  (await e.call('alice', 'POST', '/v1/ai/sessions', { title: 'S' }, A())).json().id as string;
const mkRun = (body: Row, key?: string) =>
  e.call('alice', 'POST', '/v1/ai/runs', body, A(), key ? { 'idempotency-key': key } : {});
const opOf = async (id: string) =>
  (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [id]))[0]!.operation_id as string;
const state = async (id: string) =>
  (await e.sql(`SELECT state FROM ai.runs WHERE id=$1`, [id]))[0]!.state as string;
const view = async (id: string) =>
  (await e.call('alice', 'GET', `/v1/ai/runs/${id}`, undefined, A())).json() as Row;
const num = async (sql: string, args: unknown[] = []) => Number((await e.sql(sql, args))[0]!.n);
const cancel = (id: string) => e.call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`);
const decide = (who: string, id: string, approvalId: string, decision: 'approve' | 'deny') =>
  e.call(who, 'POST', `/v1/ai/runs/${id}/approvals`, { approvalId, decision });

beforeAll(async () => {
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  registry = e.app.get(RunKindRegistry);
  cfg = e.app.get(AI_CONFIG);
  adapter = new MockModelAdapter({
    id: 'mock-model',
    handler: () => JSON.stringify({ result: { ok: true } }),
  });
  await e.enableMock('mock-model', { adapter });
  await e.fund(A(), '50000000');
  await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"0"' });
  registry.register(handler);
}, 180_000);
afterAll(() => e.h.close());

describe('QA run engine: concurrent creation', () => {
  it('12 simultaneous creates in ONE session (different keys): exactly one run is created, the others are refused run_active', async () => {
    const sid = await session();
    const res = await Promise.all(
      Array.from({ length: 12 }, () => mkRun({ sessionId: sid, kind: 'website' })),
    );
    expect(res.filter((r) => r.statusCode === 202)).toHaveLength(1);
    for (const r of res.filter((x) => x.statusCode !== 202))
      expect(r.json().code).toBe('run_active');
    expect(await num(`SELECT count(*) n FROM ai.runs WHERE session_id=$1`, [sid])).toBe(1);
    await cancel(res.find((r) => r.statusCode === 202)!.json().id);
  });

  it('12 simultaneous creates with ONE idempotency key: one run, every caller gets the same run and operation', async () => {
    const sid = await session();
    const res = await Promise.all(
      Array.from({ length: 12 }, () => mkRun({ sessionId: sid, kind: 'website' }, 'qa-same-key-1')),
    );
    const ids = new Set(res.filter((r) => r.statusCode === 202).map((r) => r.json().id));
    expect(ids.size).toBe(1);
    // simultaneous duplicates are either served the same run or told to retry (409 idempotency_in_progress): never a second run
    for (const r of res)
      expect(
        r.statusCode === 202 || r.json().code === 'idempotency_in_progress',
        `${r.statusCode} ${r.body}`,
      ).toBe(true);
    const later = await mkRun({ sessionId: sid, kind: 'website' }, 'qa-same-key-1');
    expect(later.statusCode).toBe(202);
    expect(later.json().id).toBe([...ids][0]);
    expect(await num(`SELECT count(*) n FROM ai.runs WHERE session_id=$1`, [sid])).toBe(1);
    await cancel([...ids][0] as string);
  });

  it('DEFECT-15 (fixed by Session 02): the organization ceiling holds under bursts: 30 sessions started at once, repeated, never leave more active runs than the ceiling', async () => {
    const keep = cfg.maxConcurrentRuns;
    cfg.maxConcurrentRuns = 3;
    let worst = 0;
    try {
      for (let round = 0; round < 6 && worst <= 3; round++) {
        const sids = await Promise.all(Array.from({ length: 30 }, () => session()));
        const res = await Promise.all(
          sids.map((sid) => mkRun({ sessionId: sid, kind: 'website' })),
        );
        const active = await num(
          `SELECT count(*) n FROM ai.runs WHERE org_id=$1 AND state IN ('queued','running','waiting_approval')`,
          [A()],
        );
        worst = Math.max(worst, active);
        for (const r of res.filter((x) => x.statusCode === 202)) await cancel(r.json().id);
      }
    } finally {
      cfg.maxConcurrentRuns = keep;
    }
    expect(worst, 'most active runs seen after a burst').toBeLessThanOrEqual(3);
  }, 300_000);

  it('the ceiling holds for sequential creates: the run over the ceiling is refused 429 and nothing is created for it', async () => {
    const keep = cfg.maxConcurrentRuns;
    cfg.maxConcurrentRuns = 2;
    const made: string[] = [];
    try {
      for (let i = 0; i < 2; i++)
        made.push((await mkRun({ sessionId: await session(), kind: 'website' })).json().id);
      const before = await num(`SELECT count(*) n FROM ai.runs WHERE org_id=$1`, [A()]);
      expect((await mkRun({ sessionId: await session(), kind: 'website' })).statusCode).toBe(429);
      expect(await num(`SELECT count(*) n FROM ai.runs WHERE org_id=$1`, [A()])).toBe(before);
    } finally {
      cfg.maxConcurrentRuns = keep;
      for (const id of made) await cancel(id);
    }
  });
});

describe('QA run engine: workers, steps and payment', () => {
  it('a run claimed by 4 workers at once executes its steps once and pays each call once', async () => {
    steps = [];
    const id = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    const op = await opOf(id);
    const before = adapter.calls.length;
    await Promise.allSettled(Array.from({ length: 4 }, () => runs.runOne(A(), op)));
    expect(await state(id)).toBe('waiting_approval');
    expect(steps).toEqual(['s1', 's2']);
    expect(adapter.calls.length - before).toBe(2);
    const dup = await num(
      `SELECT count(*) n FROM (SELECT call_id FROM ai.model_usage WHERE run_id=$1 GROUP BY call_id HAVING count(*) > 1) x`,
      [id],
    );
    expect(dup).toBe(0);
    expect(
      await num(`SELECT count(*) n FROM ai.model_usage WHERE run_id=$1 AND outcome='ok'`, [id]),
    ).toBe(2);
    await cancel(id);
  });

  it('driving a finished or cancelled run again changes nothing: no call, no charge, no state change', async () => {
    steps = [];
    const id = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    await cancel(id);
    const op = await opOf(id);
    const before = adapter.calls.length;
    await runs.runOne(A(), op);
    await runs.runOne(A(), op);
    expect(adapter.calls.length).toBe(before);
    expect(await state(id)).toBe('cancelled');
    expect(await num(`SELECT count(*) n FROM ai.model_usage WHERE run_id=$1`, [id])).toBe(0);
  });
});

describe('QA run engine: approval gating under concurrency', () => {
  it('three humans decide one approval at once (approve, reject, approve): exactly one decision is recorded, the run follows it and resumes at most once', async () => {
    steps = [];
    const id = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    await runs.runOne(A(), await opOf(id));
    const w = await view(id);
    expect(w.state).toBe('waiting_approval');
    const apId = w.pendingApproval.id as string;
    const res = await Promise.all([
      decide('dave', id, apId, 'approve'),
      decide('erin', id, apId, 'deny'),
      decide('alice', id, apId, 'approve'),
    ]);
    const won = res.filter((r) => r.statusCode === 200);
    expect(won, res.map((r) => `${r.statusCode} ${r.body}`).join(' | ')).toHaveLength(1);
    for (const r of res.filter((x) => x.statusCode !== 200)) expect(r.statusCode).toBe(409);
    const ap = (await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [apId]))[0]!;
    expect(['approved', 'denied', 'rejected']).toContain(String(ap.state));
    expect(ap.decided_by).toBeTruthy();
    await runs.runOne(A(), await opOf(id));
    await runs.runOne(A(), await opOf(id));
    const finalState = await state(id);
    if (ap.state === 'approved') {
      expect(finalState).toBe('succeeded');
      expect(steps.filter((s) => s === 'resumed:approved')).toHaveLength(1);
    } else {
      expect(['cancelled', 'failed']).toContain(finalState);
      expect(steps.some((s) => s === 'resumed:approved')).toBe(false);
    }
    // no step ran twice, whatever the outcome
    expect(steps.filter((s) => s === 's1')).toHaveLength(1);
    expect(steps.filter((s) => s === 's2')).toHaveLength(1);
  });

  it('an approval never moves to another run and a decided approval is final', async () => {
    const a = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    const b = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    await runs.runOne(A(), await opOf(a));
    await runs.runOne(A(), await opOf(b));
    const apA = (await view(a)).pendingApproval.id as string;
    expect((await decide('dave', b, apA, 'approve')).statusCode).toBeGreaterThanOrEqual(400);
    expect(await state(b)).toBe('waiting_approval');
    expect((await decide('dave', a, apA, 'deny')).statusCode).toBe(200);
    expect((await decide('dave', a, apA, 'approve')).statusCode).toBe(409);
    await cancel(b);
  });
});

describe('QA run engine: cancellation', () => {
  it('five simultaneous cancellations of a run that is mid-step: it ends cancelled once, the call in flight is aborted, no reservation stays held', async () => {
    steps = [];
    const id = (
      await mkRun({ sessionId: await session(), kind: 'website', input: { slow: true } })
    ).json().id as string;
    const op = await opOf(id);
    adapter.delayMs = 500;
    try {
      const running = runs.runOne(A(), op);
      await new Promise((r) => setTimeout(r, 200));
      const res = await Promise.all(Array.from({ length: 5 }, () => cancel(id)));
      await running;
      expect(res.some((r) => r.statusCode === 202)).toBe(true);
      for (const r of res) expect([202, 409]).toContain(r.statusCode);
    } finally {
      adapter.delayMs = 0;
    }
    expect(await state(id)).toBe('cancelled');
    expect(
      await num(`SELECT count(*) n FROM ai.reservations WHERE run_id=$1 AND state='held'`, [id]),
    ).toBe(0);
    // a cancelled run never asks for approval and never resumes
    expect(
      await num(`SELECT count(*) n FROM ai.approvals WHERE run_id=$1 AND state='pending'`, [id]),
    ).toBe(0);
  });

  it('cancelling a run that already waits for approval closes the approval: it cannot be approved afterwards', async () => {
    const id = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    await runs.runOne(A(), await opOf(id));
    const apId = (await view(id)).pendingApproval.id as string;
    expect((await cancel(id)).statusCode).toBe(202);
    expect((await decide('dave', id, apId, 'approve')).statusCode).toBeGreaterThanOrEqual(400);
    expect(await state(id)).toBe('cancelled');
  });

  it('a viewer, a billing administrator and another organization cannot cancel; the run is untouched', async () => {
    const id = (await mkRun({ sessionId: await session(), kind: 'website' })).json().id as string;
    for (const who of ['carol', 'frank'])
      expect((await e.call(who, 'POST', `/v1/ai/runs/${id}/cancellation`)).statusCode, who).toBe(
        403,
      );
    expect(
      (await e.call('bob', 'POST', `/v1/ai/runs/${id}/cancellation`, undefined, e.org.B!))
        .statusCode,
    ).toBe(404);
    expect(await state(id)).toBe('queued');
    await cancel(id);
  });
});
