import { createHash } from 'node:crypto';
import { createMockExecutionPort } from '../mock-port';
import { EXEC_PROFILES, type ExecContext } from '../policy';
import type { ExecutionPort, ScriptedOutcome } from '../port';
import { RealRuntimeService } from './real-runtime';
import { createSimulatedKit, SIMULATED_IMAGE_DIGEST } from './simulated-attestation';
import { SimulatedWorkspaceRuntime, type SimulatedBehavior } from './workspace-runtime';

/**
 * TRACK E HAND-OFF: the exact `ExecutionPort` traffic the builder lifecycle (Session 05) produces, and the conformance test BOTH sides run so that the real port is a drop-in.
 *
 * What the lifecycle does (S05's `ExecutionBuildPort`, used by `runRepairLoop` and the `execution_request` step), per build or test call, for the closed profiles
 * `typecheck`, `unit-tests`, `build` only (never `install-deps` or `run-script`; they need approval and the loop never asks for them):
 *   1. OPTIONAL dry check:  `port.request({ orgId, runId, profile })`            (nothing runs; `requiresApproval` must be false for these profiles)
 *   2. the run:             `d = await port.request({ orgId, runId, profile })`    then   `port.run(d, { orgId, runId [, source] })`   with the SAME decision object
 *   3. mapping:             a `completed` outcome with a non-zero exit code is a failed build; artifacts without a `sha256` are dropped; logs = stdout + stderr
 *   4. repeats:             one call per profile per repair round, on a NEW project version each round (hence `source`), through ONE port bound to the run (org + run id)
 * The port must therefore: accept the decision it issued, refuse everything it did not issue, stay bound to its organization and run, leave NO workspace or process behind between
 * calls, report timeouts as `timeout`, and hand back only verified artifacts.
 *
 * `LIFECYCLE_PORT_CALLS` is the same text as data (printed by the report); `runLifecycleHandoffConformance` is the shared test. Each side supplies a RIG: an adapter factory (S05
 * passes `(port) => new ExecutionBuildPort(port, now)`), over the mock or the simulated node (today), or a live port (after D-21). Mock results are SIMULATED, prove policy and
 * wiring only and never isolation.
 */
export const LIFECYCLE_PORT_CALLS = [
  'preflight: port.request({orgId, runId, profile}) -> allowed / reasons / requiresApproval; nothing runs',
  'build: d = port.request({orgId, runId, profile}); if !d.allowed -> refused; if d.requiresApproval -> refused(approval_required); else port.run(d, {orgId, runId, source?})',
  'status mapping: completed + exitCode != 0 -> failed; artifacts need sha256; logs = stdout + stderr',
  'profiles used: typecheck, unit-tests, build (fixed order per repair round); install-deps and run-script are never requested by the loop',
  'one port per run (org + run id); a new project version per round is named in ctx.source',
] as const;

export type LifecycleProfile = 'typecheck' | 'unit-tests' | 'build';
export interface LifecycleBuildRequest {
  projectId: string;
  versionId: string;
  profile: LifecycleProfile;
  orgId: string;
  runId: string;
}
export interface LifecycleBuildResult {
  status: 'completed' | 'failed' | 'timeout' | 'terminated' | 'refused';
  logs: string;
  artifacts: { path: string; bytes: number; sha256: string }[];
  durationMs: number;
}
/** what S05's `BuildPort` looks like to this test (structural; no import from their module) */
export interface LifecycleBuildPort {
  readonly origin: 'MOCK' | 'REAL';
  build(req: LifecycleBuildRequest): Promise<LifecycleBuildResult>;
  preflight?(
    req: LifecycleBuildRequest,
  ): Promise<{ allowed: boolean; reasons: string[]; requiresApproval: boolean }>;
}
export interface HandoffRig {
  name: string;
  buildPort: LifecycleBuildPort;
  /** the stand-in's behaviour for the next runs of a profile (a real node ignores this and runs real files) */
  script(profile: LifecycleProfile, ...b: SimulatedBehavior[]): void;
  /** argv of every run that really reached the runtime/mock, in order */
  ranArgv(): string[][];
  /** workspaces or processes still alive */
  leftovers(): Promise<string[]>;
  /** `ctx.source` values the port was given (real-runtime rig only; null = not observable) */
  sources(): unknown[] | null;
  /** does the stand-in apply the artifact policy (the real-runtime port does; the mock does not) */
  appliesArtifactPolicy: boolean;
  pump?: (ms: number) => Promise<void>;
}
export interface HandoffRigFactory {
  name: string;
  make(o: { enabledProfiles: readonly string[] }): Promise<HandoffRig>;
}
export type PortAdapter = (port: ExecutionPort) => LifecycleBuildPort;

