import { describe, expect, it } from 'vitest';
import { createMockExecutionPort } from '../../execution-gateway';
import { ExecutionBuildPort, RuleBasedRepair, runRepairLoop } from './index';

/**
 * The adapter against Session 04's REAL `MockExecutionPort` (wired to the real `decideExec` policy), not a stand-in. The mock executes nothing: every outcome below is scripted.
 */
const ctx = (enabledProfiles: string[]) => ({
  orgId: 'o',
  runId: 'r',
  enabledProfiles,
  projectScripts: [] as string[],
});
const adapt = (port: ReturnType<typeof createMockExecutionPort>) =>
  new ExecutionBuildPort(port, () => '2026-11-24T00:00:00Z');
const req = {
  projectId: 'p',
  versionId: 'v',
  profile: 'typecheck' as const,
  orgId: 'o',
  runId: 'r',
};

describe('ExecutionBuildPort over the real MockExecutionPort', () => {
  it('structurally matches the port and reports MOCK', () => {
    const port = adapt(createMockExecutionPort(ctx(['typecheck'])));
    expect(port.origin).toBe('MOCK');
  });
  it('an enabled profile runs through the real policy: scripted failure is a failed build, scripted success completes', async () => {
    const mock = createMockExecutionPort(ctx(['typecheck', 'unit-tests', 'build']));
    mock.script(
      'typecheck',
      { exitCode: 1, stderr: 'a.ts(1,1): error TS1: boom\n', status: 'failed' },
      { exitCode: 0 },
    );
    const port = adapt(mock);
    const bad = await port.build(req);
    expect(bad.status).toBe('failed');
    expect(bad.logs).toContain('TS1');
    expect((await port.build(req)).status).toBe('completed');
    expect(mock.calls.map((c) => c.decision.profile)).toEqual(['typecheck', 'typecheck']);
    // the argv is the policy's fixed one, never anything the builder supplied
    expect(mock.calls[0]!.decision.argv).toEqual(['npx', '--no-install', 'tsc', '--noEmit']);
  });
  it('a profile the organization has not enabled is refused by the real policy and nothing runs', async () => {
    const mock = createMockExecutionPort(ctx([]));
    const r = await adapt(mock).build(req);
    expect(r.status).toBe('refused');
    expect(r.logs).toContain('profile_not_enabled');
    expect(mock.calls).toEqual([]);
  });
  it('a scripted timeout passes through, and the whole repair loop runs on it', async () => {
    const mock = createMockExecutionPort(ctx(['typecheck', 'unit-tests', 'build']));
    mock.script('build', { status: 'timeout', exitCode: null, durationMs: 400_000 });
    expect((await adapt(mock).build({ ...req, profile: 'build' })).status).toBe('timeout');
    const mock2 = createMockExecutionPort(ctx(['typecheck', 'unit-tests', 'build']));
    let n = 0;
    const r = await runRepairLoop({
      orgId: 'o',
      runId: 'r',
      projectId: 'p',
      versionId: 'v0',
      files: new Map([['tsconfig.json', '{"a":1,}\n']]),
      build: adapt(mock2),
      io: { commit: async () => ({ versionId: `v${++n}` }) },
      strategy: new RuleBasedRepair(),
    });
    expect(r).toMatchObject({ status: 'passed', origin: 'MOCK', totalOps: 1 });
    expect(mock2.calls.map((c) => c.decision.profile)).toEqual([
      'typecheck',
      'unit-tests',
      'build',
    ]);
  });
});
