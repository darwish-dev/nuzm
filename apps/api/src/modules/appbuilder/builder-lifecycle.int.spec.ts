import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunService } from '../ai';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { ContentAccessService } from './internal/changes/content-access.service';
import {
  BILLING_SEPARATION_FLAG,
  ExecutionBudgetService,
  ExecutionGate,
  ReleaseBuildBudget,
} from './internal/lifecycle/execution-budget.service';

/**
 * PHASE-2 S05, the builder agent loop on the real schema, the real run engine, the real approvals and the real HTTP layer. Everything that would run or call out is a MOCK: the model
 * is the scripted dev-reference one (the default lifecycle uses no model at all), the execution port is the Execution Gateway's mock (it executes nothing), no deployment happens.
 * Proves plumbing, safety, accounting and policy; says nothing about whether generated code builds (SIMULATED).
 */
let e: AiEnv;
let runs: RunService;
const modelCalls: unknown[] = [];
/** the scripted model writes valid placeholder content by extension, or (when asked) an invalid package.json */
let badManifest = false;
const contentFor = (path: string): string =>
  path === 'package.json'
    ? badManifest
      ? 'export {};\n'
      : '{"name":"app","version":"0.0.0"}\n'
    : path.endsWith('.json')
      ? '{}\n'
      : path.endsWith('.sql')
        ? '-- x\n'
        : path.endsWith('.md')
          ? '# x\n'
          : 'export {};\n';
const A = () => e.org.A!;
const B = () => e.org.B!;
const ok = <T = Row>(
  r: { statusCode: number; body: string; json: () => unknown },
  status = 200,
): T => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
};
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object, org = A()) =>
  e.call(who, method, url, body, org, { 'idempotency-key': randomUUID() });
/** rows as loosely typed JSON (the harness returns unknown rows) */
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  (await e.sql(sql, params)) as Row[];
const flag = async (org: string, key: string, on: boolean | null) => {
  await q(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [key, org]);
  if (on !== null)
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [key, org, JSON.stringify(on)],
    );
};
import { createHash } from 'node:crypto';
const uuidFrom = (key: string): string => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const BRIEF = 'An online store with products, a cart and checkout, sign in, and an admin dashboard';
const ALL_14 = [
  'requirements',
  'project-analysis',
  'architecture',
  'plan',
  'tasks',
  'file-generation',
  'change-apply',
  'review',
  'execution-request',
  'build',
  'tests',
  'preview',
  'deployment-preparation',
  'deployment-approval',
];

async function project(name: string, org = A()) {
  const id = ok<{ id: string }>(
    await call('alice', 'POST', '/v1/builder/projects', { name, type: 'webapp' }, org),
    201,
  ).id;
  ok(
    await call(
      'alice',
      'POST',
      `/v1/builder/projects/${id}/changes`,
      {
        baseVersion: null,
        source: 'user',
        patches: [
          { op: 'add', path: 'README.md', content: '# demo\n' },
          { op: 'add', path: 'src/answer.ts', content: 'export const answer = 1;\n' },
        ],
      },
      org,
    ),
  );
  return id;
}
const head = async (p: string) =>
  (await q(`SELECT head_version_id FROM builder.projects WHERE id = $1`, [p]))[0]!
    .head_version_id as string;