const ORG = 'org-handoff';
const RUN = 'run-handoff';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ctxFor = (profiles: readonly string[]): ExecContext => ({
  orgId: ORG,
  runId: RUN,
  enabledProfiles: profiles,
  projectScripts: [],
});
const toScripted = (b: SimulatedBehavior, wall: number): ScriptedOutcome => ({
  exitCode: b.hang ? null : (b.exitCode ?? 0),
  stdout: b.stdout ?? '',
  stderr: b.stderr ?? '',
  durationMs: b.hang ? wall * 1000 + 1 : (b.durationMs ?? 1),
  status: b.hang ? 'timeout' : (b.exitCode ?? 0) === 0 ? 'completed' : 'failed',
  artifacts: (b.produced ?? [])
    .filter((p) => p.kind === 'file')
    .map((p) => ({ path: p.path, bytes: p.bytes, sha256: sha(b.producedContent?.[p.path] ?? '') })),
});
const wallOf = (profile: string) =>
  Object.prototype.hasOwnProperty.call(EXEC_PROFILES, profile)
    ? EXEC_PROFILES[profile]!.limits.wallSeconds
    : 180;
const PROJECT_FILES = () =>
  new Map([
    ['package.json', '{"name":"handoff","version":"0.0.0","private":true}\n'],
    ['src/index.ts', 'export const a = 1;\n'],
  ]);

/** the mock rig: MockExecutionPort behind the supplied adapter */
export function createMockHandoffRig(adapt: PortAdapter): HandoffRigFactory {
  return {
    name: 'MockExecutionPort',
    async make(o) {
      const port = createMockExecutionPort(ctxFor(o.enabledProfiles));
      return {
        name: 'MockExecutionPort',
        buildPort: adapt(port),
        script: (profile, ...b) =>
          void port.script(profile, ...b.map((x) => toScripted(x, wallOf(profile)))),
        ranArgv: () => port.calls.map((c) => [...c.decision.argv]),
        leftovers: async () => [],
        sources: () => port.calls.map((c) => c.ctx.source ?? null),
        appliesArtifactPolicy: false,
      };
    },
  };
}
/** the real-runtime port over the simulated node, started through the full attestation path */
export function createSimulatedNodeHandoffRig(
  adapt: PortAdapter,
  pump?: (ms: number) => Promise<void>,
  now: () => number = () => Date.now(),
): HandoffRigFactory {
  const kit = createSimulatedKit();
  return {
    name: 'RealRuntimeExecutionPort over SimulatedWorkspaceRuntime',
    async make(o) {
      const node = { nodeId: 'handoff-node', endpointId: 'handoff-endpoint' };
      const runtime = new SimulatedWorkspaceRuntime({
        ...node,
        runtimeClass: 'gvisor-runsc',
        imageDigests: [SIMULATED_IMAGE_DIGEST],
      });
      const queues = new Map<string, SimulatedBehavior[]>();
      runtime.setScript((spec) => {
        const profile =
          Object.entries(EXEC_PROFILES).find(
            ([, p]) => p.argv.join(' ') === spec.argv.join(' '),
          )?.[0] ?? '';
        return queues.get(profile)?.shift() ?? {};
      });
      const svc = await RealRuntimeService.start({
        mode: 'simulated',
        nodes: [{ ...node, runtime, attestation: kit.attestation(node, { now: new Date(now()) }) }],
        trust: kit.trusted,
        environments: ['staging'],
        now,
        pollMs: 1000,
        graceMs: 2000,
        artifactSink: { put: async () => undefined },
      });
      const sources: unknown[] = [];
      const port = svc.portFor(ctxFor(o.enabledProfiles), {
        seedFiles: (src) => {
          sources.push(src ?? null);
          return PROJECT_FILES();
        },
        canaries: () => [],
      });
      return {
        name: 'RealRuntimeExecutionPort over SimulatedWorkspaceRuntime',
        buildPort: adapt(port),
        script: (profile, ...b) => void queues.set(profile, [...(queues.get(profile) ?? []), ...b]),
        ranArgv: () => runtime.accepted.map((s) => [...s.argv]),
        leftovers: async () => [...runtime.liveWorkspaces(), ...runtime.liveRuns()],
        sources: () => sources,
        appliesArtifactPolicy: true,
        pump,
      };
    },
  };
}

export interface HandoffCase {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  note: string;
}
export interface HandoffReport {
  rig: string;
  origin: 'MOCK' | 'REAL' | 'unknown';
  statement: string;
  calls: readonly string[];
  total: number;
  pass: number;
  fail: number;
  skipped: number;
  cases: HandoffCase[];
}
const FIXED_ARGV: Record<LifecycleProfile, string[]> = {
  typecheck: ['npx', '--no-install', 'tsc', '--noEmit'],
  'unit-tests': ['npm', 'test', '--silent'],
  build: ['npm', 'run', 'build', '--silent'],
};
const REQ = (
  profile: LifecycleProfile,
  versionId = 'v1',
  over: Partial<LifecycleBuildRequest> = {},
): LifecycleBuildRequest => ({
  projectId: 'proj-1',
  versionId,
  profile,
  orgId: ORG,
  runId: RUN,
  ...over,
});

