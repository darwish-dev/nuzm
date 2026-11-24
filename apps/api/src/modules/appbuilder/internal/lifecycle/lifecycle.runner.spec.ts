import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';

const T = builderTools;
const ALL = [
  'requirements',
  'project_analysis',
  'architecture',
  'plan',
  'tasks',
  'file_generation',
  'change_apply',
  'review',
  'execution_request',
  'build',
  'tests',
  'preview',
  'deployment_preparation',
  'deployment_approval',
];
const scripted = (env: MemoryEnv) => env.build as builderTools.ScriptedBuildPort;
const BROKEN = { 'tsconfig.json': '{"compilerOptions":{},}\n', 'src/index.ts': 'export {};\n' };

const setup = (files: Record<string, string> = {}) => {
  const host = new MemoryHost();
  const env = new MemoryEnv();
  if (Object.keys(files).length) {
    env.files = new Map(Object.entries(files));
    env.versionId = '0198a3c0-aaaa-7000-8000-000000000000';
  }
  return { host, env, runner: new LifecycleRunner() };
};

describe('the lifecycle, offline, with scripted components', () => {
  it('runs all steps in order, parks at the deployment approval, and finishes when it is approved', async () => {
    const { host, env, runner } = setup();
    const out = await runner.run(host, env);
    expect(out.status).toBe('waiting_approval');
    expect(host.stepNames()).toEqual(ALL);
    expect(out.state.steps.repair.status).toBe('skipped');
    // the plan's files were added as ONE validated change on the AI path
    expect(env.applied).toHaveLength(1);
    expect(env.applied[0]!.ops.every((o) => o.op === 'add')).toBe(true);
    expect(env.applied[0]!.ops.map((o) => o.path)).toContain('nuzm.memory.json');
    expect(out.artifacts.generator).toBe('skeleton');
    expect(out.artifacts.appliedVersionId).toBe(env.versionId);
    // every step has a persistent record, an audit event, a checkpoint save
    expect(host.steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(host.audits.filter((a) => a.action === 'builder.lifecycle.step_finished')).toHaveLength(
      ALL.length - 1 + 0 + 1,
    );
    expect(host.audits[0]!.action).toBe('builder.lifecycle.started');
    expect(host.runState).toEqual(['waiting_approval']);
    expect(env.approvalsRequested).toHaveLength(1);
    expect(env.approvalsRequested[0]).toMatchObject({
      kind: 'builder_lifecycle_deployment',
      readiness: 'needs_attention',
    });
    expect(env.approvalsRequested[0]!['blockers']).toContain('simulated_evidence');
    // nothing was deployed and every execution was metered once: typecheck, build, unit-tests
    expect(env.budget.metered.map((m) => m.profile)).toEqual(['typecheck', 'build', 'unit-tests']);
    expect(env.budget.metered.every((m) => m.origin === 'MOCK')).toBe(true);
    expect(env.budget.starts).toEqual(['ai_run_build']);

    // the approval is decided later: a NEW runner resumes from the checkpoint and finishes without re-running a step
    env.approvalStatus = 'approved';
    const before = host.steps.length;
    host.cancel = false;
    const done = await new LifecycleRunner().run(host, env);
    expect(done.status).toBe('succeeded');
    expect(host.steps).toHaveLength(before);
    expect(host.runState).toEqual(['waiting_approval', 'running']);
    expect(T.lifecycle.progress(done.state).percent).toBe(100);
  });

  it('stays parked while the approval is open, and a denied one is an outcome, not a failure', async () => {
    const { host, env, runner } = setup();
    await runner.run(host, env);
    expect((await new LifecycleRunner().run(host, env)).status).toBe('waiting_approval');
    env.approvalStatus = 'rejected';
    const done = await new LifecycleRunner().run(host, env);
    expect(done.status).toBe('succeeded');
    expect(done.state.steps.deployment_approval.status).toBe('denied');
    env.approvalStatus = 'expired';
  });

  it('repairs a failing build and goes on: error analysis → repair → apply → rebuild → tests', async () => {
    const { host, env, runner } = setup(BROKEN);
    scripted(env).script(
      'typecheck',
      { status: 'failed', logs: 'tsconfig.json(1,1): error TS5083: cannot read file\n' },
      { status: 'completed' },
    );
    const out = await runner.run(host, env);
    expect(out.status).toBe('waiting_approval');
    const names = host.stepNames();
    expect(names.slice(names.indexOf('build'), names.indexOf('tests') + 1)).toEqual([
      'build',
      'error_analysis',
      'repair',
      'repair_apply',
      'rebuild',
      'tests',
    ]);
    expect(out.state.repairRound).toBe(1);
    expect(JSON.parse(env.files.get('tsconfig.json')!)).toEqual({ compilerOptions: {} });
    // the repair was applied as its own validated change, after the generation
    expect(env.applied.map((a) => a.label.split(' ')[0])).toEqual(['Builder', 'Repair']);
    expect(out.artifacts.repairedVersions).toHaveLength(1);
    // build, rebuild and tests all metered, each with its own key (no double count on a resume)
    const keys = env.budget.metered.map((m) => m.eventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  it('stops when the same failure comes back after a repair (no progress) instead of looping', async () => {
    const { host, env, runner } = setup(BROKEN);
    const log = {
      status: 'failed' as const,
      logs: 'src/index.ts(1,1): error TS2304: Cannot find name x\n',
    };
    scripted(env).scriptDefault((req) => (req.profile === 'unit-tests' ? {} : log));
    // a repair that "changes" something but does not help: it touches an unrelated file
    let n = 0;
    env.repair = {
      propose: async () => ({
        ops: [{ op: 'add', path: `src/fix${++n}.ts`, content: 'export {};\n' }],
      }),
    };
    const out = await runner.run(host, env);
    expect(out.status).toBe('failed');
    expect(out.state.failure?.code).toBe('no_progress');
    expect(out.state.repairRound).toBeLessThanOrEqual(2);
  });

  it('ends with repair_exhausted at the round limit', async () => {
    const { host, env, runner } = setup(BROKEN);
    host.input.maxRepairRounds = 2;
    let n = 0;
    scripted(env).scriptDefault((req) =>
      req.profile === 'unit-tests'
        ? {}
        : { status: 'failed', logs: `src/index.ts(1,1): error TS${2300 + ++n}: boom ${n}\n` },
    );
    env.repair = {
      propose: async () => ({
        ops: [{ op: 'add', path: `src/fix${++n}.ts`, content: 'export {};\n' }],
      }),
    };
    const out = await runner.run(host, env);
    expect(out.status).toBe('failed');
    expect(out.state.failure?.code).toBe('repair_exhausted');
    expect(out.state.repairRound).toBe(2);
  });

  it('a repair strategy with nothing to offer ends the run with strategy_gave_up', async () => {
    const { host, env, runner } = setup(BROKEN);
    scripted(env).script('typecheck', {
      status: 'failed',
      logs: 'src/index.ts(1,1): error TS2304: x\n',
    });
    env.repair = { propose: async () => null };
    const out = await runner.run(host, env);
    expect(out.state.failure).toEqual({ step: 'repair', code: 'strategy_gave_up' });
  });

  it('failing tests re-enter the repair loop', async () => {
    const { host, env, runner } = setup(BROKEN);
    scripted(env).script(
      'unit-tests',
      { status: 'failed', logs: 'FAIL src/a.test.ts\n  ● a › works\n    expected 1 to be 2\n' },
      { status: 'completed' },
    );
    const out = await runner.run(host, env);
    expect(out.status).toBe('waiting_approval');
    expect(host.stepNames().filter((s) => s === 'tests')).toHaveLength(2);
    expect(out.state.repairRound).toBe(1);
  });
});

describe('refusals, limits and cancellation', () => {
  it('without a build service the execution steps refuse and nothing is built', async () => {
    const { host, env, runner } = setup();
    env.build = null;
    const out = await runner.run(host, env);
    expect(out.state.failure).toEqual({ step: 'execution_request', code: 'build_unavailable' });
    expect(env.budget.metered).toEqual([]);
  });
  it('a budget gate that refuses (no AI wallet under the legacy rule, or an exhausted build allowance) fails the step with its own code', async () => {
    for (const code of ['budget_required', 'quota_exceeded']) {
      const { host, env, runner } = setup();
      env.budget.deny = { code };
      const out = await runner.run(host, env);
      expect(out.state.failure).toEqual({ step: 'execution_request', code });
    }
  });
  it('the gateway refusing a profile is never retried and is never run', async () => {
    const { host, env, runner } = setup();
    (env.build as unknown as { preflight: unknown }).preflight = async () => ({
      allowed: false,
      reasons: ['profile_not_enabled'],
      requiresApproval: false,
    });
    const out = await runner.run(host, env);
    expect(out.state.failure).toMatchObject({ step: 'execution_request', code: 'build_refused' });
    expect(scripted(env).calls).toEqual([]);
    expect(host.steps.filter((s) => s.step === 'execution_request')).toHaveLength(1);
  });
  it('a timeout is a stop, not a repair', async () => {
    const { host, env, runner } = setup(BROKEN);
    scripted(env).script('typecheck', { status: 'timeout' });
    const out = await runner.run(host, env);
    expect(out.state.failure).toEqual({ step: 'build', code: 'build_timeout' });
    expect(host.stepNames()).not.toContain('repair');
  });
  it('a transient error gets one more attempt of that step only', async () => {
    const { host, env, runner } = setup();
    let calls = 0;
    const real = env.generator;
    env.generator = {
      kind: 'skeleton',
      generate: async (i, c, s) =>
        ++calls === 1 ? Promise.reject(new Error('flaky')) : real.generate(i, c, s),
    };
    const out = await runner.run(host, env);
    expect(out.status).toBe('waiting_approval');
    const gen = host.steps.filter((s) => s.step === 'file_generation');
    expect(gen.map((g) => g.status)).toEqual(['failed', 'succeeded']);
    expect(gen.map((g) => g.attempt)).toEqual([1, 2]);
  });
  it('a viewer cannot generate or apply: the registry denies the tool and the step fails with its code', async () => {
    const { host, env, runner } = setup();
    host.permissions = new Set(['builder:read']);
    const out = await runner.run(host, env);
    expect(out.state.failure).toEqual({ step: 'file_generation', code: 'permission_denied' });
    expect(env.applied).toEqual([]);
    const denied = out.state.invocations.filter((i) => i.status === 'denied');
    expect(denied.map((d) => d.tool)).toContain('propose_files');
  });
  it('an invalid or empty brief fails the first step', async () => {
    const { host, env, runner } = setup();
    host.input.prompt = '   ';
    const out = await runner.run(host, env);
    expect(out.state.failure).toEqual({ step: 'requirements', code: 'invalid_input' });
  });
  it('the run token budget stops a model-backed step BEFORE it calls a model', async () => {
    const { host, env, runner } = setup();
    env.modelBacked.file_generation = true;
    host.budget = { maxTokens: 1000 };
    let called = false;
    env.generator = { kind: 'model', generate: async () => ((called = true), { ops: [] }) };
    const out = await runner.run(host, env);
    expect(called).toBe(false);
    expect(out.state.failure?.code).toBe('tokens_exceeded');
  });
  it('accounts the tokens and credits of model steps in the state and in the run events', async () => {
    const { host, env, runner } = setup();
    env.modelBacked.file_generation = true;
    const real = env.generator;
    env.generator = {
      kind: 'model',
      generate: async (i, c, s) => {
        env.usage = { tokensIn: 700, tokensOut: 300, credits: '12' };
        return real.generate(i, c, s);
      },
    };
    const out = await runner.run(host, env);
    expect(out.state.tokensIn).toBe(700);
    expect(out.state.tokensOut).toBe(300);
    expect(out.state.credits).toBe('12');
    expect(out.state.steps.file_generation.tokensIn).toBe(700);
    const ev = host.events.find(
      (e) =>
        e.type === 'lifecycle_step' &&
        e.data?.['step'] === 'file_generation' &&
        e.data?.['status'] === 'succeeded',
    );
    expect((ev!.data!['progress'] as { tokens: number }).tokens).toBe(1000);
  });
  it('a cancel request stops between steps, finishes as cancelled and leaves a resumable record', async () => {
    const { host, env, runner } = setup();
    host.cancelAfterSaves = 6;
    const out = await runner.run(host, env);
    expect(out.status).toBe('cancelled');
    expect(host.stepNames().length).toBeLessThan(ALL.length);
    expect(env.applied.length).toBeLessThanOrEqual(1);
    expect(
      Object.values(out.state.steps).some((s) => s.status === 'running' || s.status === 'pending'),
    ).toBe(false);
    expect(host.events.at(-1)).toMatchObject({
      type: 'lifecycle_finished',
      data: { status: 'cancelled' },
    });
    // a second run call on the finished checkpoint does nothing
    const again = await new LifecycleRunner().run(host, env);
    expect(again.status).toBe('cancelled');
    expect(host.stepNames().length).toBe(out.state.stepRuns);
  });
  it('cancels while parked at the approval', async () => {
    const { host, env, runner } = setup();
    await runner.run(host, env);
    host.cancel = true;
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('cancelled');
  });
  it('the overall step ceiling stops a run nobody foresaw', async () => {
    const { host, env, runner } = setup();
    host.input.maxMinutes = 1;
    host.clock = 61; // the clock has already run past the limit
    const out = await runner.run(host, env);
    expect(out.status).toBe('failed');
    expect(out.state.failure?.code).toBe('time_exceeded');
  });
  it('resumes after a crash: the step that was running is re-run, a finished one never is', async () => {
    const { host, env, runner } = setup();
    host.crashAfterSaves = 9; // dies while saving inside the run
    await expect(runner.run(host, env)).rejects.toThrow('simulated crash');
    host.crashAfterSaves = null;
    const stepsBefore = host.steps.length;
    const out = await new LifecycleRunner().run(host, env);
    expect(out.status).toBe('waiting_approval');
    // every step ran to the end exactly once more only where it had not finished
    const finished = host.steps.filter((s) => s.status === 'succeeded').map((s) => s.step);
    expect(new Set(finished).size).toBe(finished.length);
    expect(host.steps.length).toBeGreaterThanOrEqual(stepsBefore);
    expect(env.applied.length).toBe(1);
  });
});
