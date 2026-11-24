import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';
import { assembleAgent, type AssembledAgent, type AssembleOptions } from './agent';
import { MemoryAuditSink } from './audit';
import { parseAgentConfig, type AgentConfig } from './config';
import { SimulatedLauncher } from './launcher';

/**
 * Test rigs: a REAL agent (config parsing, workspace store on a temp dir, node service, request handler, token verification, strict protocol parsing) behind a SIMULATED launcher
 * (nothing is executed), reached by the real node client over an in-process loopback transport. Everything it produces is SIMULATED: it proves the protocol, the agent's validation
 * and bookkeeping and the client, never isolation. A rig's runtime reports `isolation: 'simulated'` and the node client refuses to call a loopback `verified`.
 */
export interface AgentRig {
  dir: string;
  cfg: AgentConfig;
  agent: AssembledAgent;
  audit: MemoryAuditSink;
  launcher: SimulatedLauncher;
  runtime: eg.RemoteWorkspaceRuntime;
  signer: eg.Ed25519Signer;
  trustedPem: string;
  /** the control plane's PRIVATE test key as PEM: stands in for what a vault reference would resolve to (throw-away key, never persisted) */
  signerPem: string;
  /** a second, UNTRUSTED signer: tokens from it must be refused */
  rogue: eg.Ed25519Signer;
  /** raw request through the handler (for tests that forge or tamper) */
  rawCall(op: string, body: unknown, header?: string, headers?: Record<string, string>): Promise<{ status: number; json: unknown }>;
  dispose(): Promise<void>;
}
export interface RigOptions {
  nodeId?: string;
  endpointId?: string;
  maxSlots?: number;
  script?: eg.SimulatedScript;
  now?: () => number;
  monitorMs?: number;
  freeDiskMb?: () => Promise<number>;
  configOverride?: (c: Record<string, unknown>) => void;
  /** extra agent assembly options */
  assemble?: Partial<AssembleOptions>;
  callTimeoutMs?: number;
}
export const RIG_IMAGE = eg.SIMULATED_IMAGE_DIGEST;