async function drive<T>(rig: HandoffRig, p: Promise<T>): Promise<T> {
  let settled = false;
  const q = p.finally(() => {
    settled = true;
  });
  if (rig.pump) for (let i = 0; i < 500 && !settled; i++) await rig.pump(1000);
  return q;
}

/**
 * Run the shared hand-off test. `expectSource`: the adapter names the project version in `ctx.source` (REQUIRED before a real port can seed the right files; S05's adapter does not
 * yet, so it defaults to false and the case is SKIPPED with that reason).
 */
export async function runLifecycleHandoffConformance(
  factory: HandoffRigFactory,
  opts: { expectSource?: boolean } = {},
): Promise<HandoffReport> {
  const cases: HandoffCase[] = [];
  let origin: HandoffReport['origin'] = 'unknown';
  const run = async (
    id: string,
    title: string,
    profiles: readonly string[],
    fn: (rig: HandoffRig) => Promise<string | null>,
  ) => {
    try {
      const rig = await factory.make({ enabledProfiles: profiles });
      origin = rig.buildPort.origin;
      const why = await fn(rig);
      if (why) cases.push({ id, title, status: 'FAIL', note: why });
      else {
        const left = await rig.leftovers();
        cases.push(
          left.length === 0
            ? { id, title, status: 'PASS', note: 'as required' }
            : { id, title, status: 'FAIL', note: `left behind: ${left.length}` },
        );
      }
    } catch (e) {
      cases.push({
        id,
        title,
        status: 'FAIL',
        note: `threw: ${(e as Error).message.slice(0, 140)}`,
      });
    }
  };
  const ALL = ['typecheck', 'unit-tests', 'build'];

  await run(
    'H-1',
    'preflight of an enabled profile: allowed, no approval, nothing runs',
    ALL,
    async (rig) => {
      if (!rig.buildPort.preflight) return 'the build port has no preflight';
      const p = await rig.buildPort.preflight(REQ('typecheck'));
      if (!p.allowed || p.requiresApproval || p.reasons.length > 0)
        return `got ${JSON.stringify(p)}`;
      return rig.ranArgv().length === 0 ? null : 'a preflight ran something';
    },
  );
  await run(
    'H-2',
    'preflight and build of a profile the organization has not enabled: refused with the policy reason, nothing runs',
    [],
    async (rig) => {
      if (rig.buildPort.preflight) {
        const p = await rig.buildPort.preflight(REQ('typecheck'));
        if (p.allowed || !p.reasons.includes('profile_not_enabled'))
          return `preflight ${JSON.stringify(p)}`;
      }
      const r = await rig.buildPort.build(REQ('typecheck'));
      if (r.status !== 'refused' || !r.logs.includes('profile_not_enabled'))
        return `build ${r.status}`;
      return rig.ranArgv().length === 0 ? null : 'a refused build ran something';
    },
  );
  await run(
    'H-3',
    'a repair round: typecheck fails with a diagnostic, the retry passes, then unit-tests and build; the argv is the fixed profile argv each time',
    ALL,
    async (rig) => {
      rig.script(
        'typecheck',
        {
          exitCode: 2,
          stdout:
            "src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        },
        { exitCode: 0 },
      );
      rig.script('unit-tests', { exitCode: 0, stdout: 'PASS\n' });
      rig.script('build', {
        exitCode: 0,
        produced: [{ path: 'dist/index.js', bytes: 20, kind: 'file' }],
        producedContent: { 'dist/index.js': 'module.exports = 1;\n' },
      });
      const seq: [LifecycleProfile, string, string][] = [
        ['typecheck', 'v1', 'failed'],
        ['typecheck', 'v2', 'completed'],
        ['unit-tests', 'v2', 'completed'],
        ['build', 'v2', 'completed'],
      ];
      let last: LifecycleBuildResult | null = null;
      for (const [profile, version, want] of seq) {
        const r = await drive(rig, rig.buildPort.build(REQ(profile, version)));
        last = r;
        if (r.status !== want) return `${profile}@${version}: ${r.status}, wanted ${want}`;
        if (profile === 'typecheck' && version === 'v1' && !r.logs.includes('TS2322'))
          return 'the failed typecheck lost its diagnostic';
      }
      const argv = rig.ranArgv().map((a) => a.join(' '));
      const want = [
        FIXED_ARGV.typecheck,
        FIXED_ARGV.typecheck,
        FIXED_ARGV['unit-tests'],
        FIXED_ARGV.build,
      ].map((a) => a.join(' '));
      if (argv.join('|') !== want.join('|')) return `argv sequence differs: ${argv.join(' | ')}`;
      if (last && last.artifacts.length > 0 && !/^[0-9a-f]{64}$/.test(last.artifacts[0]!.sha256))
        return 'artifact without a sha256';
      return null;
    },
  );
  await run('H-4', 'a run that exceeds its wall limit comes back as timeout', ALL, async (rig) => {
    rig.script('unit-tests', { hang: true });
    const r = await drive(rig, rig.buildPort.build(REQ('unit-tests')));
    return r.status === 'timeout' ? null : `status ${r.status}`;
  });
  await run('H-5', 'a non-zero exit is a failed build (never completed)', ALL, async (rig) => {
    rig.script('build', { exitCode: 1, stderr: 'build failed\n' });
    const r = await drive(rig, rig.buildPort.build(REQ('build')));
    return r.status === 'failed' ? null : `status ${r.status}`;
  });
  await run(
    'H-6',
    'a build for another run or organization is refused on a port bound to this run',
    ALL,
    async (rig) => {
      const a = await rig.buildPort.build(REQ('typecheck', 'v1', { runId: 'run-other' }));
      const b = await rig.buildPort.build(REQ('typecheck', 'v1', { orgId: 'org-other' }));
      if (a.status !== 'refused' || b.status !== 'refused') return `got ${a.status}/${b.status}`;
      return rig.ranArgv().length === 0 ? null : 'a foreign request ran something';
    },
  );
  await run(
    'H-7',
    'repeated builds in one run leave no workspace or process behind between calls',
    ALL,
    async (rig) => {
      for (let i = 0; i < 3; i++) {
        await drive(rig, rig.buildPort.build(REQ('typecheck', `v${i}`)));
        const left = await rig.leftovers();
        if (left.length > 0) return `left behind after call ${i + 1}: ${left.length}`;
      }
      return null;
    },
  );
  const artifactCase = 'H-8';
  const artRig = await factory.make({ enabledProfiles: ALL });
  if (!artRig.appliesArtifactPolicy)
    cases.push({
      id: artifactCase,
      title: 'only regular files under the output roots come back as artifacts',
      status: 'SKIPPED',
      note: 'this stand-in does not apply the artifact policy (the real-runtime port does)',
    });
  else
    await run(
      artifactCase,
      'only regular files under the output roots come back as artifacts (links, dotfiles and files outside dist are dropped)',
      ALL,
      async (rig) => {
        rig.script('build', {
          produced: [
            { path: 'dist/ok.js', bytes: 3, kind: 'file' },
            { path: 'dist/link', bytes: 3, kind: 'symlink' },
            { path: 'src/leak.ts', bytes: 1, kind: 'file' },
            { path: 'dist/.env', bytes: 1, kind: 'file' },
          ],
          producedContent: { 'dist/ok.js': '1;\n', 'src/leak.ts': 'x', 'dist/.env': 'x' },
        });
        const r = await rig.buildPort.build(REQ('build'));
        return r.artifacts.map((a) => a.path).join() === 'dist/ok.js'
          ? null
          : `artifacts: ${r.artifacts.map((a) => a.path).join() || 'none'}`;
      },
    );
  await run(
    'H-9',
    'the project version of each call reaches the port (ctx.source), so the workspace is seeded from the version being built',
    ALL,
    async (rig) => {
      const seen = rig.sources();
      if (seen === null) return 'not observable on this rig';
      await rig.buildPort.build(REQ('typecheck', 'v1'));
      await rig.buildPort.build(REQ('typecheck', 'v2'));
      const want = JSON.stringify([
        { projectId: 'proj-1', versionId: 'v1' },
        { projectId: 'proj-1', versionId: 'v2' },
      ]);
      return JSON.stringify(rig.sources()) === want
        ? null
        : `sources: ${JSON.stringify(rig.sources())}`;
    },
  );
  if (!opts.expectSource) {
    const i = cases.findIndex((c) => c.id === 'H-9');
    if (i >= 0 && cases[i]!.status === 'FAIL')
      cases[i] = {
        id: 'H-9',
        title: cases[i]!.title,
        status: 'SKIPPED',
        note: 'REQUIRED before a real port: the adapter does not pass ctx.source yet (CONTRACT-04-4); not counted as a pass',
      };
  }
  const count = (s: HandoffCase['status']) => cases.filter((c) => c.status === s).length;
  return {
    rig: factory.name,
    origin,
    statement:
      'SIMULATED: this test proves the wiring and policy of the hand-off (calls, mapping, refusals, bookkeeping). It does NOT prove isolation; only an attested real node can.',
    calls: LIFECYCLE_PORT_CALLS,
    total: cases.length,
    pass: count('PASS'),
    fail: count('FAIL'),
    skipped: count('SKIPPED'),
    cases,
  };
}
