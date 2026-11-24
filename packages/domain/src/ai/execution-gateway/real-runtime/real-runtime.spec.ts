import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttestationRefused,
  RealRuntimeService,
  type RealRuntimeConfig,
  type RuntimeEvent,
  type RunAccounting,
} from './real-runtime';
import { createSimulatedKit, SIMULATED_IMAGE_DIGEST } from './simulated-attestation';
import { SimulatedWorkspaceRuntime, type SimulatedBehavior } from './workspace-runtime';
import { validateRuntimeSpec, buildRuntimeSpec } from '../runtime-spec';
import { decideExec, EXEC_ENV } from '../policy';
import type { ExecContext } from '../policy';
import type { ExecutionRunContext } from '../port';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const kit = createSimulatedKit();
const ORG = 'org-1';
const RUN = 'run-1';
const ectx: ExecContext = {
  orgId: ORG,
  runId: RUN,
  enabledProfiles: ['typecheck', 'unit-tests', 'install-deps', 'run-script', 'build'],
  projectScripts: ['lint'],
};
const ident = (nodeId = 'node-a') => ({
  nodeId,
  endpointId: `ep-${nodeId}`,
  runtimeClass: 'gvisor-runsc',
  imageDigests: [SIMULATED_IMAGE_DIGEST],
});
const mkNode = (nodeId = 'node-a', slots = 4) => {
  const runtime = new SimulatedWorkspaceRuntime(ident(nodeId), slots);
  return {
    nodeId,
    endpointId: `ep-${nodeId}`,
    runtime,
    attestation: kit.attestation({ nodeId, endpointId: `ep-${nodeId}` }, { now: NOW }) as unknown,
  };
};
const events: RuntimeEvent[] = [];
const usage: RunAccounting[] = [];
const sinkPuts: { path: string; sha256: string }[] = [];
const cfgFor = (
  nodes: ReturnType<typeof mkNode>[],
  o: Partial<RealRuntimeConfig> = {},
): RealRuntimeConfig => ({
  mode: 'simulated',
  nodes,
  trust: kit.trusted,
  environments: ['staging'],
  now: () => Date.now(),
  onEvent: (e) => events.push(e),
  onUsage: (u) => usage.push(u),
  artifactSink: { put: async (a) => void sinkPuts.push({ path: a.path, sha256: a.sha256 }) },
  pollMs: 1000,
  graceMs: 2000,
  ...o,
});
const files =
  (m: Record<string, string> = {}) =>
  () =>
    new Map(
      Object.entries({
        'package.json': '{"name":"x","scripts":{"lint":"echo"}}',
        'src/a.ts': 'export const a = 1;\n',
        ...m,
      }),
    );
const rctx = (o: Partial<ExecutionRunContext> = {}): ExecutionRunContext => ({
  orgId: ORG,
  runId: RUN,
  ...o,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  events.length = 0;
  usage.length = 0;
  sinkPuts.length = 0;
});
afterEach(() => vi.useRealTimers());

async function start(nodes = [mkNode()], o: Partial<RealRuntimeConfig> = {}) {
  return RealRuntimeService.start(cfgFor(nodes, o));
}
const refusedReasons = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AttestationRefused) return e.reasons;
    throw e;
  }
  return [];
};
async function runProfile(
  svc: RealRuntimeService,
  profile: string,
  params?: Record<string, unknown>,
  rc = rctx(),
  seed = files(),
  canaries: string[] = [],
) {
  const port = svc.portFor(ectx, { seedFiles: seed, canaries: () => canaries });
  const d = await port.request({ orgId: ORG, runId: RUN, profile, params });
  return { port, d, run: () => port.run(d, rc) };
}

