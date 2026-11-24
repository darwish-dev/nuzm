import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { builderTools } from '@nuzm/domain';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunService, WorkerCrash } from '../ai';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { BuilderLifecycleService } from './internal/lifecycle/lifecycle.service';

/**
 * PHASE-2 S05, evidence that cancellation, limits, budget stops and crash recovery of the builder agent loop work on the REAL run engine and its SCHEDULER (`RunService.tick`, the
 * operations queue, leases, `cancel_requested`), not only in the pure state machine. Builds are scripted ports (MOCK; nothing executes), the model is the scripted dev-reference one.
 */
let e: AiEnv;
let runs: RunService;
let svc: BuilderLifecycleService;
const A = () => e.org.A!;
const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await e.sql(sql, p)) as Row[];
const call = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
  e.call(who, method, url, body, A(), { 'idempotency-key': randomUUID() });
const BRIEF = 'An online store with products, a cart and checkout, sign in, and an admin dashboard';

/** a build port whose behaviour a test scripts per profile and call number; it never executes anything */
class ScriptPort implements builderTools.BuildPort {
  readonly origin = 'MOCK' as const;
  calls: string[] = [];
  constructor(
    private readonly on: (
      profile: string,
      n: number,
    ) =>
      Promise<Partial<builderTools.BuildResult>> | Partial<builderTools.BuildResult> = () => ({}),
  ) {}
  async build(req: builderTools.BuildRequest): Promise<builderTools.BuildResult> {
    this.calls.push(req.profile);
    const n = this.calls.filter((c) => c === req.profile).length;
    const r = await this.on(req.profile, n);
    return { status: 'completed', logs: '', artifacts: [], durationMs: 1, ...r };
  }
}
const use = (port: ScriptPort) => {
  svc.buildPortOverride = () => port;
  return port;
};

