import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionBuildPort } from '../../agent-tools/builder';
import {
  createMockHandoffRig,
  createSimulatedNodeHandoffRig,
  runLifecycleHandoffConformance,
  LIFECYCLE_PORT_CALLS,
} from './handoff-conformance';

type PortLike = {
  origin: 'MOCK' | 'REAL';
  request: (r: {
    orgId: string;
    runId: string;
    profile: string;
  }) => Promise<{ allowed: boolean; reasons?: string[] }>;
  run: (
    d: never,
    c: { orgId: string; runId: string; source?: { projectId: string; versionId: string } },
  ) => Promise<{
    status: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    artifacts: { path: string; bytes: number; sha256?: string }[];
  }>;
};

/** the shared hand-off test, run on this side with S05's REAL adapter (`ExecutionBuildPort`) over the mock and over the simulated real-runtime port */
const adapt = (port: never) => new ExecutionBuildPort(port, () => '2026-11-24T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('Track E hand-off: the lifecycle (S05 ExecutionBuildPort) against the execution port', () => {
  it('documents the exact calls the lifecycle makes', () => {
    expect(LIFECYCLE_PORT_CALLS.join('\n')).toContain('port.run(d, {orgId, runId');
    expect(LIFECYCLE_PORT_CALLS.join('\n')).toContain(
      'install-deps and run-script are never requested',
    );
  });
  it('MockExecutionPort: every case passes (H-8 skipped: the mock has no artifact policy; H-9 passes: the adapter passes ctx.source and the mock records it)', async () => {
    const r = await runLifecycleHandoffConformance(createMockHandoffRig(adapt as never));
    expect(r.fail, JSON.stringify(r.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
    expect(r.origin).toBe('MOCK');
    expect(r.cases.find((c) => c.id === 'H-8')!.status).toBe('SKIPPED');
    expect(r.cases.find((c) => c.id === 'H-9')!.status).toBe('PASS');
    expect(r.statement).toContain('does NOT prove isolation');
  });
  it("the real-runtime port over the simulated node: every case passes, including the source case (S05's adapter passes ctx.source)", async () => {
    const r = await runLifecycleHandoffConformance(
      createSimulatedNodeHandoffRig(adapt as never, async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
    );
    expect(r.fail, JSON.stringify(r.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
    const byId = new Map(r.cases.map((c) => [c.id, c]));
    for (const id of ['H-1', 'H-2', 'H-3', 'H-4', 'H-5', 'H-6', 'H-7', 'H-8', 'H-9'])
      expect(byId.get(id)!.status, id).toBe('PASS');
  });
  it("with expectSource the case PASSES for S05's adapter and for any adapter that names the version, and FAILS for an adapter that omits it", async () => {
    const strict = await runLifecycleHandoffConformance(
      createSimulatedNodeHandoffRig(adapt as never, async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
      { expectSource: true },
    );
    expect(strict.fail, JSON.stringify(strict.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
    expect(strict.cases.find((c) => c.id === 'H-9')!.status).toBe('PASS');
    // local adapters: one that names the version (what CONTRACT-04-4 asks for) and one that omits it (the old behaviour)
    const mk = (includeSource: boolean) => (port: PortLike) => {
      const inner = new ExecutionBuildPort(port as never, () => '2026-11-24T00:00:00Z');
      return {
        origin: port.origin,
        preflight: inner.preflight.bind(inner),
        async build(req: Parameters<typeof inner.build>[0]) {
          const decision = await port.request({
            orgId: req.orgId,
            runId: req.runId,
            profile: req.profile,
          });
          if (!decision.allowed)
            return {
              status: 'refused' as const,
              logs: `refused: ${(decision.reasons ?? []).join(',')}\n`,
              artifacts: [],
              durationMs: 0,
            };
          const out = await port.run(decision as never, {
            orgId: req.orgId,
            runId: req.runId,
            ...(includeSource
              ? { source: { projectId: req.projectId, versionId: req.versionId } }
              : {}),
          });
          const status = out.status === 'completed' && out.exitCode !== 0 ? 'failed' : out.status;
          return {
            status,
            logs: `${out.stdout}${out.stderr}`,
            artifacts: out.artifacts
              .filter((a) => a.sha256)
              .map((a) => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 as string })),
            durationMs: out.durationMs,
          };
        },
      };
    };
    const withSource = mk(true);
    const withoutSource = mk(false);
    const ok = await runLifecycleHandoffConformance(
      createSimulatedNodeHandoffRig(withSource as never, async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
      { expectSource: true },
    );
    expect(ok.fail, JSON.stringify(ok.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
    expect(ok.cases.find((c) => c.id === 'H-9')!.status).toBe('PASS');
    const okMock = await runLifecycleHandoffConformance(createMockHandoffRig(withSource as never), {
      expectSource: true,
    });
    expect(okMock.fail, JSON.stringify(okMock.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
    expect(okMock.cases.find((c) => c.id === 'H-9')!.status).toBe('PASS'); // the mock records ctx, so the version is observable there too
    for (const rig of [
      createSimulatedNodeHandoffRig(withoutSource as never, async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
      createMockHandoffRig(withoutSource as never),
    ]) {
      const bad = await runLifecycleHandoffConformance(rig, { expectSource: true });
      expect(bad.cases.find((c) => c.id === 'H-9')!.status).toBe('FAIL');
      // without expectSource the same omission is reported SKIPPED (never a pass)
      const lenient = await runLifecycleHandoffConformance(rig);
      expect(lenient.cases.find((c) => c.id === 'H-9')!.status).toBe('SKIPPED');
    }
  });
});