async function startRun(
  p: string,
  input: Row = { builderLifecycle: true, brief: { prompt: BRIEF } },
  who = 'alice',
) {
  const sid = ok<{ id: string }>(
    await call(who, 'POST', '/v1/ai/sessions', { title: 'lifecycle', projectId: p }),
    201,
  ).id;
  return call(who, 'POST', '/v1/ai/runs', { sessionId: sid, kind: 'webapp', projectId: p, input });
}
async function drive(runId: string): Promise<Row> {
  const r = (await q(`SELECT operation_id FROM ai.runs WHERE id = $1`, [runId]))[0]!;
  await runs.runOne(A(), r.operation_id as string);
  return (
    await q(`SELECT state, error, result, checkpoint FROM ai.runs WHERE id = $1`, [runId])
  )[0]!;
}
/** the decision continues the parked run asynchronously (M09 `resumeParked`): wait for the queued segment before driving it */
async function resumed(runId: string) {
  for (let i = 0; i < 100; i++) {
    if ((await q(`SELECT state FROM ai.runs WHERE id = $1`, [runId]))[0]!.state === 'queued')
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the run was not queued after the decision');
}
const steps = (runId: string) =>
  q(
    `SELECT node, status, attempt, seq, error_code, tokens_in FROM ai.run_steps WHERE run_id = $1 AND node LIKE 'lc-%' ORDER BY seq`,
    [runId],
  );

beforeAll(async () => {
  process.env.AI_MAX_CONCURRENT_RUNS = '500';
  process.env.BUILDER_MAX_PROJECTS = '500';
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({
      id: 'mock-model',
      // the generation message names the files of the task: answer with exactly those (plus one path outside the task, which the lifecycle must drop)
      handler: (req) => {
        modelCalls.push(req);
        const text = req.messages.map((m) => m.content).join('\n');
        const files = (/Write ONLY these files: (.*)\.\n/.exec(text)?.[1] ?? '')
          .split(', ')
          .filter(Boolean);
        return JSON.stringify({
          summary: 'scripted',
          patches: [...files, 'src/elsewhere.ts'].map((path) => ({
            op: 'add',
            path,
            content: contentFor(path),
          })),
        });
      },
    }),
  });
  for (const org of [A(), B()]) {
    await flag(org, 'app_builder.enabled', true);
    await flag(org, 'builder_tools.enabled', true);
  }
  await e.fund(A(), '50000000');
}, 300_000);
afterAll(() => e.h.close());

describe('flags and input', () => {
  it('is off by default: a lifecycle run is accepted by the run API but ends unsupported, and nothing in the project changes', async () => {
    const p = await project('Lifecycle Off');
    const before = await head(p);
    const run = ok<{ id: string }>(await startRun(p), 202);
    const out = await drive(run.id);
    expect(out.state).toBe('failed');
    expect(await head(p)).toBe(before);
    expect(await steps(run.id)).toHaveLength(0);
  });
  it('malformed input is refused with 422 before anything is created', async () => {
    const p = await project('Lifecycle Input');
    for (const input of [
      { builderLifecycle: true },
      { builderLifecycle: true, brief: { prompt: '' } },
      { builderLifecycle: true, brief: { prompt: 'x'.repeat(4001) } },
      { builderLifecycle: 'yes', brief: { prompt: 'x' } },
      { builderLifecycle: true, brief: { prompt: 'x' }, maxRepairRounds: 5 },
      { builderLifecycle: true, brief: { prompt: 'x' }, agentic: true },
    ])
      expect((await startRun(p, input)).statusCode, JSON.stringify(input)).toBe(422);
  });
});

