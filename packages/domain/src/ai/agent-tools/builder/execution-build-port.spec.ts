import { describe, expect, it } from 'vitest';
import {
  ExecutionBuildPort,
  RuleBasedRepair,
  runRepairLoop,
  type ExecDecisionLike,
  type ExecOutcomeLike,
  type ExecutionPortLike,
} from './index';

/** A fake with the shape of Session 04's MockExecutionPort: scripted outcomes per profile, the policy answer injected. */
function fake(
  enabled: string[],
  outcomes: Record<string, Partial<ExecOutcomeLike>[]> = {},
): ExecutionPortLike & { ran: string[]; requests: unknown[] } {
  const ran: string[] = [];
  const requests: unknown[] = [];
  return {
    origin: 'MOCK',
    ran,
    requests,
    async request(req): Promise<ExecDecisionLike> {
      requests.push(req);
      return enabled.includes(req.profile)
        ? ({
            allowed: true,
            requiresApproval: req.profile === 'run-script',
            profile: req.profile,
          } as ExecDecisionLike)
        : { allowed: false, reasons: ['profile_not_enabled'] };
    },
    async run(decision) {
      const p = (decision as unknown as { profile: string }).profile;
      ran.push(p);
      return {
        status: 'completed',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        artifacts: [],
        ...(outcomes[p]?.shift() ?? {}),
      };
    },
  };
}
const req = {
  projectId: 'p',
  versionId: 'v',
  profile: 'typecheck' as const,
  orgId: 'o',
  runId: 'r',
};

describe('ExecutionBuildPort', () => {
  it('requests only a named profile (never a command line) and maps outcomes', async () => {
    const f = fake(['typecheck'], {
      typecheck: [{ exitCode: 1, stderr: 'a.ts(1,1): error TS1: x\n' }],
    });
    const port = new ExecutionBuildPort(f, () => '2026-11-24T00:00:00Z');
    const r = await port.build(req);
    expect(f.requests).toEqual([{ orgId: 'o', runId: 'r', profile: 'typecheck' }]);
    expect(r).toMatchObject({ status: 'failed' }); // completed with exit 1 is a failed build
    expect(r.logs).toContain('TS1');
    expect(port.origin).toBe('MOCK');
  });
  it('a profile the policy does not enable is refused and nothing runs', async () => {
    const f = fake([]);
    const r = await new ExecutionBuildPort(f, () => 'x').build(req);
    expect(r).toMatchObject({ status: 'refused' });
    expect(r.logs).toContain('profile_not_enabled');
    expect(f.ran).toEqual([]);
  });
  it('timeouts pass through; artifacts without a hash are dropped, hashed ones are referenced', async () => {
    const f = fake(['build'], {
      build: [
        { status: 'timeout', exitCode: null },
        {
          artifacts: [
            { path: 'dist/a.js', bytes: 3 },
            { path: 'dist/b.js', bytes: 4, sha256: 'h'.repeat(64) },
          ],
        },
      ],
    });
    const port = new ExecutionBuildPort(f, () => 'T');
    expect((await port.build({ ...req, profile: 'build' })).status).toBe('timeout');
    const ok = await port.build({ ...req, profile: 'build' });
    expect(ok.artifacts).toEqual([
      { id: 'h'.repeat(64), path: 'dist/b.js', bytes: 4, sha256: 'h'.repeat(64), createdAt: 'T' },
    ]);
  });
  it('drives the repair loop end to end through the adapter', async () => {
    const f = fake(['typecheck', 'unit-tests', 'build']);
    let n = 0;
    const r = await runRepairLoop({
      orgId: 'o',
      runId: 'r',
      projectId: 'p',
      versionId: 'v0',
      files: new Map([['tsconfig.json', '{"a":1,}\n']]),
      build: new ExecutionBuildPort(f, () => 'T'),
      io: { commit: async () => ({ versionId: `v${++n}` }) },
      strategy: new RuleBasedRepair(),
    });
    expect(r).toMatchObject({ status: 'passed', origin: 'MOCK', totalOps: 1 });
    expect(f.ran).toEqual(['typecheck', 'unit-tests', 'build']);
  });
});
