import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { createAgentHandoffRig, createAgentNodeTarget } from './testing';

// real timers captured BEFORE fake timers are installed: the pump yields to real file I/O (the agent touches a real temp directory), then advances the fake clock
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
const pump = async (ms: number) => {
  await realSleep(3);
  await vi.advanceTimersByTimeAsync(ms);
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('the node agent passes the SAME conformance suites as the simulated node (SIMULATED: policy, protocol and bookkeeping; never isolation)', () => {
  const target = createAgentNodeTarget({ pump });
  afterAll(() => target.dispose());
  it('port conformance: every case passes through the real agent, client and protocol', async () => {
    const r = await eg.runPortConformance(target);
    expect(r.fail, JSON.stringify(r.results.filter((x) => x.status === 'FAIL'))).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.pass).toBe(r.total);
    expect(r.total).toBe(6 + eg.SYNTHETIC_FIXTURES.length);
    expect(r.target.label).toBe('SIMULATED');
    expect(r.isolationEvidence).toBe(false);
  }, 120_000);

  const rig = createAgentHandoffRig((port) => ({
    origin: port.origin,
    async preflight(req) {
      const d = await port.request({ orgId: req.orgId, runId: req.runId, profile: req.profile });
      return d.allowed ? { allowed: true, reasons: [], requiresApproval: d.requiresApproval } : { allowed: false, reasons: d.reasons, requiresApproval: false };
    },
    async build(req) {
      const d = await port.request({ orgId: req.orgId, runId: req.runId, profile: req.profile });
      if (!d.allowed) return { status: 'refused', logs: `refused: ${d.reasons.join(',')}`, artifacts: [], durationMs: 0 };
      if (d.requiresApproval) return { status: 'refused', logs: 'refused: approval_required', artifacts: [], durationMs: 0 };
      const o = await port.run(d, { orgId: req.orgId, runId: req.runId, source: { projectId: req.projectId, versionId: req.versionId } as never });
      return {
        status: o.status === 'completed' && o.exitCode !== 0 ? 'failed' : o.status,
        logs: o.stdout + o.stderr,
        artifacts: o.artifacts.map((a) => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 ?? '' })),
        durationMs: o.durationMs,
      };
    },
  }), pump);
  afterAll(() => rig.dispose());
  it('lifecycle hand-off conformance (H-1..H-9) passes through the real agent', async () => {
    const r = await eg.runLifecycleHandoffConformance(rig, { expectSource: true });
    expect(r.fail, JSON.stringify(r.cases.filter((x) => x.status === 'FAIL'))).toBe(0);
    expect(r.pass).toBeGreaterThanOrEqual(8);
  }, 120_000);
});