describe('the lifecycle on the real run engine (offline, simulated)', () => {
  it('runs the steps, parks at the deployment approval, and finishes when an owner approves; a project change was applied once, nothing was deployed', async () => {
    await flag(A(), 'builder_lifecycle.enabled', true);
    const p = await project('Lifecycle Happy');
    const before = await head(p);
    const started = ok<{ id: string }>(await startRun(p), 202);
    const parked = await drive(started.id);
    expect(
      parked.state,
      JSON.stringify({
        error: parked.error,
        steps: await steps(started.id),
        cp: (parked.checkpoint as Row)?.lifecycle?.state?.failure,
      }),
    ).toBe('waiting_approval');

    // every step is recorded, in order, with its own row
    const s = await steps(started.id);
    expect(s.map((r) => String(r.node).replace(/^lc-|-r0$/g, ''))).toEqual(ALL_14);
    expect(s.every((r) => r.status === 'succeeded' && r.attempt === 1)).toBe(true);
    // the plan's files were added as ONE validated change; the customer's own files are untouched
    const after = await head(p);
    expect(after).not.toBe(before);
    const files = await q(
      `SELECT path FROM builder.project_files WHERE project_id = $1 AND version_id = $2`,
      [p, after],
    );
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['README.md', 'src/answer.ts']),
    );
    expect(
      (
        await q(`SELECT count(*)::int n FROM builder.project_versions WHERE project_id = $1`, [p])
      )[0]!.n,
    ).toBe(2);

    // the checkpoint holds the state machine and small results, never file contents
    const cp = (parked.checkpoint as Row).lifecycle as Row;
    expect(cp.state.status).toBe('waiting_approval');
    expect(JSON.stringify(cp).length).toBeLessThan(200_000);
    expect(cp.artifacts.generator).toBe('skeleton');
    expect(cp.artifacts.executionOrigin).toBe('MOCK');
    expect(JSON.stringify(cp)).not.toContain('export default function');

    // the approval: production_deploy, bound to the run, requested by the AI (so a human decides), with the evidence labelled simulated
    const pending = ok<{ items: Row[] }>(
      await call('alice', 'GET', '/v1/ai/approvals?status=pending'),
    ).items.filter((a) => a.runId === started.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'production_deploy', requestedByKind: 'ai' });
    expect(pending[0]!.action.blockers).toContain('simulated_evidence');
    // a developer cannot decide it, an owner can
    expect(
      (
        await call('dave', 'POST', `/v1/ai/approvals/${pending[0]!.id}/decisions`, {
          decision: 'approve',
          scopeHash: pending[0]!.scopeHash,
        })
      ).statusCode,
    ).toBe(403);
    ok(
      await call('alice', 'POST', `/v1/ai/approvals/${pending[0]!.id}/decisions`, {
        decision: 'approve',
        scopeHash: pending[0]!.scopeHash,
      }),
    );
    await resumed(started.id);
    const done = await drive(started.id);
    expect(done.state).toBe('succeeded');
    expect(done.result).toMatchObject({
      outcome: 'lifecycle',
      status: 'succeeded',
      simulated: true,
    });
    // no step ran twice, the project did not change again
    expect(await steps(started.id)).toHaveLength(14);
    expect(await head(p)).toBe(after);

    // events and audit: one per step, a start and a finish, the mock executions audited as NOT billed
    const ev = (
      await q(`SELECT type FROM ai.run_events WHERE run_id = $1 ORDER BY seq`, [started.id])
    ).map((r) => r.type);
    expect(ev).toContain('lifecycle_started');
    expect(ev.filter((t) => t === 'lifecycle_step').length).toBeGreaterThanOrEqual(15);
    expect(ev).toContain('lifecycle_finished');
    const actions = e.sink.events.map((x) => x.action);
    expect(
      actions.filter((a) => a === 'builder.lifecycle.step_finished').length,
    ).toBeGreaterThanOrEqual(14);
    expect(actions).toContain('builder.lifecycle.started');
    expect(actions).toContain('builder.lifecycle.finished');
    expect(actions.filter((a) => a === 'builder.execution.simulated')).toHaveLength(3);
    const metered = await q(
      `SELECT count(*)::int n FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'source' = 'builder@S05' AND payload->>'projectId' = $1`,
      [p],
    );
    expect(metered[0]!.n).toBe(0); // a simulated build is not usage
  });

  it('a rejected deployment approval ends the lifecycle as an outcome (the project was built), not as a failure', async () => {
    const p = await project('Lifecycle Denied');
    const started = ok<{ id: string }>(await startRun(p), 202);
    expect((await drive(started.id)).state).toBe('waiting_approval');
    const a = ok<{ items: Row[] }>(
      await call('alice', 'GET', '/v1/ai/approvals?status=pending'),
    ).items.find((x) => x.runId === started.id)!;
    ok(
      await call('alice', 'POST', `/v1/ai/approvals/${a.id}/decisions`, {
        decision: 'reject',
        scopeHash: a.scopeHash,
      }),
    );
    await resumed(started.id);
    const out = await drive(started.id);
    expect(
      out.state,
      JSON.stringify({
        err: out.error,
        ev: await q(`SELECT type FROM ai.run_events WHERE run_id = $1 ORDER BY seq DESC LIMIT 6`, [
          started.id,
        ]),
      }),
    ).toBe('succeeded');
    expect(out.result.status).toBe('succeeded');
    const last = (await steps(started.id)).at(-1)!;
    expect(String(last.node)).toContain('deployment-approval');
  });

  it('cancelling a parked run ends it as cancelled, never continues, and CLOSES its deployment approval (DEFECT-14): not listed as pending, not decidable', async () => {
    const p = await project('Lifecycle Cancel');
    const started = ok<{ id: string }>(await startRun(p), 202);
    expect((await drive(started.id)).state).toBe('waiting_approval');
    const pending = ok<{ items: Row[] }>(
      await call('alice', 'GET', '/v1/ai/approvals?status=pending'),
    ).items.find((x) => x.runId === started.id)!;
    expect(pending).toBeTruthy();
    ok(await call('alice', 'POST', `/v1/ai/runs/${started.id}/cancellation`), 202);
    const state = (await q(`SELECT state FROM ai.runs WHERE id = $1`, [started.id]))[0]!.state;
    expect(state).toBe('cancelled');
    expect(await steps(started.id)).toHaveLength(14);
    // the approval is closed: gone from the pending list, expired when read, and a decision is refused (never 200)
    const still = ok<{ items: Row[] }>(
      await call('alice', 'GET', '/v1/ai/approvals?status=pending'),
    ).items;
    expect(still.some((x) => x.id === pending.id)).toBe(false);
    expect(ok<Row>(await call('alice', 'GET', `/v1/ai/approvals/${pending.id}`)).status).toBe(
      'expired',
    );
    const late = await call('alice', 'POST', `/v1/ai/approvals/${pending.id}/decisions`, {
      decision: 'approve',
      scopeHash: pending.scopeHash,
    });
    expect(late.statusCode, late.body).toBe(410);
    expect(
      (
        await q(`SELECT status, decision_note FROM ai.approval_requests WHERE id = $1`, [
          pending.id,
        ])
      )[0],
    ).toMatchObject({ status: 'expired', decision_note: 'run_ended' });
    expect(
      e.sink.events.some((x) => x.action === 'ai.approval.closed' && x.resource?.id === pending.id),
    ).toBe(true);
    // the run never resumes
    await runs.tick();
    expect(await steps(started.id)).toHaveLength(14);
    expect((await q(`SELECT state FROM ai.runs WHERE id = $1`, [started.id]))[0]!.state).toBe(
      'cancelled',
    );
  });

  it("two concurrent opposite decisions: exactly one wins and the loser is told 409, not handed the winner's record as success (DEFECT-13); the same decision twice stays idempotent", async () => {
    const p = await project('Lifecycle Race');
    const started = ok<{ id: string }>(await startRun(p), 202);
    expect((await drive(started.id)).state).toBe('waiting_approval');
    const a = ok<{ items: Row[] }>(
      await call('alice', 'GET', '/v1/ai/approvals?status=pending'),
    ).items.find((x) => x.runId === started.id)!;
    const dec = (decision: string) =>
      call('alice', 'POST', `/v1/ai/approvals/${a.id}/decisions`, {
        decision,
        scopeHash: a.scopeHash,
      });
    const [x, y] = await Promise.all([dec('approve'), dec('reject')]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const final = (await q(`SELECT status FROM ai.approval_requests WHERE id = $1`, [a.id]))[0]!
      .status;
    expect(final).toBe(x.statusCode === 200 ? 'approved' : 'rejected');
    // the same decision again by the same person is the idempotent answer
    expect((await dec(final === 'approved' ? 'approve' : 'reject')).statusCode).toBe(200);
    await call('alice', 'POST', `/v1/ai/runs/${started.id}/cancellation`);
  });

  it('another organization sees nothing of the run, its steps or its approval', async () => {
    const p = await project('Lifecycle Tenant');
    const started = ok<{ id: string }>(await startRun(p), 202);
    await drive(started.id);
    expect(
      (await e.call('bob', 'GET', `/v1/ai/runs/${started.id}`, undefined, B())).statusCode,
    ).toBe(404);
    const theirs = ok<{ items: Row[] }>(
      await e.call('bob', 'GET', '/v1/ai/approvals', undefined, B()),
    ).items;
    expect(theirs.some((a) => a.runId === started.id)).toBe(false);
  });
});