export async function createAgentRig(o: RigOptions = {}): Promise<AgentRig> {
  const dir = await mkdtemp(join(tmpdir(), 'nuzm-agent-rig-'));
  const kp = generateKeyPairSync('ed25519');
  const rogueKp = generateKeyPairSync('ed25519');
  const trustedPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const nodeId = o.nodeId ?? 'sim-node';
  const endpointId = o.endpointId ?? 'sim-endpoint';
  const raw: Record<string, unknown> = {
    nodeId,
    endpointId,
    runtimeClass: 'gvisor-runsc',
    listen: { host: '127.0.0.1', port: 18443 },
    metrics: { host: '127.0.0.1', port: 19100 },
    tls: { keyFile: '/etc/nuzm/tls/key.pem', certFile: '/etc/nuzm/tls/cert.pem', caFile: '/etc/nuzm/tls/ca.pem', clientFingerprints: ['a'.repeat(64)] },
    trustedControlKeys: { 'cp-test': trustedPem },
    workspaceRoot: join(dir, 'workspaces'),
    stateDir: join(dir, 'state'),
    auditFile: join(dir, 'audit.jsonl'),
    images: { [RIG_IMAGE]: join(dir, 'rootfs') },
    toolchainDir: join(dir, 'toolchain'),
    maxSlots: o.maxSlots ?? 4,
    egress: { proxyAddr: '10.200.0.1:3128', allowHosts: eg.registryHosts() },
    quota: 'accounting',
    launcher: 'simulated',
    runsc: { path: '/usr/local/bin/runsc', rootDir: '/run/nuzm/runsc', platform: 'systrap' },
  };
  o.configOverride?.(raw);
  const parsed = parseAgentConfig(raw);
  if (!parsed.ok) throw new Error(`test config invalid: ${parsed.errors.join(',')}`);
  const cfg = parsed.config;
  const audit = new MemoryAuditSink();
  const launcher = new SimulatedLauncher(cfg.maxSlots);
  if (o.script) launcher.setScript(o.script);
  const agent = await assembleAgent(cfg, {
    audit,
    launcher,
    now: o.now,
    monitorMs: o.monitorMs,
    freeDiskMb: o.freeDiskMb ?? (async () => 100_000),
    verifiedImages: { [RIG_IMAGE]: join(dir, 'rootfs') },
    ...o.assemble,
  });
  const signer = new eg.Ed25519Signer('cp-test', kp.privateKey);
  const rogue = new eg.Ed25519Signer('cp-test', rogueKp.privateKey);
  const runtime = new eg.RemoteWorkspaceRuntime({
    nodeId,
    transport: new eg.LoopbackTransport(agent.handler),
    signer,
    runtimeClass: 'gvisor-runsc',
    isolation: 'simulated',
    now: o.now,
    callTimeoutMs: o.callTimeoutMs,
  });
  return {
    dir,
    cfg,
    agent,
    audit,
    launcher,
    runtime,
    signer,
    trustedPem,
    signerPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    rogue,
    async rawCall(op, body, header, headers = {}) {
      const buf = Buffer.from(JSON.stringify(body));
      const res = await agent.handler({
        method: 'POST',
        path: `/v1/${op}`,
        headers: { 'content-type': 'application/json', ...(header !== undefined ? { authorization: header } : {}), ...headers },
        body: buf,
      });
      return { status: res.status, json: JSON.parse(res.body.toString('utf8')) as unknown };
    },
    async dispose() {
      agent.service.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** a signed token header for a raw call (tests that need to craft a request) */
export async function tokenHeader(
  signer: eg.TokenSigner,
  nodeId: string,
  op: eg.NodeOp,
  body: unknown,
  bind: { orgId?: string; workspaceId?: string; handle?: string } = {},
  now = Date.now(),
): Promise<string> {
  return `NuzmNode ${await eg.signRequestToken(signer, { nodeId, op, body: Buffer.from(JSON.stringify(body)), now, ...bind })}`;
}

/** the real-runtime port over a REAL agent (simulated launcher, loopback), started through the full fail-closed attestation path with a throw-away test key */
export function createAgentNodeTarget(opts: { pump?: (ms: number) => Promise<void>; now?: () => number } = {}): eg.ConformanceTarget & { dispose(): Promise<void> } {
  const kit = eg.createSimulatedKit();
  const now = opts.now ?? (() => Date.now());
  const rigs: AgentRig[] = [];
  let last: AgentRig | null = null;
  return {
    name: 'RealRuntimeExecutionPort over the node agent (simulated launcher, loopback)',
    origin: 'MOCK',
    label: 'SIMULATED',
    pump: opts.pump,
    supports: () => true,
    async portFor(ctx, f) {
      const rig = await createAgentRig({ script: () => f.simulate, now, monitorMs: 1000 });
      rigs.push(rig);
      last = rig;
      const node = { nodeId: rig.cfg.nodeId, endpointId: rig.cfg.endpointId };
      const svc = await eg.RealRuntimeService.start({
        mode: 'simulated',
        nodes: [{ ...node, runtime: rig.runtime, attestation: kit.attestation(node, { now: new Date(now()) }) }],
        trust: kit.trusted,
        environments: ['staging'],
        now,
        pollMs: 1000,
        graceMs: 2000,
        artifactSink: { put: async () => undefined },
      });
      return svc.portFor(ctx, { seedFiles: () => new Map(Object.entries(f.files())), canaries: () => [] });
    },
    async leftovers() {
      if (!last) return [];
      return [...(await last.agent.service.listWorkspaces()).map((w) => w.workspaceId), ...Array.from({ length: last.agent.service.activeCount() }, (_, i) => `run-${i}`), ...Array.from({ length: last.launcher.liveCount() }, (_, i) => `launched-${i}`)];
    },
    async dispose() {
      for (const r of rigs) await r.dispose();
    },
  };
}

/** the hand-off rig over a real agent */
export function createAgentHandoffRig(adapt: eg.PortAdapter, pump?: (ms: number) => Promise<void>, now: () => number = () => Date.now()): eg.HandoffRigFactory & { dispose(): Promise<void> } {
  const kit = eg.createSimulatedKit();
  const rigs: AgentRig[] = [];
  const PROJECT = () =>
    new Map([
      ['package.json', '{"name":"handoff","version":"0.0.0","private":true}\n'],
      ['src/index.ts', 'export const a = 1;\n'],
    ]);
  return {
    name: 'RealRuntimeExecutionPort over the node agent (simulated launcher, loopback)',
    async make(o) {
      const queues = new Map<string, eg.SimulatedBehavior[]>();
      const rig = await createAgentRig({
        nodeId: 'handoff-node',
        endpointId: 'handoff-endpoint',
        now,
        monitorMs: 1000,
        script: (spec) => {
          const profile = Object.entries(eg.EXEC_PROFILES).find(([, p]) => p.argv.join(' ') === spec.argv.join(' '))?.[0] ?? '';
          return queues.get(profile)?.shift() ?? {};
        },
      });
      rigs.push(rig);
      const node = { nodeId: rig.cfg.nodeId, endpointId: rig.cfg.endpointId };
      const svc = await eg.RealRuntimeService.start({
        mode: 'simulated',
        nodes: [{ ...node, runtime: rig.runtime, attestation: kit.attestation(node, { now: new Date(now()) }) }],
        trust: kit.trusted,
        environments: ['staging'],
        now,
        pollMs: 1000,
        graceMs: 2000,
        artifactSink: { put: async () => undefined },
      });
      const sources: unknown[] = [];
      const port = svc.portFor(
        { orgId: 'org-handoff', runId: 'run-handoff', enabledProfiles: o.enabledProfiles, projectScripts: [] },
        {
          seedFiles: (src) => {
            sources.push(src ?? null);
            return PROJECT();
          },
          canaries: () => [],
        },
      );
      return {
        name: 'RealRuntimeExecutionPort over the node agent (simulated launcher, loopback)',
        buildPort: adapt(port),
        script: (profile, ...b) => void queues.set(profile, [...(queues.get(profile) ?? []), ...b]),
        ranArgv: () => rig.launcher.launched.map((l) => [...l.spec.argv]),
        leftovers: async () => [...(await rig.agent.service.listWorkspaces()).map((w) => w.workspaceId), ...Array.from({ length: rig.launcher.liveCount() }, (_, i) => `launched-${i}`)],
        sources: () => sources,
        appliesArtifactPolicy: true,
        pump,
      };
    },
    async dispose() {
      for (const r of rigs) await r.dispose();
    },
  };
}
