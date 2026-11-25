import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { createAgentRig, RIG_IMAGE, type AgentRig } from './testing';

const realSetTimeout = globalThis.setTimeout;
const pump = async (ms: number) => {
  await new Promise<void>((r) => realSetTimeout(r, 3));
  await vi.advanceTimersByTimeAsync(ms);
};
let rig: AgentRig;
const decl = (): eg.NodeDeclaration => ({
  node: {
    nodeId: 'sim-node',
    endpointId: 'sim-endpoint',
    environment: 'staging',
    os: 'linux',
    kernel: '0.0-sim',
    arch: 'x86_64',
  },
  runtime: { class: 'gvisor-runsc', version: '0', imageDigests: [RIG_IMAGE] },
  host: {
    cgroupsV2: true,
    dedicatedNode: true,
    virtualization: 'n/a',
    swapDisabled: true,
    containerRuntimeSocketNotExposed: true,
    egress: 'default-deny-proxy-only',
    diskQuota: 'project-quota',
    metadataServiceBlocked: true,
  },
});
const conn = (): eg.NodeEndpointConfig => ({
  nodeId: 'sim-node',
  endpointId: 'sim-endpoint',
  baseUrl: 'https://sim-node.example:8443',
  signer: { keyId: 'cp-test', keyRef: 'vault://qualification/cp-signer' },
  tls: {
    caRef: 'vault://qualification/ca',
    certRef: 'vault://qualification/cert',
    keyRef: 'vault://qualification/key',
  },
});
const input = (over: Partial<eg.LiveRunInput> = {}): eg.LiveRunInput => ({
  connection: conn(),
  declaration: decl(),
  approvalRef: 'HG-10-02-test',
  env: { NUZM_QUALIFICATION_APPROVED: 'HG-10-02-test' },
  resolve: async () => rig.signerPem,
  transport: new eg.LoopbackTransport(rig.agent.handler),
  ...over,
});

describe('qualification-time connection (S8/S10 harness)', () => {
  beforeEach(async () => {
    rig = await createAgentRig();
  });
  afterEach(() => rig.dispose());

  it('refuses without an approval reference confirmed in the environment, for a production declaration, another node, a runc class and a non-https endpoint', async () => {
    const reasons = async (i: eg.LiveRunInput) => eg.liveRunRefusals(i);
    expect(await reasons(input({ approvalRef: undefined }))).toContain(
      'approval_reference_missing',
    );
    expect(await reasons(input({ approvalRef: 'whatever' }))).toContain(
      'approval_reference_missing',
    );
    expect(await reasons(input({ env: {} }))).toContain('approval_not_confirmed_in_environment');
    expect(
      await reasons(
        input({ declaration: { ...decl(), node: { ...decl().node, environment: 'production' } } }),
      ),
    ).toContain('node_not_staging');
    expect(await reasons(input({ connection: { ...conn(), nodeId: 'other-node' } }))).toContain(
      'connection_node_mismatch',
    );
    expect(
      await reasons(
        input({ declaration: { ...decl(), runtime: { ...decl().runtime, class: 'runc' } } }),
      ),
    ).toContain('runtime_class_not_isolating');
    expect(
      await reasons(
        input({
          transport: undefined,
          connection: { ...conn(), baseUrl: 'http://203.0.113.9:8443' },
        }),
      ),
    ).toContain('live_requires_https_mtls');
    await expect(eg.createQualificationTarget(input({ approvalRef: undefined }))).rejects.toThrow(
      eg.LiveRunRefused,
    );
  });
  it('refuses a node that does not answer as the declared node or serves an undeclared image', async () => {
    await expect(
      eg.createQualificationTarget(
        input({
          declaration: {
            ...decl(),
            runtime: { ...decl().runtime, imageDigests: [`sha256:${'1'.repeat(64)}`] },
          },
        }),
      ),
    ).rejects.toThrow(/node_image_not_declared/);
    await expect(
      eg.createQualificationTarget(
        input({
          connection: { ...conn(), nodeId: 'sim-node' },
          declaration: { ...decl(), node: { ...decl().node, endpointId: 'another' } },
        }),
      ),
    ).rejects.toThrow(/connection_endpoint_mismatch/);
  });
  it('a loopback transport is always labelled SIMULATED, never NOT VERIFIED or LIVE-VERIFIED', async () => {
    const t = await eg.createQualificationTarget(input());
    expect(t.label).toBe('SIMULATED');
    expect(t.origin).toBe('MOCK');
  });
});

describe('the live conformance harness runs the same suite through the agent', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  const rigs: AgentRig[] = [];
  afterAll(async () => {
    for (const r of rigs) await r.dispose();
  });
  it('passes every case (per-fixture agents, simulated launcher)', async () => {
    const fixtures = eg.SYNTHETIC_FIXTURES;
    let current!: AgentRig;
    const base = async (f: eg.SyntheticFixture) => {
      current = await createAgentRig({ script: () => f.simulate, monitorMs: 1000 });
      rigs.push(current);
      rig = current;
      return eg.createQualificationTarget(input());
    };
    // wrap: a fresh agent per fixture (the harness is one node; the scripted launcher differs per fixture)
    const target: eg.ConformanceTarget = {
      name: 'qualification harness',
      origin: 'MOCK',
      label: 'SIMULATED',
      pump,
      supports: () => true,
      portFor: async (ctx, f) => (await base(f)).portFor(ctx, f),
      leftovers: async () =>
        (await current.agent.service.listWorkspaces()).map((w) => w.workspaceId),
    };
    const r = await eg.runPortConformance(target, fixtures);
    expect(r.fail, JSON.stringify(r.results.filter((x) => x.status === 'FAIL'))).toBe(0);
    expect(r.statement).toContain('SIMULATED');
  }, 120_000);
});