describe('model-backed generation (flag builder_lifecycle.model_generation, scripted mock model)', () => {
  it("writes the files through the METERED gateway: tokens and credits are accounted per step, the files are the model's, and a path outside the task is dropped", async () => {
    await flag(A(), 'builder_lifecycle.enabled', true);
    await flag(A(), 'builder_lifecycle.model_generation', true);
    const p = await project('Lifecycle Model');
    const before = BigInt(
      (
        await q(`SELECT coalesce(sum(spent_credits),0) s FROM ai.runs WHERE project_id = $1`, [p])
      )[0]!.s,
    );
    const walletBefore = await e.wallet(A());
    const started = ok<{ id: string }>(await startRun(p), 202);
    const out = await drive(started.id);
    expect(
      out.state,
      JSON.stringify({
        err: out.error,
        audit: e.sink.events
          .filter((x) => x.action === 'builder.lifecycle.step_finished' && x.outcome === 'failure')
          .map((x) => x.detail),
      }),
    ).toBe('waiting_approval');
    const cp = (out.checkpoint as Row).lifecycle as Row;
    expect(cp.artifacts.generator).toBe('model');
    expect(cp.state.tokensIn + cp.state.tokensOut).toBeGreaterThan(0);
    expect(BigInt(cp.state.credits)).toBeGreaterThan(0n);
    const gen = (await steps(started.id)).find((s) => String(s.node).includes('file-generation'))!;
    expect(Number(gen.tokens_in)).toBeGreaterThan(0);
    // three ledgers, one number: the lifecycle state, the gateway's usage rows and the wallet (credit unit 1 minor) all agree
    const usage = (
      await q(
        `SELECT coalesce(sum(tokens_in),0)::bigint ti, coalesce(sum(tokens_out),0)::bigint "to", coalesce(sum(credits),0)::bigint cr, count(*)::int n FROM ai.model_usage WHERE run_id = $1`,
        [started.id],
      )
    )[0]!;
    expect(Number(usage.n)).toBeGreaterThan(0);
    expect(Number(usage.ti)).toBe(cp.state.tokensIn);
    expect(Number(usage.to)).toBe(cp.state.tokensOut);
    expect(BigInt(usage.cr)).toBe(BigInt(cp.state.credits));
    expect(walletBefore - (await e.wallet(A()))).toBe(BigInt(cp.state.credits));
    // what the gateway charged is what the lifecycle reports (one accounting, not two)
    const run = (await q(`SELECT spent_credits FROM ai.runs WHERE id = $1`, [started.id]))[0]!;
    expect(BigInt(run.spent_credits) - before).toBe(BigInt(cp.state.credits));
    const files = await q(
      `SELECT path FROM builder.project_files WHERE project_id = $1 AND version_id = $2`,
      [p, await head(p)],
    );
    expect(files.map((f) => f.path)).not.toContain('src/elsewhere.ts');
    expect(files.length).toBeGreaterThan(5);
    await flag(A(), 'builder_lifecycle.model_generation', null);
  });
  it('a file the safety checks refuse is never applied: the run stops with change_rejected and the project is unchanged', async () => {
    await flag(A(), 'builder_lifecycle.model_generation', true);
    badManifest = true;
    try {
      const p = await project('Lifecycle Model Bad');
      const before = await head(p);
      const started = ok<{ id: string }>(await startRun(p), 202);
      const out = await drive(started.id);
      expect(out.state).toBe('failed');
      expect(((out.checkpoint as Row).lifecycle as Row).state.failure).toEqual({
        step: 'change_apply',
        code: 'change_rejected',
      });
      expect(await head(p)).toBe(before);
      // no execution was requested for code that was never applied
      expect(
        e.sink.events.some(
          (x) => x.action === 'builder.execution.start_decided' && x.resource?.id === started.id,
        ),
      ).toBe(false);
    } finally {
      badManifest = false;
    }
    await flag(A(), 'builder_lifecycle.model_generation', null);
  });
  it('a token budget smaller than one generation turn stops the run BEFORE any model call', async () => {
    await flag(A(), 'builder_lifecycle.model_generation', true);
    const p = await project('Lifecycle Model Budget');
    const calls = modelCalls.length;
    const sid = ok<{ id: string }>(
      await call('alice', 'POST', '/v1/ai/sessions', { title: 'b', projectId: p }),
      201,
    ).id;
    const started = ok<{ id: string }>(
      await call('alice', 'POST', '/v1/ai/runs', {
        sessionId: sid,
        kind: 'webapp',
        projectId: p,
        input: { builderLifecycle: true, brief: { prompt: BRIEF } },
        budget: { maxTokens: 500 },
      }),
      202,
    );
    const out = await drive(started.id);
    expect(modelCalls.length).toBe(calls);
    expect(out.state).toBe('budget_exceeded');
    expect(((out.checkpoint as Row).lifecycle as Row).state.failure.code).toBe('tokens_exceeded');
    await flag(A(), 'builder_lifecycle.model_generation', null);
  });
});

