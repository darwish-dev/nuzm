import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { builderTools } from '@nuzm/domain';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunService } from '../ai';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { BuilderLifecycleService } from './internal/lifecycle/lifecycle.service';
import { REAL_PATH_APPROVALS } from './internal/lifecycle/lifecycle.flags';

/**
 * P3-S03 (acceptance L5 and L3): on the real run engine and a real database,
 *  - the REAL path (flag `builder_lifecycle.real_path`, default off) REFUSES, with a specific code and no silent fallback, when an approval, model generation, the gateway or a REAL
 *    build port is missing: no step ran, no build was requested, the refusal is audited;
 *  - a settled run carries an evidence record whose claim is computed from what ran (never LIVE-VERIFIED for a scripted build) and whose reconciliation of the four spending records
 *    (lifecycle state, `ai.model_usage`, `ai.runs`, `ai.reservations`) holds, and the wallet moved by exactly the credits the usage rows record.
 * Builds are scripted ports (origin MOCK, nothing executes) and the model is the dev-reference mock: every claim here is SIMULATED.
 */
let e: AiEnv;
let runs: RunService;
let svc: BuilderLifecycleService;
const A = () => e.org.A!;
const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await e.sql(sql, p)) as Row[];
const call = (who: string, method: 'GET' | 'POST', url: string, body?: object) =>
  e.call(who, method, url, body, A(), { 'idempotency-key': randomUUID() });
const BRIEF = 'An online store with products, a cart and checkout, sign in, and an admin dashboard';

class ScriptPort implements builderTools.BuildPort {
  readonly origin: 'MOCK' | 'REAL';
  calls: string[] = [];
  constructor(
    origin: 'MOCK' | 'REAL' = 'MOCK',
    private readonly failing = false,
  ) {
    this.origin = origin;
  }
  async build(req: builderTools.BuildRequest): Promise<builderTools.BuildResult> {
    this.calls.push(req.profile);
    return this.failing
      ? {
          status: 'failed',
          logs: 'src/index.ts(1,1): error TS2304: boom\n',
          artifacts: [],
          durationMs: 1,
        }
      : { status: 'completed', logs: '', artifacts: [], durationMs: 1 };
  }
}
const use = (port: ScriptPort | null) => {
  svc.buildPortOverride = () => port;
  return port;
};
async function setFlag(key: string, value: unknown) {
  await q(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [key, A()]);
  if (value !== null)
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [key, A(), JSON.stringify(value)],
    );
}
const approvals = (skip: string[] = []) =>
  REAL_PATH_APPROVALS.filter((a) => !skip.includes(a.id)).map((a) => ({
    id: a.id,
    ref: `EVIDENCE-${a.id}`,
    recordedAt: '2026-11-24T00:00:00Z',
  }));
