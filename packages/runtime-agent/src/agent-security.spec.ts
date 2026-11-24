import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { assembleAgent } from './agent';
import { createAgentRig, RIG_IMAGE, tokenHeader, type AgentRig } from './testing';

const LIMITS = {
  cpuSeconds: 60,
  wallSeconds: 60,
  memoryMb: 512,
  pids: 64,
  outputKb: 64,
  diskMb: 128,
};
const specFor = (
  orgId: string,
  runId: string,
  over: Partial<eg.RuntimeSpec> = {},
  network: 'none' | 'registry-only' = 'none',
  limits = LIMITS,
): eg.RuntimeSpec => ({
  ...eg.buildRuntimeSpec({
    decision: {
      argv: ['npx', '--no-install', 'tsc', '--noEmit'],
      cwd: '',
      env: { ...eg.EXEC_ENV },
      limits,
      network,
    },
    orgId,
    runId,
    runtimeClass: 'gvisor-runsc',
    image: RIG_IMAGE,
    egressAllow: network === 'registry-only' ? eg.registryHosts() : [],
  }),
  ...over,
});
let rig: AgentRig;
beforeEach(async () => {
  rig = await createAgentRig();
});
afterEach(() => rig.dispose());

async function prepared(org = 'org-a', run = 'run-1') {
  const ws = `ws-${run}`;
  await rig.runtime.createWorkspace({ workspaceId: ws, orgId: org, runId: run, diskMb: 256 });
  await rig.runtime.putFiles(ws, new Map([['package.json', '{}']]));
  return { ws, org, run };
}