describe('inference cost and execution cost are separate gates (finding: a release build needed AI wallet credit)', () => {
  it('switch OFF (default): every start needs AI credit, exactly as before; switch ON: execution asks the build allowance, the wallet only matters to inference', async () => {
    const gate = e.app.get(ExecutionGate);
    const release = new ReleaseBuildBudget(gate);
    const budget = e.app.get(ExecutionBudgetService);
    // org B has never been funded: an empty AI wallet
    await flag(B(), BILLING_SEPARATION_FLAG, null);
    expect(await release.remainingMinor(B())).toBe(0);
    await expect(budget.assertStart(B(), 'ai_run_build')).rejects.toMatchObject({
      code: 'budget_required',
    });
    await flag(B(), BILLING_SEPARATION_FLAG, true);
    expect(await release.remainingMinor(B())).toBeGreaterThan(0);
    const admitted = await budget.assertStart(B(), 'ai_run_build');
    expect(admitted.gates).toEqual(
      expect.arrayContaining(['residency', 'platform_ceiling', 'build_allowance']),
    );
    // an organization with a wallet is unaffected either way
    await flag(A(), BILLING_SEPARATION_FLAG, null);
    expect(await release.remainingMinor(A())).toBeGreaterThan(0);
    // every decision is audited with its gates
    const decided = e.sink.events.filter((x) => x.action === 'builder.execution.start_decided');
    expect(decided.length).toBeGreaterThanOrEqual(4);
    expect(decided.some((x) => x.outcome === 'failure' && x.detail?.gate === 'ai_wallet')).toBe(
      true,
    );
    await flag(B(), BILLING_SEPARATION_FLAG, null);
  });
  it('a real execution is metered as builder.build_minutes; a simulated one is audited and not billed', async () => {
    const budget = e.app.get(ExecutionBudgetService);
    const p = await project('Metering');
    await budget.meter(A(), p, {
      eventKey: 'run-x:build:0:build',
      profile: 'build',
      durationMs: 90_000,
      origin: 'REAL',
      at: '2026-11-24T10:00:00.000Z',
    });
    await budget.meter(A(), p, {
      eventKey: 'run-x:build:0:build',
      profile: 'build',
      durationMs: 90_000,
      origin: 'REAL',
      at: '2026-11-24T10:00:00.000Z',
    });
    await budget.meter(A(), p, {
      eventKey: 'run-x:tests:0:unit',
      profile: 'unit-tests',
      durationMs: 5_000,
      origin: 'MOCK',
      at: '2026-11-24T10:05:00.000Z',
    });
    const rows = await q(
      `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = 'builder.build_minutes' AND payload->>'resourceId' = $1`,
      [uuidFrom('run-x:build:0:build')],
    );
    // a replay writes the same event id: the metering pipeline dedupes by (org, event id), so it is counted once
    expect(new Set(rows.map((r) => r.payload.eventId)).size).toBe(1);
    expect(Number(rows[0]!.payload.quantity)).toBeCloseTo(1.5, 2);
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'resourceId' = $1`,
          [uuidFrom('run-x:tests:0:unit')],
        )
      )[0]!.n,
    ).toBe(0);
  });
});

describe('O-9 builder.billing_admin_content_access (proposed policy; default = today)', () => {
  const READS = ['review', 'symbols?q=answer', 'import-analysis', 'components', 'memory'];
  let p = '';
  const get = (who: string, path: string) =>
    e.call(who, 'GET', `/v1/builder/projects/${p}/${path}`, undefined, A());
  it('default: a billing administrator reads all five (today), and so does every other role', async () => {
    p = await project('O9');
    const access = e.app.get(ContentAccessService);
    expect(await access.get(A())).toEqual({ mode: 'allow', default: 'allow' });
    for (const who of ['frank', 'alice', 'dave', 'carol'])
      for (const r of READS) expect((await get(who, r)).statusCode, `${who} ${r}`).toBe(200);
  });
  it('deny: a billing administrator is refused all five (403, audited); owner, developer and viewer are unaffected; allow restores it', async () => {
    const access = e.app.get(ContentAccessService);
    const aliceId = e.ids.alice!;
    expect(await access.set(A(), aliceId, { mode: 'deny' })).toEqual({
      mode: 'deny',
      default: 'allow',
    });
    for (const r of READS) expect((await get('frank', r)).statusCode, `frank ${r}`).toBe(403);
    for (const who of ['alice', 'dave', 'carol'])
      for (const r of READS) expect((await get(who, r)).statusCode, `${who} ${r}`).toBe(200);
    const denials = e.sink.events.filter((x) => x.action === 'builder.content.access_denied');
    expect(denials.length).toBe(5);
    expect(denials.map((d) => d.detail.operation).sort()).toEqual([
      'components',
      'imports',
      'memory',
      'review',
      'symbols',
    ]);
    // another organization is not affected by this organization's setting
    expect(await access.mode(B())).toBe('allow');
    expect(await access.set(A(), aliceId, { mode: 'allow' })).toEqual({
      mode: 'allow',
      default: 'allow',
    });
    for (const r of READS) expect((await get('frank', r)).statusCode, `frank ${r}`).toBe(200);
    const changes = e.sink.events.filter(
      (x) => x.action === 'builder.policy.content_access_changed',
    );
    expect(changes.map((c) => [c.detail.before, c.detail.after])).toEqual([
      ['allow', 'deny'],
      ['deny', 'allow'],
    ]);
  });
  it('a malformed setting is refused, and a stored value nobody can read is treated as deny (never wider)', async () => {
    const access = e.app.get(ContentAccessService);
    await expect(access.set(A(), e.ids.alice!, { mode: 'maybe' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(access.set(A(), e.ids.alice!, { mode: 'deny', other: 1 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await q(
      `DELETE FROM platform.feature_flags WHERE key = 'builder.billing_admin_content_access' AND org_id = $1`,
      [A()],
    );
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'builder.billing_admin_content_access', $1, '"garbage"'::jsonb)`,
      [A()],
    );
    expect(await access.mode(A())).toBe('deny');
    expect((await get('frank', 'review')).statusCode).toBe(403);
    expect((await get('alice', 'review')).statusCode).toBe(200);
    await q(
      `DELETE FROM platform.feature_flags WHERE key = 'builder.billing_admin_content_access' AND org_id = $1`,
      [A()],
    );
    expect((await get('frank', 'review')).statusCode).toBe(200);
  });
});