async function project(name: string) {
  const id = (
    await call('alice', 'POST', '/v1/builder/projects', {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      type: 'webapp',
    })
  ).json().id as string;
  expect(
    (
      await call('alice', 'POST', `/v1/builder/projects/${id}/changes`, {
        baseVersion: null,
        source: 'user',
        patches: [{ op: 'add', path: 'README.md', content: '# demo\n' }],
      })
    ).statusCode,
  ).toBe(200);
  return id;
}
async function newRun(p: string, extra: Row = {}) {
  const sid = (await call('alice', 'POST', '/v1/ai/sessions', { title: 'x', projectId: p })).json()
    .id as string;
  const r = await call('alice', 'POST', '/v1/ai/runs', {
    sessionId: sid,
    kind: 'webapp',
    projectId: p,
    input: { builderLifecycle: true, brief: { prompt: BRIEF }, ...extra },
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().id as string;
}
const row = async (id: string) =>
  (await q(`SELECT state, error, result, checkpoint FROM ai.runs WHERE id = $1`, [id]))[0]!;
const stepCount = async (id: string) =>
  (await q(`SELECT count(*)::int n FROM ai.run_steps WHERE run_id = $1`, [id]))[0]!.n as number;
const decided = (id: string) =>
  e.sink.events.filter(
    (x) => x.action === 'builder.lifecycle.real_path_decided' && x.resource?.id === id,
  );

beforeAll(async () => {
  process.env.AI_MAX_CONCURRENT_RUNS = '500';
  process.env.BUILDER_MAX_PROJECTS = '500';
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  svc = e.app.get(BuilderLifecycleService);
  await e.enableMock('mock-model', { adapter: new MockModelAdapter({ id: 'mock-model' }) });
  for (const k of ['app_builder.enabled', 'builder_tools.enabled', 'builder_lifecycle.enabled'])
    await setFlag(k, true);
  await e.fund(A(), '50000000');
}, 300_000);
afterAll(() => {
  svc.buildPortOverride = null;
  return e.h.close();
});

describe(
  'the real path refuses instead of falling back (flag builder_lifecycle.real_path)',
  {
    timeout: 240_000,
  },
  () => {
    const expectRefused = async (code: string, port: ScriptPort | null) => {
      const id = await newRun(await project(`Refuse ${code}`));
      await runs.tick();
      const r = await row(id);
      expect(r.state).toBe('failed');
      expect((r.error as Row).code).toBe(code);
      expect(await stepCount(id)).toBe(0); // nothing of the lifecycle ran
      if (port) expect(port.calls).toEqual([]); // no build was requested
      const d = decided(id);
      expect(d).toHaveLength(1);
      expect(d[0]!.outcome).toBe('failure');
      expect(JSON.stringify(d[0])).toContain(code);
      return id;
    };

    it('the flag is off by default: a run that does not ask for the real path is not affected by it', async () => {
      use(new ScriptPort());
      await setFlag('builder_lifecycle.real_path', null);
      const id = await newRun(await project('Real Path Off'));
      await runs.tick();
      expect((await row(id)).state).toBe('waiting_approval');
      expect(decided(id)).toHaveLength(0);
    });

    it('enabled with no approvals recorded: real_path_approval_missing, nothing runs', async () => {
      const port = use(new ScriptPort('REAL'));
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: [] });
      await expectRefused('real_path_approval_missing', port);
    });

    it('one approval missing from the record is still a refusal, and the audit names it', async () => {
      const port = use(new ScriptPort('REAL'));
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: approvals(['D5']) });
      const id = await expectRefused('real_path_approval_missing', port);
      expect(JSON.stringify(decided(id)[0])).toContain('D5');
    });

    it('every approval recorded but model generation off: model_generation_off', async () => {
      const port = use(new ScriptPort('REAL'));
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: approvals() });
      await setFlag('builder_lifecycle.model_generation', null);
      await expectRefused('model_generation_off', port);
    });

    it('approvals and model generation on but the build port is a mock: real_runtime_simulated (never accepted as real)', async () => {
      const port = use(new ScriptPort('MOCK'));
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: approvals() });
      await setFlag('builder_lifecycle.model_generation', true);
      await expectRefused('real_runtime_simulated', port);
    });

    it('approvals and model generation on but no build port at all: real_runtime_unavailable', async () => {
      use(null);
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: approvals() });
      await setFlag('builder_lifecycle.model_generation', true);
      await expectRefused('real_runtime_unavailable', null);
    });

    it('the refusal changes nothing: no version was written and the wallet did not move', async () => {
      const port = use(new ScriptPort('MOCK'));
      await setFlag('builder_lifecycle.real_path', { enabled: true, approvals: approvals() });
      await setFlag('builder_lifecycle.model_generation', true);
      const p = await project('Refuse Untouched');
      const head = (
        await q(`SELECT head_version_id h FROM builder.projects WHERE id = $1`, [p])
      )[0]!.h;
      const wallet = await e.wallet(A());
      const id = await newRun(p);
      await runs.tick();
      expect((await row(id)).state).toBe('failed');
      expect(
        (await q(`SELECT head_version_id h FROM builder.projects WHERE id = $1`, [p]))[0]!.h,
      ).toBe(head);
      expect(await e.wallet(A())).toBe(wallet);
      expect(port.calls).toEqual([]);
      await setFlag('builder_lifecycle.real_path', null);
      await setFlag('builder_lifecycle.model_generation', null);
    });
  },
);

describe('evidence and wallet reconciliation of a settled run', { timeout: 240_000 }, () => {
  it('a model-backed run that settles carries an evidence record (never LIVE-VERIFIED) whose four spending records agree, and the wallet moved by exactly the recorded credits', async () => {
    use(new ScriptPort('MOCK', true)); // every build fails and a single repair round, which fixes nothing, so the run settles (failed) whatever the model wrote
    await setFlag('builder_lifecycle.real_path', null);
    await setFlag('builder_lifecycle.model_generation', true);
    const p = await project('Evidence Run');
    const walletBefore = await e.wallet(A());
    const id = await newRun(p, { maxRepairRounds: 1 });
    await runs.tick();
    const r = await row(id);
    expect(['failed', 'budget_exceeded']).toContain(r.state);
    // the dev-reference model's answer may or may not be a valid file set: either way the run settled and what it spent is accounted
    const usage = (
      await q(
        `SELECT count(*)::int n, coalesce(sum(credits),0)::bigint cr FROM ai.model_usage WHERE run_id = $1`,
        [id],
      )
    )[0]!;
    expect(Number(usage.n)).toBeGreaterThan(0);
    // credit unit 1 minor: the wallet drew down exactly what the usage rows record
    expect(walletBefore - (await e.wallet(A()))).toBe(BigInt(String(usage.cr)));
    const art = await q(
      `SELECT payload FROM ai.artifacts WHERE run_id = $1 AND type = 'evaluation_report'`,
      [id],
    );
    expect(art).toHaveLength(1);
    const payload = art[0]!.payload as {
      evidence: { claim: string; label: string };
      reconciliation: { ok: boolean; checks: { name: string; ok: boolean }[] };
    };
    expect(['SIMULATED', 'MIXED']).toContain(payload.evidence.claim);
    expect(JSON.stringify(payload)).not.toContain('"LIVE-VERIFIED"');
    expect(payload.reconciliation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(payload.reconciliation.ok).toBe(true);
    expect(
      e.sink.events.some(
        (x) =>
          x.action === 'builder.lifecycle.reconciled' &&
          x.resource?.id === id &&
          x.outcome === 'success',
      ),
    ).toBe(true);
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM ai.run_events WHERE run_id = $1 AND type = 'lifecycle_evidence'`,
          [id],
        )
      )[0]!.n,
    ).toBe(1);
  });
});