describe('authentication and request integrity', () => {
  const body = { workspaceId: 'ws-r', orgId: 'org-a', runId: 'r', diskMb: 64 };
  it('refuses a request with no token, a malformed token, a rogue signer, a replay, another node, another op and a tampered body', async () => {
    const ok = await tokenHeader(rig.signer, 'sim-node', 'createWorkspace', body, {
      orgId: 'org-a',
      workspaceId: 'ws-r',
    });
    expect((await rig.rawCall('createWorkspace', body)).status).toBe(401);
    expect((await rig.rawCall('createWorkspace', body, 'NuzmNode nope')).status).toBe(401);
    expect(
      (
        await rig.rawCall(
          'createWorkspace',
          body,
          await tokenHeader(rig.rogue, 'sim-node', 'createWorkspace', body, {
            orgId: 'org-a',
            workspaceId: 'ws-r',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await rig.rawCall(
          'createWorkspace',
          body,
          await tokenHeader(rig.signer, 'other-node', 'createWorkspace', body, {
            orgId: 'org-a',
            workspaceId: 'ws-r',
          }),
        )
      ).status,
    ).toBe(401);
    expect((await rig.rawCall('destroyWorkspace', { workspaceId: 'ws-r' }, ok)).status).toBe(401); // the token is for createWorkspace
    expect((await rig.rawCall('createWorkspace', { ...body, diskMb: 65 }, ok)).status).toBe(401); // body hash differs
    expect((await rig.rawCall('createWorkspace', body, ok)).status).toBe(200);
    expect((await rig.rawCall('createWorkspace', body, ok)).status).toBe(401); // replay
    expect(rig.agent.metrics.get('nuzm_agent_auth_refused_total', 'token_replayed')).toBe(1);
    expect(rig.audit.types().filter((t) => t === 'request_refused').length).toBeGreaterThanOrEqual(
      6,
    );
  });
  it('answers 404 to a wrong method, an unknown path and an unknown operation, before any authentication work', async () => {
    const r = await rig.agent.handler({
      method: 'GET',
      path: '/v1/health',
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r.status).toBe(404);
    expect(
      (
        await rig.agent.handler({
          method: 'POST',
          path: '/v2/health',
          headers: {},
          body: Buffer.from('{}'),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await rig.agent.handler({
          method: 'POST',
          path: '/v1/execute',
          headers: {},
          body: Buffer.from('{}'),
        })
      ).status,
    ).toBe(404);
  });
  it('refuses a non-JSON content type, an unknown member and a path-escaping file name (after authentication)', async () => {
    const h = (op: eg.NodeOp, b: unknown, bind = {}) =>
      tokenHeader(rig.signer, 'sim-node', op, b, bind);
    const b1 = { x: 1 };
    expect((await rig.rawCall('health', b1, await h('health', b1))).status).toBe(400);
    const wrong = await rig.rawCall('health', {}, await h('health', {}), {
      'content-type': 'text/plain',
    });
    expect(wrong.status).toBe(400);
    const evil = { workspaceId: 'ws-r', files: [['../../etc/cron.d/x', 'y']] };
    expect(
      (
        await rig.rawCall(
          'putFiles',
          evil,
          await h('putFiles', evil, { workspaceId: 'ws-r', orgId: 'org-a' }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('tenant binding', () => {
  it("a token for organization B cannot touch organization A's workspace or run, whatever the body says", async () => {
    const { ws } = await prepared('org-a', 'run-a');
    const { handle } = await rig.runtime.start(specFor('org-a', 'run-a'));
    const foreign = new eg.RemoteWorkspaceRuntime({
      nodeId: 'sim-node',
      transport: new eg.LoopbackTransport(rig.agent.handler),
      signer: rig.signer,
      runtimeClass: 'gvisor-runsc',
      isolation: 'simulated',
    });
    // org B learns org A's ids (a confused-deputy bug in the control plane): its own token binding cannot address them
    for (const body of [
      {
        op: 'listProduced' as const,
        req: { workspaceId: ws },
        bind: { orgId: 'org-b', workspaceId: ws },
      },
      {
        op: 'readProduced' as const,
        req: { workspaceId: ws, path: 'dist/a', maxBytes: 10 },
        bind: { orgId: 'org-b', workspaceId: ws },
      },
      {
        op: 'putFiles' as const,
        req: { workspaceId: ws, files: [['a', 'b']] },
        bind: { orgId: 'org-b', workspaceId: ws },
      },
      {
        op: 'destroyWorkspace' as const,
        req: { workspaceId: ws },
        bind: { orgId: 'org-b', workspaceId: ws },
      },
      { op: 'wait' as const, req: { handle, maxWaitMs: 10 }, bind: { orgId: 'org-b', handle } },
      { op: 'stats' as const, req: { handle }, bind: { orgId: 'org-b', handle } },
    ]) {
      const r = await rig.rawCall(
        body.op,
        body.req,
        await tokenHeader(rig.signer, 'sim-node', body.op, body.req, body.bind),
      );
      expect(r.status, body.op).toBe(403);
    }
    // a kill from org B is refused (not silently ignored), the run is still there for org A
    const k = { handle, how: 'hard' };
    expect(
      (
        await rig.rawCall(
          'kill',
          k,
          await tokenHeader(rig.signer, 'sim-node', 'kill', k, { orgId: 'org-b', handle }),
        )
      ).status,
    ).toBe(403);
    expect((await rig.runtime.listWorkspaces()).map((w) => w.workspaceId)).toContain(ws);
    void foreign;
  });
  it('a token whose binding differs from the body is refused; a token with no organization cannot start or write, only clean up', async () => {
    const { ws } = await prepared();
    const files = { workspaceId: ws, files: [['a.txt', 'x']] };
    expect(
      (
        await rig.rawCall(
          'putFiles',
          files,
          await tokenHeader(rig.signer, 'sim-node', 'putFiles', files, {
            orgId: 'org-a',
            workspaceId: 'ws-other',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await rig.rawCall(
          'putFiles',
          files,
          await tokenHeader(rig.signer, 'sim-node', 'putFiles', files, { workspaceId: ws }),
        )
      ).status,
    ).toBe(403); // no org
    const start = { spec: specFor('org-a', 'run-1') };
    expect(
      (
        await rig.rawCall(
          'start',
          start,
          await tokenHeader(rig.signer, 'sim-node', 'start', start, { workspaceId: 'ws-run-1' }),
        )
      ).status,
    ).toBe(403);
    const d = { workspaceId: ws };
    expect(
      (
        await rig.rawCall(
          'destroyWorkspace',
          d,
          await tokenHeader(rig.signer, 'sim-node', 'destroyWorkspace', d, { workspaceId: ws }),
        )
      ).status,
    ).toBe(200);
  });
  it("a workspace created for one run cannot be started with another run or organization's spec", async () => {
    await prepared('org-a', 'run-1');
    await expect(
      rig.runtime.start(specFor('org-a', 'run-2', { workspaceId: 'ws-run-1' })),
    ).rejects.toThrow(/workspace_tenant_mismatch|workspace_not_bound/);
    await expect(rig.runtime.start(specFor('org-b', 'run-1'))).rejects.toThrow(
      /workspace_tenant_mismatch|forbidden|unknown_workspace/,
    );
    expect(rig.launcher.launched).toHaveLength(0);
  });
});

describe('the node holds every spec to its own rules (second line of defence)', () => {
  const refuse = async (
    over: Partial<eg.RuntimeSpec>,
    code: string,
    net: 'none' | 'registry-only' = 'none',
    limits = LIMITS,
  ) => {
    await prepared();
    await expect(
      rig.runtime.start(specFor('org-a', 'run-1', over, net, limits)),
      code,
    ).rejects.toThrow(new RegExp(`spec_refused:.*${code}`));
    expect(rig.launcher.launched).toHaveLength(0);
  };
  it.each([
    ['privileged', { privileged: true }, 'privileged'],
    ['host network', { hostNetwork: true }, 'host_network'],
    ['host pid', { hostPid: true }, 'host_pid'],
    ['writable root', { readOnlyRootFs: false }, 'root_fs_writable'],
    ['new privileges', { noNewPrivileges: false }, 'new_privileges_allowed'],
    ['no cap drop', { capabilitiesDrop: [] }, 'capabilities_not_dropped'],
    ['unconfined seccomp', { seccomp: 'unconfined' as const }, 'seccomp_unconfined'],
    ['root user', { user: { uid: 0, gid: 0 } }, 'runs_as_root'],
    ['a runc class', { runtimeClass: 'runc' }, 'runtime_class_not_isolating'],
    ['another sandbox uid', { user: { uid: 10002, gid: 10001 } }, 'sandbox_user_mismatch'],
    [
      'an extra environment variable',
      { env: { ...eg.EXEC_ENV, AWS_SECRET: 'x' } },
      'environment_not_the_constant',
    ],
    ['a preload variable', { env: { ...eg.EXEC_ENV, LD_PRELOAD: '/x' } }, 'env_invalid'],
    [
      'a docker socket mount',
      {
        mounts: [
          { source: 'workspace' as const, target: '/var/run/docker.sock', readOnly: false },
          { source: 'scratch' as const, target: '/scratch', readOnly: false },
          { source: 'toolchain' as const, target: '/toolchain', readOnly: true },
        ],
      },
      'mount_target_not_allowed',
    ],
    ['a cwd outside /work', { cwd: '/etc' }, 'cwd_invalid'],
    ['swap', { limits: { ...LIMITS, swapMb: 64 } }, 'swap_allowed'],
  ])('%s', async (_n, over, code) => refuse(over as Partial<eg.RuntimeSpec>, code));
  it('limits above the node ceilings, an unlisted egress host and an unattested image are refused', async () => {
    await refuse({}, 'limit_over_node_ceiling_memoryMb', 'none', { ...LIMITS, memoryMb: 999_999 });
    await prepared('org-a', 'run-9');
    await expect(
      rig.runtime.start(
        specFor('org-a', 'run-9', {
          egressAllow: [{ host: 'evil.example.com', port: 443 }],
          network: { class: 'registry-only', ownNamespace: true, egressProxyOnly: true },
        }),
      ),
    ).rejects.toThrow(/egress_not_on_node_allowlist/);
    await expect(
      rig.runtime.start(specFor('org-a', 'run-9', { image: `sha256:${'f'.repeat(64)}` })),
    ).rejects.toThrow(/image_not_attested/);
    expect(rig.launcher.launched).toHaveLength(0);
    expect(rig.audit.types()).toContain('spec_refused');
  });
  it('an accepted spec reaches the launcher exactly as sent: fixed argv, constant env', async () => {
    await prepared();
    await rig.runtime.start(specFor('org-a', 'run-1'));
    expect(rig.launcher.launched[0]!.spec.argv).toEqual(['npx', '--no-install', 'tsc', '--noEmit']);
    expect(rig.launcher.launched[0]!.spec.env).toEqual(eg.EXEC_ENV);
  });
});

describe('capacity, conflict and the kill switch', () => {
  it('refuses beyond maxSlots, refuses a second run in one workspace, and reports slots in health', async () => {
    await rig.dispose();
    rig = await createAgentRig({ maxSlots: 1, script: () => ({ hang: true }) });
    await prepared('org-a', 'r1');
    await prepared('org-a', 'r2');
    expect((await rig.runtime.health()).freeSlots).toBe(1);
    await rig.runtime.start(specFor('org-a', 'r1'));
    expect((await rig.runtime.health()).freeSlots).toBe(0);
    await expect(rig.runtime.start(specFor('org-a', 'r2'))).rejects.toThrow('no_capacity');
  });
  it('emergencyStop kills every run, destroys every workspace, and the node stays disabled until an operator clears the flag', async () => {
    await rig.dispose();
    rig = await createAgentRig({ script: () => ({ hang: true }) });
    await prepared('org-a', 'r1');
    await prepared('org-b', 'r2');
    const { handle } = await rig.runtime.start(specFor('org-a', 'r1'));
    const waiting = rig.runtime.wait(handle);
    const r = await rig.runtime.emergencyStop();
    expect(r.failed).toBe(0);
    expect(r.killed).toBeGreaterThanOrEqual(1);
    expect(r.destroyed).toBe(2);
    expect((await waiting).signal).toBe('SIGKILL');
    expect(await rig.runtime.listWorkspaces()).toEqual([]);
    expect(rig.agent.service.activeCount()).toBe(0);
    await expect(
      rig.runtime.createWorkspace({
        workspaceId: 'ws-r3',
        orgId: 'org-a',
        runId: 'r3',
        diskMb: 64,
      }),
    ).rejects.toThrow('node_disabled');
    const h = await rig.runtime.health();
    expect(h).toMatchObject({ ok: false, freeSlots: 0, note: 'node_disabled' });
    expect(rig.audit.types()).toContain('emergency_stop');
  });
  it('destroying a workspace with a live run kills the run first', async () => {
    await rig.dispose();
    rig = await createAgentRig({ script: () => ({ hang: true }) });
    const { ws } = await prepared('org-a', 'r1');
    await rig.runtime.start(specFor('org-a', 'r1'));
    await rig.runtime.destroyWorkspace(ws);
    expect(rig.agent.service.activeCount()).toBe(0);
    expect(rig.launcher.liveCount()).toBe(0);
    expect(await rig.runtime.listWorkspaces()).toEqual([]);
  });
});

describe('limits enforced by the agent itself (backstop to the control plane)', () => {
  it('kills a run whose observed memory crosses the limit, and says why', async () => {
    await rig.dispose();
    rig = await createAgentRig({
      monitorMs: 20,
      script: () => ({ hang: true, stats: { memoryMb: 4000 } }),
    });
    await prepared();
    const { handle } = await rig.runtime.start(specFor('org-a', 'run-1'));
    const r = await rig.runtime.wait(handle);
    expect(r.signal).toBe('SIGKILL');
    expect(
      rig.audit.events.some((e) => e.type === 'run_limit_kill' && e.detail?.resource === 'memory'),
    ).toBe(true);
    expect(rig.agent.metrics.get('nuzm_agent_runs_killed_total', 'limit_memory')).toBe(1);
  });
  it('kills a run that outlives its wall limit even if nobody asks (wall backstop)', async () => {
    await rig.dispose();
    rig = await createAgentRig({
      configOverride: (c) => (c.killGraceMs = 100),
      script: () => ({ hang: true }),
    });
    await prepared();
    const { handle } = await rig.runtime.start(
      specFor('org-a', 'run-1', {}, 'none', { ...LIMITS, wallSeconds: 1, cpuSeconds: 1 }),
    );
    const t0 = Date.now();
    const r = await rig.runtime.wait(handle);
    expect(r.signal).toMatch(/SIGTERM|SIGKILL/);
    expect(Date.now() - t0).toBeLessThan(15_000); // generous: the machine may be heavily loaded; the point is that it ends by itself
    expect(
      rig.audit.events.some((e) => e.type === 'run_killed' && e.detail?.why === 'wall_backstop'),
    ).toBe(true);
  }, 30_000);
});

describe('artifacts: the workspace is hostile territory', () => {
  const produced = {
    exitCode: 0,
    produced: [
      { path: 'dist/ok.js', bytes: 3, kind: 'file' as const },
      { path: 'dist/link', bytes: 0, kind: 'symlink' as const },
      { path: 'dist/hard.js', bytes: 1, kind: 'hardlink' as const },
    ],
    producedContent: { 'dist/ok.js': 'abc' },
  };
  it('lists links as links, never reads them, bounds reads, and refuses paths outside the workspace', async () => {
    await rig.dispose();
    rig = await createAgentRig({ script: () => produced });
    const { ws } = await prepared();
    const { handle } = await rig.runtime.start(specFor('org-a', 'run-1'));
    await rig.runtime.wait(handle);
    const files = await rig.runtime.listProduced(ws);
    const kinds = Object.fromEntries(files.map((f) => [f.path, f.kind]));
    expect(kinds['dist/ok.js']).toBe('file');
    expect(kinds['dist/link']).toBe('symlink');
    expect(kinds['dist/hard.js']).toBe('hardlink');
    expect(await rig.runtime.readProduced(ws, 'dist/ok.js', 100)).toBe('abc');
    await expect(rig.runtime.readProduced(ws, 'dist/ok.js', 2)).rejects.toThrow('too_large');
    await expect(rig.runtime.readProduced(ws, 'dist/link', 100)).rejects.toThrow(
      /not_a_regular_file|path_escapes/,
    );
    await expect(rig.runtime.readProduced(ws, 'dist/hard.js', 100)).rejects.toThrow(
      'not_a_regular_file',
    );
    await expect(rig.runtime.readProduced(ws, '../../etc/passwd', 100)).rejects.toThrow(
      /bad_request/,
    );
    await expect(rig.runtime.readProduced(ws, '/etc/passwd', 100)).rejects.toThrow(/bad_request/);
  });
  it('does not list or read while the run is still going', async () => {
    await rig.dispose();
    rig = await createAgentRig({ script: () => ({ hang: true }) });
    const { ws } = await prepared();
    await rig.runtime.start(specFor('org-a', 'run-1'));
    await expect(rig.runtime.listProduced(ws)).rejects.toThrow('conflict');
    await expect(rig.runtime.putFiles(ws, new Map([['x', 'y']]))).rejects.toThrow('conflict');
  });
});

describe('cleanup, leaks and restart recovery', () => {
  it('a failed cleanup keeps the node unhealthy (no new runs) and is retried by the reaper', async () => {
    await rig.dispose();
    rig = await createAgentRig({ script: () => ({ destroyFails: true }) });
    await prepared();
    const { handle } = await rig.runtime.start(specFor('org-a', 'run-1'));
    await rig.runtime.wait(handle);
    await expect(rig.runtime.destroy(handle)).rejects.toThrow('destroy_failed');
    expect(await rig.runtime.health()).toMatchObject({
      ok: false,
      freeSlots: 0,
      note: 'leaked_runs',
    });
    expect(rig.agent.metrics.render()).toContain('nuzm_agent_runs_leaked 1');
    const r = await rig.runtime.reap();
    expect(r.failed).toBe(1);
  });
  it('after an agent restart the node still reports its workspaces, so the control plane can reap them', async () => {
    const { ws } = await prepared('org-a', 'run-1');
    const again = await assembleAgent(rig.cfg, {
      audit: rig.audit,
      launcher: rig.launcher,
      verifiedImages: { [RIG_IMAGE]: rig.cfg.images[RIG_IMAGE]! },
      freeDiskMb: async () => 100_000,
    });
    expect((await again.service.listWorkspaces()).map((w) => w.workspaceId)).toEqual([ws]);
    again.service.shutdown();
  });
  it('the reaper destroys an aged workspace that has no live run and leaves a fresh one', async () => {
    await rig.dispose();
    let now = 1_000_000;
    rig = await createAgentRig({ now: () => now });
    await prepared('org-a', 'old');
    now += rig.cfg.workspaceMaxAgeMs + 1;
    await prepared('org-a', 'new');
    const r = await rig.runtime.reap();
    expect(r.reaped).toBe(1);
    expect((await rig.runtime.listWorkspaces()).map((w) => w.runId)).toEqual(['new']);
  });
  it('a workspace over the disk ceiling, a duplicate and a workspace not bound to its run are refused', async () => {
    await expect(
      rig.runtime.createWorkspace({
        workspaceId: 'ws-big',
        orgId: 'o',
        runId: 'big',
        diskMb: 10_000_000,
      }),
    ).rejects.toThrow(/bad_request|disk_quota/);
    await expect(
      rig.runtime.createWorkspace({ workspaceId: 'ws-x', orgId: 'o', runId: 'y', diskMb: 64 }),
    ).rejects.toThrow('workspace_not_bound_to_run');
    await rig.runtime.createWorkspace({ workspaceId: 'ws-a', orgId: 'o', runId: 'a', diskMb: 64 });
    await expect(
      rig.runtime.createWorkspace({ workspaceId: 'ws-a', orgId: 'o', runId: 'a', diskMb: 64 }),
    ).rejects.toThrow('workspace_exists');
  });
});

describe('identity and health', () => {
  it('reports the configured identity and only verified images, and the protocol version', async () => {
    expect(await rig.runtime.identity()).toEqual({
      nodeId: 'sim-node',
      endpointId: 'sim-endpoint',
      runtimeClass: 'gvisor-runsc',
      imageDigests: [RIG_IMAGE],
    });
    expect((await rig.runtime.health()).ok).toBe(true);
  });
  it('a low-disk node is unhealthy and takes no work', async () => {
    await rig.dispose();
    rig = await createAgentRig({ freeDiskMb: async () => 10 });
    expect(await rig.runtime.health()).toMatchObject({ ok: false, freeSlots: 0, note: 'disk_low' });
  });
  it('a client over loopback can never claim isolation verified', () => {
    expect(
      () =>
        new eg.RemoteWorkspaceRuntime({
          nodeId: 'sim-node',
          transport: new eg.LoopbackTransport(rig.agent.handler),
          signer: rig.signer,
          runtimeClass: 'gvisor-runsc',
          isolation: 'verified',
        }),
    ).toThrow('loopback_transport_cannot_be_verified');
  });
});
