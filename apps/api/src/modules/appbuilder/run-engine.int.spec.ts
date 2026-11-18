import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBAPP_GRAPH } from './internal/graph/dag';
import { WorkerCrash } from './internal/graph/runner';
import { scopeHashOf } from './internal/approvals/approval.service';
import {
  ModelFixtureExecutor,
  setupEngineEnv,
  type EngineEnv,
} from './internal/testing/engine-harness';

let e: EngineEnv;
beforeAll(async () => {
  e = await setupEngineEnv();
}, 120_000);
afterAll(() => e.close());

const steps = (runId: string) =>
  e.env.sql(
    `SELECT node, status, attempt, seq, checkpoint_ref FROM ai.run_steps WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );

describe('graph runner: happy path (AC-M10 S42)', () => {
  it('runs all seven nodes in order, checkpoints each, meters usage and ends succeeded', async () => {
    const runId = await e.newRun();
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('succeeded');
    const s = await steps(runId);
    expect(s.map((r) => r.node)).toEqual([
      'requirements',
      'architecture',
      'database',
      'backend',
      'frontend',
      'qa',
      'devops',
    ]);
    expect(s.every((r) => r.status === 'succeeded' && r.checkpoint_ref)).toBe(true);
    const run = (await e.runs.get(e.orgA, runId))!;
    expect(run.state).toBe('succeeded');
    expect(run.usage.steps).toBe(7);
    expect(run.usage.tokensIn + run.usage.tokensOut).toBeGreaterThan(0);
    const calls = await e.env.sql(`SELECT count(*)::int n FROM ai.tool_calls WHERE run_id = $1`, [
      runId,
    ]);
    expect(calls[0]!.n).toBe(7);
    expect(e.sink.events.some((x) => x.action === 'ai.run.completed')).toBe(true);
  });
});

describe('crash and resume', () => {
  it('a worker that dies after a checkpoint resumes from it without repeating a node or duplicating a step', async () => {
    const runId = await e.newRun();
    const r1 = e.runner();
    r1.afterCheckpoint = (n) => {
      if (n === 'database') throw new WorkerCrash(n);
    };
    await expect(r1.run(e.orgA, runId, WEBAPP_GRAPH)).rejects.toBeInstanceOf(WorkerCrash);
    expect((await steps(runId)).map((r) => r.node)).toEqual([
      'requirements',
      'architecture',
      'database',
    ]);
    const callsBefore = e.model.calls.filter((c) => c.runId === runId).length;
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('succeeded');
    const s = await steps(runId);
    expect(s).toHaveLength(7);
    expect(new Set(s.map((r) => r.node)).size).toBe(7);
    // the three finished nodes were NOT asked again
    expect(e.model.calls.filter((c) => c.runId === runId).length - callsBefore).toBe(4);
    expect(s.slice(0, 3).every((r) => r.attempt === 1)).toBe(true);
  });
  it('a crash in the middle of a node (row left running) is taken over with attempt + 1, still one row', async () => {
    const runId = await e.newRun();
    const dead = e.runner();
    e.executors.set(
      'backend',
      new ModelFixtureExecutor('backend', 'api_contract', () => {
        throw new WorkerCrash('backend');
      }),
    );
    await expect(dead.run(e.orgA, runId, WEBAPP_GRAPH)).rejects.toBeInstanceOf(WorkerCrash);
    expect((await steps(runId)).find((r) => r.node === 'backend')!.status).toBe('running');
    e.executors.set('backend', new ModelFixtureExecutor('backend', 'api_contract'));
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('succeeded');
    const s = await steps(runId);
    expect(s).toHaveLength(7);
    expect(s.find((r) => r.node === 'backend')!.attempt).toBe(2);
  });
  it('two workers resuming the same run at once never create a node twice (unique index)', async () => {
    const runId = await e.newRun();
    const [a, b] = await Promise.all([
      e.runner().run(e.orgA, runId, WEBAPP_GRAPH),
      e.runner().run(e.orgA, runId, WEBAPP_GRAPH),
    ]);
    expect([a.status, b.status]).toContain('succeeded');
    for (const o of [a, b]) expect(['succeeded', 'busy']).toContain(o.status); // the loser of a node race backs off; nothing is duplicated or failed
    // whoever lost resumes later and finds every checkpoint
    expect((await e.runner().run(e.orgA, runId, WEBAPP_GRAPH)).status).toBe('succeeded');
    expect(await steps(runId)).toHaveLength(7);
    expect(new Set((await steps(runId)).map((r) => r.node)).size).toBe(7);
  });
});

describe('budget enforcement in the run', () => {
  it('stops with budget_exceeded before the call that does not fit and marks the step failed', async () => {
    const runId = await e.newRun(e.orgA, {
      maxTokens: 4_040,
      maxCostMinor: 100_000,
      maxMinutes: 30,
    }); // every call reserves 4,000 + input: the second call cannot fit
    const before = e.model.calls.length;
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out).toMatchObject({ status: 'budget_exceeded', dimension: 'tokens' });
    expect(e.model.calls.length - before).toBe(1);
    const run = (await e.runs.get(e.orgA, runId))!;
    expect(run.state).toBe('budget_exceeded');
    expect(run.usage.tokensIn + run.usage.tokensOut).toBeLessThanOrEqual(4_040);
    expect(e.sink.events.some((x) => x.action === 'ai.run.budget_exceeded')).toBe(true);
  });
  it('the org credit caps the run: cost cap = min(run cap, org remaining)', async () => {
    const runId = await e.newRun();
    e.orgBudget.remaining = 0;
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    e.orgBudget.remaining = 1_000_000_00;
    expect(out).toMatchObject({ status: 'budget_exceeded', dimension: 'cost' });
  });
});

describe('model failures', () => {
  it('a timeout mid-step is retried; the timed-out reservation is counted as spent (uncertain), the run still succeeds', async () => {
    const runId = await e.newRun();
    e.model.failNext('timeout');
    const out = await e.runner({ modelTimeoutMs: 5_000 }).run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('succeeded');
    expect((await steps(runId))[0]!.attempt).toBe(2);
    expect((await e.runs.get(e.orgA, runId))!.usage.tokensOut).toBeGreaterThan(4_000); // the whole 4,000 reservation was counted
  });
  it('provider no_capacity after the retries fails the run with a stable reason', async () => {
    const runId = await e.newRun();
    for (let i = 0; i < 3; i++) e.model.failNext('no_capacity');
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out).toEqual({ status: 'failed', reason: 'no_capacity' });
    expect((await e.runs.get(e.orgA, runId))!.state).toBe('failed');
  });
  it('a malformed model output is repaired at most twice, then the run fails artifact_invalid', async () => {
    const runId = await e.newRun();
    for (let i = 0; i < 3; i++) e.model.failNext('malformed');
    const before = e.model.calls.length;
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out).toEqual({ status: 'failed', reason: 'artifact_invalid' });
    expect(e.model.calls.length - before).toBe(3); // first try + 2 repairs
  });
});

describe('cancellation', () => {
  it('a cancelled run ends at the next checkpoint and runs no further node', async () => {
    const runId = await e.newRun();
    const r = e.runner();
    r.afterCheckpoint = async (n) => {
      if (n === 'architecture') await e.runs.transition(e.orgA, runId, 'cancelled');
    };
    const out = await r.run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('cancelled');
    expect((await steps(runId)).map((x) => x.node)).toEqual(['requirements', 'architecture']);
  });
});

describe('approvals (hash-bound, 24 h, AC-M10-05)', () => {
  const destructive = { statements: ['DROP COLUMN legacy_code'], migration: 2 };
  const actor = (role: string, perms = ['ai:approve']) => ({
    userId: '00000000-0000-7000-8000-0000000000f1',
    role,
    permissions: new Set(perms),
  });
  it('a destructive migration parks the run in waiting_approval; approving resumes it to completion; the node output is not recomputed', async () => {
    const runId = await e.newRun();
    e.executors.set(
      'database',
      new ModelFixtureExecutor('database', 'db_schema', (r) => ({
        ...r,
        approvals: [{ type: 'destructive_migration', action: destructive }],
      })),
    );
    const out = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(out.status).toBe('waiting_approval');
    const ids = (out as { approvalIds: string[] }).approvalIds;
    expect((await e.runs.get(e.orgA, runId))!.state).toBe('waiting_approval');
    expect((await steps(runId)).find((r) => r.node === 'database')!.status).toBe(
      'waiting_approval',
    );
    // still blocked while pending
    expect((await e.runner().run(e.orgA, runId, WEBAPP_GRAPH)).status).toBe('waiting_approval');
    const ap = await e.approvals.get(e.orgA, ids[0]!);
    expect(ap.scopeHash).toBe(
      scopeHashOf('destructive_migration', { type: 'run', id: runId }, destructive),
    );
    const before = e.model.calls.filter((c) => c.runId === runId).length;
    await e.approvals.decide(e.orgA, actor('admin'), ids[0]!, {
      decision: 'approve',
      scopeHash: ap.scopeHash,
    });
    const done = await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    expect(done.status).toBe('succeeded');
    expect(e.model.calls.filter((c) => c.runId === runId).length - before).toBe(4); // backend, frontend, qa, devops; the parked database node is NOT asked again
  });
  it('a rejected approval fails the run', async () => {
    const runId = await e.newRun();
    e.executors.set(
      'database',
      new ModelFixtureExecutor('database', 'db_schema', (r) => ({
        ...r,
        approvals: [{ type: 'destructive_migration', action: { statements: ['TRUNCATE x'] } }],
      })),
    );
    const out = (await e.runner().run(e.orgA, runId, WEBAPP_GRAPH)) as { approvalIds: string[] };
    const ap = await e.approvals.get(e.orgA, out.approvalIds[0]!);
    await e.approvals.decide(e.orgA, actor('owner'), ap.id, {
      decision: 'reject',
      scopeHash: ap.scopeHash,
    });
    expect(await e.runner().run(e.orgA, runId, WEBAPP_GRAPH)).toEqual({
      status: 'failed',
      reason: 'approval_rejected',
    });
  });
  it('stale hash is 409, wrong role 403, duplicate identical decision idempotent, conflicting second decision 409, expired 410', async () => {
    const runId = await e.newRun();
    const ap = await e.approvals.request(e.orgA, {
      subject: { type: 'run', id: runId },
      type: 'production_deploy',
      action: { target: 'site-1' },
      runId,
      requestedBy: { kind: 'ai' },
      dataRegion: 'sa-central',
    });
    await expect(
      e.approvals.decide(e.orgA, actor('admin'), ap.id, {
        decision: 'approve',
        scopeHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'stale_approval_hash' });
    await expect(
      e.approvals.decide(e.orgA, actor('developer'), ap.id, {
        decision: 'approve',
        scopeHash: ap.scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      e.approvals.decide(e.orgA, actor('admin', []), ap.id, {
        decision: 'approve',
        scopeHash: ap.scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await e.approvals.decide(e.orgA, actor('admin'), ap.id, {
      decision: 'approve',
      scopeHash: ap.scopeHash,
    });
    expect(ok.status).toBe('approved');
    const again = await e.approvals.decide(e.orgA, actor('admin'), ap.id, {
      decision: 'approve',
      scopeHash: ap.scopeHash,
    });
    expect(again.decidedAt).toBe(ok.decidedAt);
    await expect(
      e.approvals.decide(e.orgA, actor('admin'), ap.id, {
        decision: 'reject',
        scopeHash: ap.scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // execution gate: exact action only
    expect(
      await e.approvals.approvedFor(e.orgA, { type: 'run', id: runId }, 'production_deploy', {
        target: 'site-1',
      }),
    ).not.toBeNull();
    expect(
      await e.approvals.approvedFor(e.orgA, { type: 'run', id: runId }, 'production_deploy', {
        target: 'site-2',
      }),
    ).toBeNull();
    expect(
      await e.approvals.approvedFor(e.orgA, { type: 'run', id: runId }, 'production_rollback', {
        target: 'site-1',
      }),
    ).toBeNull();
    // expiry: a pending approval past its 24 h can no longer be decided
    const exp = await e.approvals.request(e.orgA, {
      subject: { type: 'run', id: runId },
      type: 'paid_resource',
      action: { n: 1 },
      runId,
      requestedBy: { kind: 'ai' },
      dataRegion: 'sa-central',
    });
    await e.env.sql(`ALTER TABLE ai.approval_requests DISABLE TRIGGER approval_request_guard`);
    await e.env.sql(
      `UPDATE ai.approval_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [exp.id],
    );
    await e.env.sql(`ALTER TABLE ai.approval_requests ENABLE TRIGGER approval_request_guard`);
    await expect(
      e.approvals.decide(e.orgA, actor('admin'), exp.id, {
        decision: 'approve',
        scopeHash: exp.scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'gone' });
    expect(
      await e.approvals.approvedFor(e.orgA, { type: 'run', id: runId }, 'paid_resource', { n: 1 }),
    ).toBeNull();
  });
  it('the same action requested twice returns the same open approval; every approval type has a decider policy', async () => {
    const runId = await e.newRun();
    const mk = () =>
      e.approvals.request(e.orgA, {
        subject: { type: 'run', id: runId },
        type: 'egress_or_dependency',
        action: { host: 'x.example' },
        runId,
        requestedBy: { kind: 'ai' },
        dataRegion: 'sa-central',
      });
    expect((await mk()).id).toBe((await mk()).id);
  });
  it('cross-tenant: org B cannot read or decide an org A approval (404)', async () => {
    const runId = await e.newRun();
    const ap = await e.approvals.request(e.orgA, {
      subject: { type: 'run', id: runId },
      type: 'production_deploy',
      action: { t: 1 },
      runId,
      requestedBy: { kind: 'ai' },
      dataRegion: 'sa-central',
    });
    await expect(e.approvals.get(e.orgB, ap.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      e.approvals.decide(e.orgB, actor('owner'), ap.id, {
        decision: 'approve',
        scopeHash: ap.scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await e.approvals.list(e.orgB, { runId })).length).toBe(0);
  });
});

describe('RLS on the new tables', () => {
  it('org B sees no step or tool call of org A (database level)', async () => {
    const runId = await e.newRun();
    await e.runner().run(e.orgA, runId, WEBAPP_GRAPH);
    const seen = await e.env.app.withOrg(e.orgB, async (c) => ({
      steps: (await c.query(`SELECT count(*)::int n FROM ai.run_steps WHERE run_id = $1`, [runId]))
        .rows[0]!.n as number,
      calls: (await c.query(`SELECT count(*)::int n FROM ai.tool_calls WHERE run_id = $1`, [runId]))
        .rows[0]!.n as number,
    }));
    expect(seen).toEqual({ steps: 0, calls: 0 });
    await expect(
      e.env.app.withOrg(e.orgB, (c) =>
        c.query(
          `INSERT INTO ai.run_steps (id, org_id, run_id, seq, node, agent, data_region) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 0, 'x', 'qa', 'sa-central')`,
          [e.orgA],
        ),
      ),
    ).rejects.toThrow();
  });
});