async function project(name: string, files: Record<string, string> = {}) {
  const id = (await call('alice', 'POST', '/v1/builder/projects', { name, type: 'webapp' })).json()
    .id as string;
  const patches = Object.entries({ 'README.md': '# demo\n', ...files }).map(([path, content]) => ({
    op: 'add',
    path,
    content,
  }));
  expect(
    (
      await call('alice', 'POST', `/v1/builder/projects/${id}/changes`, {
        baseVersion: null,
        source: 'user',
        patches,
      })
    ).statusCode,
  ).toBe(200);
  return id;
}
async function newRun(p: string, extra: Row = {}, budget?: Row) {
  const sid = (await call('alice', 'POST', '/v1/ai/sessions', { title: 'x', projectId: p })).json()
    .id as string;
  const r = await call('alice', 'POST', '/v1/ai/runs', {
    sessionId: sid,
    kind: 'webapp',
    projectId: p,
    input: { builderLifecycle: true, brief: { prompt: BRIEF }, ...extra },
    ...(budget ? { budget } : {}),
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().id as string;
}
const row = async (id: string) =>
  (
    await q(`SELECT state, error, result, checkpoint, operation_id FROM ai.runs WHERE id = $1`, [
      id,
    ])
  )[0]!;
const lc = (r: Row) => (r.checkpoint as Row).lifecycle as Row;
const stepNodes = async (id: string) =>
  (
    await q(
      `SELECT node, status, attempt FROM ai.run_steps WHERE run_id = $1 AND node LIKE 'lc-%' ORDER BY seq`,
      [id],
    )
  ).map((r) => `${String(r.node).replace(/^lc-|-r\d$/g, '')}:${r.status}`);

beforeAll(async () => {
  process.env.AI_MAX_CONCURRENT_RUNS = '500';
  process.env.BUILDER_MAX_PROJECTS = '500';
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  svc = e.app.get(BuilderLifecycleService);
  await e.enableMock('mock-model', { adapter: new MockModelAdapter({ id: 'mock-model' }) });
  for (const [k, v] of [
    ['app_builder.enabled', true],
    ['builder_tools.enabled', true],
    ['builder_lifecycle.enabled', true],
  ] as const)
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [k, A(), JSON.stringify(v)],
    );
  await e.fund(A(), '50000000');
}, 300_000);
afterAll(() => {
  svc.buildPortOverride = null;
  return e.h.close();
});

describe('the scheduler drives the lifecycle', { timeout: 240_000 }, () => {
  it('RunService.tick (the worker loop, not a direct call) picks up a queued lifecycle run and parks it at the approval', async () => {
    use(new ScriptPort());
    const id = await newRun(await project('Engine Tick'));
    expect((await row(id)).state).toBe('queued');
    const t = await runs.tick();
    expect(t.ran).toBeGreaterThanOrEqual(1);
    const r = await row(id);
    expect(r.state).toBe('waiting_approval');
    expect(await stepNodes(id)).toHaveLength(14);
    // a second tick finds nothing to do for a parked run
    const before = await stepNodes(id);
    await runs.tick();
    expect(await stepNodes(id)).toEqual(before);
    await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`);
  });
});

describe('cancellation on the real engine', { timeout: 240_000 }, () => {
  it('a run cancelled before the scheduler reaches it never starts: no step, no project change, no approval', async () => {
    const p = await project('Engine Cancel Queued');
    const head = (await q(`SELECT head_version_id h FROM builder.projects WHERE id = $1`, [p]))[0]!
      .h;
    const id = await newRun(p);
    expect((await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`)).statusCode).toBe(202);
    await runs.tick();
    expect((await row(id)).state).toBe('cancelled');
    expect(await stepNodes(id)).toEqual([]);
    expect(
      (await q(`SELECT head_version_id h FROM builder.projects WHERE id = $1`, [p]))[0]!.h,
    ).toBe(head);
    expect(
      (await q(`SELECT count(*)::int n FROM ai.approval_requests WHERE run_id = $1`, [id]))[0]!.n,
    ).toBe(0);
  });
  it('a cancel that arrives WHILE a build is running stops before the next step: the run ends cancelled, nothing after the build ran, no approval is requested', async () => {
    let id = '';
    const port = use(
      new ScriptPort(async (profile) => {
        if (profile === 'typecheck')
          expect((await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`)).statusCode).toBe(
            202,
          );
        return {};
      }),
    );
    id = await newRun(await project('Engine Cancel Mid'));
    await runs.runOne(A(), (await row(id)).operation_id as string);
    const r = await row(id);
    expect(r.state).toBe('cancelled');
    const nodes = await stepNodes(id);
    expect(nodes.at(-1)).toBe('build:succeeded'); // the step in flight finished; nothing started after it
    expect(
      nodes.some(
        (n) => n.startsWith('tests') || n.startsWith('preview') || n.startsWith('deployment'),
      ),
    ).toBe(false);
    expect(port.calls).toEqual(['typecheck', 'build']);
    expect(lc(r).state.status).toBe('cancelled');
    expect(
      (await q(`SELECT count(*)::int n FROM ai.approval_requests WHERE run_id = $1`, [id]))[0]!.n,
    ).toBe(0);
    const ev = (
      await q(`SELECT type, data FROM ai.run_events WHERE run_id = $1 ORDER BY seq DESC LIMIT 3`, [
        id,
      ])
    ).map((x) => x.type);
    expect(ev).toContain('lifecycle_finished');
    // the scheduler does not pick it up again
    await runs.tick();
    expect(await stepNodes(id)).toEqual(nodes);
  });
  it('cancelling a run parked at the approval ends it cancelled', async () => {
    use(new ScriptPort());
    const id = await newRun(await project('Engine Cancel Parked'));
    await runs.tick();
    expect((await row(id)).state).toBe('waiting_approval');
    expect((await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`)).statusCode).toBe(202);
    expect((await row(id)).state).toBe('cancelled');
  });
});