describe('RealRuntimeService.start is fail-closed on the isolation attestation', () => {
  it('refuses with no attestation, no nodes, a malformed one, and builds nothing', async () => {
    const n = mkNode();
    expect(await refusedReasons(start([{ ...n, attestation: null }]))).toContain(
      'node-a:attestation_missing',
    );
    expect(await refusedReasons(start([]))).toEqual(['no_nodes']);
    expect(await refusedReasons(start([{ ...n, attestation: { schema: 'x' } }]))).not.toEqual([]);
    expect(n.runtime.liveWorkspaces()).toEqual([]);
  });
  it('refuses a tampered, expired, revoked or wrong-node attestation', async () => {
    const n = mkNode();
    const a = n.attestation as { host: { cgroupsV2: boolean } };
    expect(
      await refusedReasons(
        start([{ ...n, attestation: { ...a, host: { ...a.host, cgroupsV2: false } } }]),
      ),
    ).toContain('node-a:signature_invalid');
    const old = kit.attestation(
      { nodeId: 'node-a', endpointId: 'ep-node-a' },
      { now: new Date('2026-09-01T00:00:00Z') },
    );
    expect(await refusedReasons(start([{ ...n, attestation: old }]))).toContain(
      'node-a:attestation_expired',
    );
    expect(await refusedReasons(start([n], { isRevoked: () => true }))).toContain(
      'node-a:attestation_revoked',
    );
    const other = mkNode('node-b');
    expect(await refusedReasons(start([{ ...n, attestation: other.attestation }]))).toContain(
      'node-a:node_mismatch',
    );
  });
  it('refuses when the node does not answer as the attested node or is unhealthy', async () => {
    const n = mkNode();
    const wrong = new SimulatedWorkspaceRuntime({ ...ident(), nodeId: 'someone-else' });
    expect(await refusedReasons(start([{ ...n, runtime: wrong }]))).toContain(
      'node-a:identity_node_mismatch',
    );
    const badImage = new SimulatedWorkspaceRuntime({
      ...ident(),
      imageDigests: [`sha256:${'11'.repeat(32)}`],
    });
    expect(await refusedReasons(start([{ ...n, runtime: badImage }]))).toContain(
      'node-a:identity_image_not_attested',
    );
    n.runtime.setHealthy(false);
    expect(await refusedReasons(start([n]))).toContain('node-a:node_unhealthy');
  });
  it('one bad node refuses the whole start; duplicates are refused', async () => {
    const a = mkNode('node-a');
    const b = { ...mkNode('node-b'), attestation: null };
    expect(await refusedReasons(start([a, b]))).toContain('node-b:attestation_missing');
    expect(await refusedReasons(start([a, a]))).toContain('node_duplicate');
  });
  it('a live service refuses a SIMULATED attestation and a node that does not claim verified isolation', async () => {
    const n = mkNode();
    const r = await refusedReasons(start([n], { mode: 'live' }));
    expect(r).toContain('node-a:evidence_not_live_verified');
    const live = kit.attestation(
      { nodeId: 'node-a', endpointId: 'ep-node-a' },
      { now: NOW, mutate: (a) => (a.evidence.label = 'LIVE-VERIFIED') },
    );
    expect(await refusedReasons(start([{ ...n, attestation: live }], { mode: 'live' }))).toContain(
      'node-a:runtime_self_report_not_verified',
    );
  });
  it('a simulated service reports origin MOCK; a live one (test-constructed) reports REAL', async () => {
    const svc = await start();
    expect(svc.origin).toBe('MOCK');
    expect(svc.portFor(ectx, { seedFiles: files(), canaries: () => [] }).origin).toBe('MOCK');
    const n = mkNode();
    (n.runtime as { isolation: string }).isolation = 'verified';
    const live = kit.attestation(
      { nodeId: 'node-a', endpointId: 'ep-node-a' },
      { now: NOW, mutate: (a) => (a.evidence.label = 'LIVE-VERIFIED') },
    );
    const s2 = await start([{ ...n, attestation: live }], { mode: 'live' });
    expect(s2.origin).toBe('REAL');
  });
});

describe('RealRuntimePort.run (simulated node: nothing is executed)', () => {
  it('runs a typecheck: fixed argv and environment, one workspace, cleaned up, accounted', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({
      stdout: 'ok\n',
      stats: { cpuSeconds: 2, memoryMb: 100, pids: 4, diskMb: 10 },
      durationMs: 1200,
    }));
    const svc = await start([n]);
    const { run } = await runProfile(svc, 'typecheck');
    const out = await run();
    expect(out.status).toBe('completed');
    expect(out.stdout).toBe('ok\n');
    const spec = n.runtime.accepted[0]!;
    expect(spec.argv).toEqual(['npx', '--no-install', 'tsc', '--noEmit']);
    expect(spec.env).toEqual(EXEC_ENV);
    expect(spec.workspaceId).toBe(`ws-${RUN}`);
    expect(validateRuntimeSpec(spec)).toEqual([]);
    expect(n.runtime.liveWorkspaces()).toEqual([]);
    expect(n.runtime.liveRuns()).toEqual([]);
    expect(usage[0]).toMatchObject({
      orgId: ORG,
      runId: RUN,
      nodeId: 'node-a',
      profile: 'typecheck',
      status: 'completed',
    });
    expect(usage[0]!.usage.cpuSeconds).toBe(2);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'node_admitted',
        'workspace_created',
        'run_started',
        'cleanup_ok',
        'run_finished',
      ]),
    );
  });
  it('maps a non-zero exit to failed and keeps the exit code', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ exitCode: 2, stderr: 'TS2322\n' }));
    const out = await (await runProfile(await start([n]), 'typecheck')).run();
    expect(out).toMatchObject({ status: 'failed', exitCode: 2 });
  });
  it('refuses a refused decision, another tenant or run, a missing approval, an aborted signal', async () => {
    const svc = await start();
    const port = svc.portFor(ectx, { seedFiles: files(), canaries: () => [] });
    const bad = decideExec({ orgId: ORG, runId: RUN, profile: 'nope' }, ectx);
    expect((await port.run(bad, rctx())).stderr).toContain('request refused');
    const d = await port.request({ orgId: ORG, runId: RUN, profile: 'typecheck' });
    expect((await port.run(d, rctx({ orgId: 'other' }))).stderr).toContain('another_tenant_or_run');
    expect((await port.run(d, rctx({ runId: 'run-2' }))).stderr).toContain('another_tenant_or_run');
    const inst = await port.request({ orgId: ORG, runId: RUN, profile: 'install-deps' });
    expect((await port.run(inst, rctx())).stderr).toContain('approval_required');
    const ac = new AbortController();
    ac.abort();
    expect((await port.run(d, rctx({ signal: ac.signal }))).status).toBe('terminated');
  });
  it('refuses an environment other than the constant', async () => {
    const svc = await start();
    const port = svc.portFor(ectx, { seedFiles: files(), canaries: () => [] });
    const d = await port.request({ orgId: ORG, runId: RUN, profile: 'typecheck' });
    if (!d.allowed) throw new Error('expected allowed');
    const tampered = { ...d, env: { ...d.env, NODE_OPTIONS: '--require /x' } };
    expect((await port.run(tampered, rctx())).stderr).toContain('environment_not_the_constant');
  });
  it('refuses secrets, a canary and secret-named files in the seed; nothing reaches the node', async () => {
    const n = mkNode();
    const svc = await start([n]);
    const env = await (
      await runProfile(svc, 'typecheck', undefined, rctx(), files({ '.env': 'X=1' }))
    ).run();
    expect(env.stderr).toContain('workspace_refused:secret_file_name');
    const canary = 'canary-value-0123456789abcdef';
    const c = await (
      await runProfile(
        svc,
        'typecheck',
        undefined,
        rctx(),
        files({ 'src/b.ts': `const k='${canary}'` }),
        [canary],
      )
    ).run();
    expect(c.stderr).toContain('workspace_refused');
    expect(n.runtime.accepted).toEqual([]);
    expect(n.runtime.liveWorkspaces()).toEqual([]);
  });
  it('applies the dependency policy before an install: git dependency refused with no node call', async () => {
    const n = mkNode();
    const svc = await start([n]);
    const seed = files({
      'package.json': '{"name":"x","dependencies":{"a":"github:u/r"}}',
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    });
    const out = await (
      await runProfile(svc, 'install-deps', undefined, rctx({ approvalId: 'ap-1' }), seed)
    ).run();
    expect(out.status).toBe('refused');
    expect(out.stderr).toContain('dependency_from_git');
    expect(n.runtime.accepted).toEqual([]);
    expect(events.some((e) => e.type === 'dependency_refused')).toBe(true);
  });
  it('an approved install with a clean lockfile reaches the node with registry-only egress via the proxy', async () => {
    const n = mkNode();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/left': {
          resolved: 'https://registry.npmjs.org/left/-/left-1.0.0.tgz',
          integrity: 'sha512-' + 'A'.repeat(86) + '==',
        },
      },
    });
    const seed = files({
      'package.json': '{"name":"x","dependencies":{"left":"^1.0.0"}}',
      'package-lock.json': lock,
    });
    const out = await (
      await runProfile(
        await start([n]),
        'install-deps',
        undefined,
        rctx({ approvalId: 'ap-1' }),
        seed,
      )
    ).run();
    expect(out.status).toBe('completed');
    expect(n.runtime.accepted[0]!.argv).toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(n.runtime.accepted[0]!.network).toEqual({
      class: 'registry-only',
      ownNamespace: true,
      egressProxyOnly: true,
    });
  });
  it('the node itself refuses a weakened spec (second line of defence)', async () => {
    const n = mkNode();
    const d = decideExec({ orgId: ORG, runId: RUN, profile: 'typecheck' }, ectx);
    if (!d.allowed) throw new Error('expected allowed');
    await n.runtime.createWorkspace({
      workspaceId: `ws-${RUN}`,
      orgId: ORG,
      runId: RUN,
      diskMb: 100,
    });
    const spec = buildRuntimeSpec({
      decision: d,
      orgId: ORG,
      runId: RUN,
      runtimeClass: 'runc',
      image: SIMULATED_IMAGE_DIGEST,
    });
    await expect(n.runtime.start({ ...spec, privileged: true })).rejects.toThrow(
      /runtime_class_not_isolating/,
    );
    expect(n.runtime.refusedSpecs[0]!.violations).toEqual(
      expect.arrayContaining(['privileged', 'runtime_class_not_isolating']),
    );
  });
  it('caps stdout at the profile output limit and flags truncation', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ stdout: 'x'.repeat(300 * 1024) }));
    const out = await (await runProfile(await start([n]), 'typecheck')).run();
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.stdout)).toBe(256 * 1024);
  });
  it('enforces the wall limit: soft kill at the limit, status timeout, workspace destroyed', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true }));
    const svc = await start([n]);
    const p = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(180_000);
    const out = await p;
    expect(out.status).toBe('timeout');
    expect(out.exitCode).toBeNull();
    expect(n.runtime.liveWorkspaces()).toEqual([]);
    expect(events.some((e) => e.type === 'run_killed' && e.detail?.why === 'wall')).toBe(true);
  });
  it('kills on a resource limit seen by the monitor (memory) and says which', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true, stats: { memoryMb: 4096 } }));
    const p = (await runProfile(await start([n]), 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(1500);
    const out = await p;
    expect(out.status).toBe('failed');
    expect(out.stderr).toContain('[limit] memory');
    expect(n.runtime.liveWorkspaces()).toEqual([]);
  });
  it('a caller abort ends the run as terminated and cleans up', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true }));
    const ac = new AbortController();
    const p = (
      await runProfile(await start([n]), 'typecheck', undefined, rctx({ signal: ac.signal }))
    ).run();
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    const out = await p;
    expect(out.status).toBe('terminated');
    expect(n.runtime.liveWorkspaces()).toEqual([]);
  });
  it('emergency termination through the runtime ports kills, destroys and reports gone', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true }));
    const svc = await start([n]);
    const p = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(100);
    const ports = svc.terminationPorts();
    const running = await ports.listRunning();
    expect(running).toHaveLength(1);
    await ports.signal(running[0]!, 'hard');
    const out = await p;
    expect(out.status).toBe('terminated');
    expect(await ports.isGone(running[0]!)).toBe(true);
    expect(await ports.listRunning()).toEqual([]);
  });
  it('a node that never answers after the hard kill is quarantined and the run is terminated', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true }));
    const stuck = n.runtime;
    stuck.kill = async () => undefined; // the node ignores kill
    const svc = await start([n]);
    const p = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(180_000 + 5_000 + 5_000 + 10);
    const out = await p;
    expect(out.status).toBe('terminated');
    expect(svc.status()[0]!.quarantined).toBe('run_unresponsive_after_hard_kill');
    expect((await (await runProfile(svc, 'typecheck')).run()).stderr).toContain('no_attested_node');
  });
  it('a failed cleanup quarantines the node; later runs are refused until a human restarts the service', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ destroyFails: true }));
    const svc = await start([n]);
    expect((await (await runProfile(svc, 'typecheck')).run()).status).toBe('completed');
    expect(events.some((e) => e.type === 'cleanup_failed')).toBe(true);
    expect(svc.status()[0]!.quarantined).toBe('cleanup_failed');
    expect((await (await runProfile(svc, 'typecheck')).run()).stderr).toContain('no_attested_node');
  });
  it('re-verifies the attestation at the moment of use: expiry and revocation take the node out', async () => {
    const n = mkNode();
    const svc = await start([n]);
    expect((await (await runProfile(svc, 'typecheck')).run()).status).toBe('completed');
    vi.setSystemTime(new Date(NOW.getTime() + 8 * 86_400_000));
    const out = await (await runProfile(svc, 'typecheck')).run();
    expect(out.stderr).toContain('no_attested_node');
    expect(
      events.some((e) => e.type === 'node_dropped' && e.detail?.reason === 'attestation_expired'),
    ).toBe(true);
    vi.setSystemTime(NOW);
    const n2 = mkNode('node-c');
    const svc2 = await start([n2]);
    svc2.revoke('att-sim-node-c');
    expect((await (await runProfile(svc2, 'typecheck')).run()).stderr).toContain(
      'no_attested_node',
    );
  });
  it('picks the node with the most free slots', async () => {
    const a = mkNode('node-a', 1);
    const b = mkNode('node-b', 3);
    a.runtime.setScript(() => ({ hang: true }));
    b.runtime.setScript(() => ({ hang: true }));
    const svc = await start([a, b]);
    const p1 = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(10);
    expect(b.runtime.accepted).toHaveLength(1);
    expect(a.runtime.accepted).toHaveLength(0);
    const ports = svc.terminationPorts();
    await ports.signal((await ports.listRunning())[0]!, 'hard');
    await p1;
  });
  it('reports no_capacity while the only slot is taken', async () => {
    const n = mkNode('node-a', 1);
    n.runtime.setScript(() => ({ hang: true }));
    const svc = await start([n]);
    const p1 = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(10);
    const second = await (await runProfile(svc, 'typecheck')).run();
    expect(second.stderr).toContain('no_capacity');
    const ports = svc.terminationPorts();
    await ports.signal((await ports.listRunning())[0]!, 'hard');
    await p1;
  });
  it('a runtime error during start is a failed outcome and the workspace is still destroyed', async () => {
    const n = mkNode();
    n.runtime.start = async () => {
      throw new Error('boom');
    };
    const out = await (await runProfile(await start([n]), 'typecheck')).run();
    expect(out.status).toBe('failed');
    expect(out.stderr).toContain('runtime_error:boom');
    expect(n.runtime.liveWorkspaces()).toEqual([]);
  });
  it('extracts only verified regular files under the output roots and hands content to the sink', async () => {
    const n = mkNode();
    const b: SimulatedBehavior = {
      produced: [
        { path: 'dist/a.js', bytes: 5, kind: 'file' },
        { path: 'dist/link', bytes: 3, kind: 'symlink' },
        { path: 'src/leak.ts', bytes: 3, kind: 'file' },
        { path: '.env', bytes: 3, kind: 'file' },
      ],
      producedContent: { 'dist/a.js': 'a=1;\n', 'src/leak.ts': 'x', '.env': 'x' },
    };
    n.runtime.setScript(() => b);
    const out = await (await runProfile(await start([n]), 'build')).run();
    expect(out.artifacts.map((a) => a.path)).toEqual(['dist/a.js']);
    expect(out.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sinkPuts).toEqual([{ path: 'dist/a.js', sha256: out.artifacts[0]!.sha256 }]);
    expect(events.filter((e) => e.type === 'artifact_refused').length).toBe(3);
  });
  it('events and accounting never carry file content, output or environment values', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({
      stdout: 'OUTPUT-MARKER-1',
      produced: [{ path: 'dist/a.js', bytes: 1, kind: 'file' }],
      producedContent: { 'dist/a.js': 'CONTENT-MARKER-2' },
    }));
    await (
      await runProfile(
        await start([n]),
        'build',
        undefined,
        rctx(),
        files({ 'src/c.ts': 'SEED-MARKER-3' }),
      )
    ).run();
    const blob = JSON.stringify([events, usage]);
    for (const m of ['OUTPUT-MARKER-1', 'CONTENT-MARKER-2', 'SEED-MARKER-3', '/usr/local/bin'])
      expect(blob).not.toContain(m);
  });
  it('reapOrphans destroys workspaces no live run owns after the grace period, never a live run, and quarantines a node that cannot clean', async () => {
    const n = mkNode();
    n.runtime.setScript(() => ({ hang: true }));
    const svc = await start([n]);
    // an orphan left by a control-plane crash
    await n.runtime.createWorkspace({
      workspaceId: 'ws-crashed-run',
      orgId: 'org-x',
      runId: 'crashed-run',
      diskMb: 10,
    });
    const live = (await runProfile(svc, 'typecheck')).run();
    await vi.advanceTimersByTimeAsync(10);
    expect(await svc.reapOrphans()).toEqual({ reaped: 0, failed: 0, unreachable: [] }); // inside the grace period
    await vi.advanceTimersByTimeAsync(125_000);
    expect(await svc.reapOrphans()).toEqual({ reaped: 1, failed: 0, unreachable: [] });
    expect(n.runtime.liveWorkspaces()).toEqual([`ws-${RUN}`]); // the live run's workspace stays
    const ports = svc.terminationPorts();
    await ports.signal((await ports.listRunning())[0]!, 'hard');
    await live;
    expect(n.runtime.liveWorkspaces()).toEqual([]);
    // a node that cannot destroy: quarantined
    await n.runtime.createWorkspace({
      workspaceId: 'ws-stuck',
      orgId: 'org-x',
      runId: 'stuck',
      diskMb: 10,
    });
    n.runtime.destroyWorkspace = async () => {
      throw new Error('busy');
    };
    await vi.advanceTimersByTimeAsync(125_000);
    expect(await svc.reapOrphans()).toMatchObject({ reaped: 0, failed: 1 });
    expect(svc.status()[0]!.quarantined).toBe('cleanup_failed');
  });
});