describe('limits and budget stops on the real engine', { timeout: 240_000 }, () => {
  it('a build that keeps failing is repaired within the round limit and then stops: failed / repair_exhausted, with the repairs applied as validated versions', async () => {
    let n = 0;
    use(
      new ScriptPort((profile) =>
        profile === 'unit-tests'
          ? {}
          : { status: 'failed', logs: `src/index.ts(1,1): error TS${2300 + ++n}: boom ${n}\n` },
      ),
    );
    const p = await project('Engine Exhausted', { 'src/index.ts': 'export {};\n' });
    // a repair that always has something to propose but never fixes the cause
    let k = 0;
    const original = (svc as unknown as { env: (c: unknown) => Promise<Row> }).env.bind(svc);
    (svc as unknown as { env: (c: unknown) => Promise<Row> }).env = async (c) => {
      const env = await original(c);
      env.repair = {
        propose: async () => ({
          ops: [{ op: 'add', path: `src/fix${++k}.ts`, content: 'export {};\n' }],
        }),
      };
      return env;
    };
    try {
      const id = await newRun(p, { maxRepairRounds: 2 });
      await runs.tick();
      const r = await row(id);
      expect(r.state).toBe('failed');
      expect((r.error as Row).code).toBe('repair_exhausted');
      expect(lc(r).state.repairRound).toBe(2);
      expect(lc(r).state.failure).toEqual({ step: 'rebuild', code: 'repair_exhausted' });
      // one version for the generated files and one per repair round: every change went through the safe pipeline
      expect(
        (
          await q(`SELECT count(*)::int n FROM builder.project_versions WHERE project_id = $1`, [p])
        )[0]!.n,
      ).toBe(4);
      expect(
        (await q(`SELECT count(*)::int n FROM ai.approval_requests WHERE run_id = $1`, [id]))[0]!.n,
      ).toBe(0);
    } finally {
      (svc as unknown as { env: unknown }).env = original;
    }
  });
  it('a build the gateway refuses stops the run once (never retried) and nothing was built', async () => {
    const port = use(
      new ScriptPort(() => ({ status: 'refused', logs: 'refused: profile_not_enabled\n' })),
    );
    const id = await newRun(await project('Engine Refused'));
    await runs.tick();
    const r = await row(id);
    expect(r.state).toBe('failed');
    expect((r.error as Row).code).toBe('build_refused');
    expect(port.calls).toEqual(['typecheck']);
  });
  it('a build timeout stops the run as failed / build_timeout, and a transient step error gets exactly one more attempt', async () => {
    use(new ScriptPort(() => ({ status: 'timeout' })));
    const id = await newRun(await project('Engine Timeout'));
    await runs.tick();
    expect((await row(id)).error).toMatchObject({ code: 'build_timeout' });
  });
  it('the run token budget ends the run in state budget_exceeded (not failed) before any model call when model generation is on', async () => {
    use(new ScriptPort());
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'builder_lifecycle.model_generation', $1, 'true'::jsonb)`,
      [A()],
    );
    try {
      const id = await newRun(await project('Engine Budget'), {}, { maxTokens: 500 });
      await runs.tick();
      const r = await row(id);
      expect(r.state).toBe('budget_exceeded');
      expect(lc(r).state.failure.code).toBe('tokens_exceeded');
      expect(
        (await q(`SELECT count(*)::int n FROM ai.model_usage WHERE run_id = $1`, [id]))[0]!.n,
      ).toBe(0);
    } finally {
      await q(
        `DELETE FROM platform.feature_flags WHERE key = 'builder_lifecycle.model_generation' AND org_id = $1`,
        [A()],
      );
    }
  });
});

describe('crash recovery on the real engine', { timeout: 240_000 }, () => {
  it('a worker that dies right after a finished step resumes from the checkpoint: no step runs twice, the build is not repeated, the project is changed once', async () => {
    const port = use(new ScriptPort());
    const p = await project('Engine Crash After');
    const id = await newRun(p);
    const op = (await row(id)).operation_id as string;
    runs.afterStep = (s) => {
      if (s === 'build:done') throw new WorkerCrash('boom');
    };
    await expect(runs.runOne(A(), op)).rejects.toBeInstanceOf(WorkerCrash);
    runs.afterStep = undefined;
    expect((await row(id)).state).toBe('running');
    await q(
      `UPDATE platform.operations SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [op],
    );
    await runs.runOne(A(), op);
    const r = await row(id);
    expect(r.state).toBe('waiting_approval');
    const nodes = await stepNodes(id);
    expect(nodes).toHaveLength(14);
    expect(new Set(nodes).size).toBe(14);
    expect(port.calls).toEqual(['typecheck', 'build', 'unit-tests']); // the finished build was not run again
    expect(
      (
        await q(`SELECT count(*)::int n FROM builder.project_versions WHERE project_id = $1`, [p])
      )[0]!.n,
    ).toBe(2);
    await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`);
  });
  it('a worker that dies INSIDE a build (the step is left running) re-runs that step after the lease expires, attempt unchanged, and the run still finishes', async () => {
    let first = true;
    use(
      new ScriptPort(() => {
        if (first) {
          first = false;
          throw new WorkerCrash('died inside the build');
        }
        return {};
      }),
    );
    const id = await newRun(await project('Engine Crash Inside'));
    const op = (await row(id)).operation_id as string;
    await expect(runs.runOne(A(), op)).rejects.toBeInstanceOf(WorkerCrash);
    const mid = await q(
      `SELECT status, attempt FROM ai.run_steps WHERE run_id = $1 AND node = 'lc-build-r0'`,
      [id],
    );
    expect(mid[0]).toMatchObject({ status: 'running', attempt: 1 });
    await q(
      `UPDATE platform.operations SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [op],
    );
    await runs.runOne(A(), op);
    expect((await row(id)).state).toBe('waiting_approval');
    expect(
      (
        await q(
          `SELECT status, attempt FROM ai.run_steps WHERE run_id = $1 AND node = 'lc-build-r0'`,
          [id],
        )
      )[0],
    ).toMatchObject({ status: 'succeeded', attempt: 1 });
    await call('alice', 'POST', `/v1/ai/runs/${id}/cancellation`);
  });
});
