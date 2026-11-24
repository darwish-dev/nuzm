import { createHash } from 'node:crypto';
import { canonicalJson } from './attestation';
import {
  SYNTHETIC_FIXTURES,
  type FixtureExpectation,
  type FixtureLayer,
  type SyntheticFixture,
} from './fixtures';
import { RealRuntimeService } from './real-runtime';
import { createSimulatedKit, SIMULATED_IMAGE_DIGEST } from './simulated-attestation';
import { SimulatedWorkspaceRuntime } from './workspace-runtime';
import { createMockExecutionPort } from '../mock-port';
import { EXEC_ENV, decideExec, type ExecContext, type ExecDecision } from '../policy';
import type { ExecutionOutcome, ExecutionPort, PortOrigin, ScriptedOutcome } from '../port';
import { EXEC_PROFILES } from '../policy';

/**
 * S-AG6 PHASE 2 (OFFLINE): the PORT CONFORMANCE SUITE. One set of assertions about what an `ExecutionPort` must do, run against any `ConformanceTarget`:
 *   - NOW: `MockExecutionPort` (scripted) and the real-runtime port over `SimulatedWorkspaceRuntime` (a stand-in node). Every result is labelled SIMULATED; neither can show that a
 *     hostile process is contained. What they DO verify is the control-plane half: refusals, tenant binding, approvals, seed screening, dependency policy, artifact policy, output
 *     caps, kill and cleanup bookkeeping.
 *   - LATER: a target over a real attested staging endpoint runs the very same fixtures with the files really executed. Only then can the resource/hazard cases mean anything,
 *     and the report is LIVE-VERIFIED only for a `REAL` target whose port started under a verified attestation (HG-10-02).
 * A case a target cannot exercise is SKIPPED with a reason, never PASS.
 */
export const CONFORMANCE_VERSION = '1.0.0';
export type CaseStatus = 'PASS' | 'FAIL' | 'SKIPPED';
export interface ConformanceTarget {
  name: string;
  origin: PortOrigin;
  /** `LIVE-VERIFIED` only for a REAL target that started under a verified attestation; everything else is `SIMULATED` */
  label: 'SIMULATED' | 'LIVE-VERIFIED';
  supports(layer: FixtureLayer): true | string;
  /** a port for this run, with the stand-in scripted by the fixture (a real target ignores `fixture.simulate`) */
  portFor(ctx: ExecContext, fixture: SyntheticFixture): Promise<ExecutionPort>;
  /** workspaces or processes still alive after the last run: must be empty */
  leftovers(): Promise<string[]>;
  /** advance a simulated clock while a run is pending (fake-timer targets); real targets do not set it */
  pump?: (ms: number) => Promise<void>;
}
export interface CaseResult {
  id: string;
  title: string;
  layer: FixtureLayer | 'contract';
  status: CaseStatus;
  note: string;
  /**
   * what only a REAL attested node can show for this case (null: the case is fully about control-plane logic, which a simulated run does verify). A PASS with a non-null value
   * here proves the policy and bookkeeping around the behaviour, NOT that the behaviour is enforced.
   */
  needsRealNode: string | null;
}
/** printed in every report: a simulated run is evidence about policy logic, never about isolation */
export const SIMULATED_STATEMENT =
  "SIMULATED: these results prove the control plane's policy, bookkeeping and refusals only. They do NOT prove isolation, resource enforcement, network segmentation or that hostile code is contained; only an attested real node can (see needsRealNode per case).";
const REAL_NODE_BY_HAZARD: Record<string, string> = {
  cpu: 'a real node must enforce the CPU/wall limit (cgroup cpu.max, a kill that removes the whole process group or VM)',
  memory: 'a real node must enforce memory.max with OOM-kill and no swap',
  pids: 'a real node must enforce pids.max in the sandbox',
  disk: 'a real node must enforce the per-workspace disk and inode quota',
  output:
    'a real node must cap output at the source so a flood cannot exhaust the agent or the pipe',
  network:
    'a real node must enforce default-deny egress, the metadata block and the registry allowlist at the host firewall and proxy',
  filesystem:
    'a real node must prevent a symlink, hard link or mount from reaching outside the workspace',
  environment:
    'a real node must run the process with only the constant environment and no host secrets',
  lifecycle: 'a real node must prove lifecycle scripts do not run and nothing outlives the run',
};
const realNodeNote = (f: SyntheticFixture): string | null =>
  f.layer === 'policy' || f.layer === 'workspace' || f.layer === 'dependency'
    ? null
    : (REAL_NODE_BY_HAZARD[f.hazard] ??
      'a real node must run the real files and show the real exit code, output and produced files');
export interface ConformanceReport {
  conformanceVersion: string;
  /** `SIMULATED_STATEMENT` for any non-live target */
  statement: string;
  target: { name: string; origin: PortOrigin; label: ConformanceTarget['label'] };
  total: number;
  pass: number;
  fail: number;
  skipped: number;
  /** true only for a live REAL target with zero failures: a simulated target can never produce isolation evidence */
  isolationEvidence: boolean;
  results: CaseResult[];
  /** sha256 of the canonical results: what an attestation's `escapeSuite.reportSha256` style reference points at */
  reportSha256: string;
}

const ENV_ALLOWED = new Set([
  ...Object.keys(EXEC_ENV),
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'NODE',
  'INIT_CWD',
  'COLOR',
  'EXEPATH',
]);
const STATUSES = new Set(['completed', 'failed', 'timeout', 'terminated', 'refused']);
export const CONF_ORG = 'org-conf';
export const CONF_RUN = 'run-conf';
const ctxFor = (f: SyntheticFixture): ExecContext => ({
  orgId: CONF_ORG,
  runId: CONF_RUN,
  enabledProfiles: Object.keys(EXEC_PROFILES),
  projectScripts: f.scripts,
});

function judge(
  e: FixtureExpectation,
  refusal: string | null,
  o: ExecutionOutcome | null,
): string | null {
  if (e.kind === 'refused') {
    const seen = refusal ?? (o && o.status === 'refused' ? o.stderr : null);
    if (seen === null) return `expected a refusal (${e.reason}) but the request ran`;
    return seen.includes(e.reason) ? null : `refused for a different reason than ${e.reason}`;
  }
  if (refusal !== null) return `expected a run but it was refused (${refusal.slice(0, 80)})`;
  if (!o) return 'no outcome';
  const text = `${o.stdout}\n${o.stderr}`;
  if (!e.status.includes(o.status)) return `status ${o.status} not in [${e.status.join(',')}]`;
  if (e.exitCode === 'zero' && o.exitCode !== 0) return 'expected exit code 0';
  if (e.exitCode === 'nonzero' && o.exitCode === 0) return 'expected a non-zero exit code';
  for (const s of e.stdoutIncludes ?? []) if (!text.includes(s)) return `output lacks "${s}"`;
  for (const s of e.stdoutExcludes ?? [])
    if (text.includes(s)) return `output contains forbidden "${s}"`;
  if (e.truncated !== undefined && o.truncated !== e.truncated)
    return `truncated is ${o.truncated}`;
  if (e.artifacts) {
    const got = o.artifacts.map((a) => a.path).sort();
    const want = [...e.artifacts].sort();
    if (got.join('|') !== want.join('|'))
      return `artifacts [${got.join(',')}] differ from [${want.join(',')}]`;
  }
  if (e.envKeysOnly) {
    const bad = o.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !ENV_ALLOWED.has(l) && !l.startsWith('npm_'));
    if (bad.length > 0) return `environment shows ${bad.length} variable(s) outside the constant`;
  }
  return null;
}

async function drive(
  target: ConformanceTarget,
  fn: () => Promise<ExecutionOutcome>,
): Promise<ExecutionOutcome> {
  let settled = false;
  const p = fn().finally(() => {
    settled = true;
  });
  if (target.pump) for (let i = 0; i < 500 && !settled; i++) await target.pump(1000);
  return p;
}

async function runFixture(
  target: ConformanceTarget,
  f: SyntheticFixture,
): Promise<{ refusal: string | null; outcome: ExecutionOutcome | null }> {
  const port = await target.portFor(ctxFor(f), f);
  const d: ExecDecision = await port.request({
    orgId: CONF_ORG,
    runId: CONF_RUN,
    profile: f.request.profile,
    params: f.request.params,
  });
  if (!d.allowed) return { refusal: d.reasons.join(','), outcome: null };
  const outcome = await drive(target, () =>
    port.run(d, {
      orgId: CONF_ORG,
      runId: CONF_RUN,
      approvalId: d.requiresApproval && f.approved ? 'ap-conformance' : undefined,
    }),
  );
  return { refusal: null, outcome };
}

export async function runPortConformance(
  target: ConformanceTarget,
  fixtures: readonly SyntheticFixture[] = SYNTHETIC_FIXTURES,
): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  const add = (
    id: string,
    title: string,
    layer: CaseResult['layer'],
    status: CaseStatus,
    note: string,
    needsRealNode: string | null = null,
  ) => results.push({ id, title, layer, status, note, needsRealNode });
  const attempt = async (
    id: string,
    title: string,
    layer: CaseResult['layer'],
    fn: () => Promise<string | null>,
    needs: string | null = null,
  ) => {
    try {
      const why = await fn();
      add(id, title, layer, why === null ? 'PASS' : 'FAIL', why ?? 'as required', needs);
    } catch (e) {
      add(id, title, layer, 'FAIL', `threw: ${(e as Error).message.slice(0, 120)}`, needs);
    }
  };
  const base = fixtures.find((x) => x.id === 'FX-OK-TYPECHECK') ?? SYNTHETIC_FIXTURES[0]!;

  // ---- contract cases that hold for every port
  await attempt('CP-1', 'a refused decision is never run', 'contract', async () => {
    const port = await target.portFor(ctxFor(base), base);
    const bad = decideExec(
      { orgId: CONF_ORG, runId: CONF_RUN, profile: 'definitely-not-a-profile' },
      ctxFor(base),
    );
    const o = await port.run(bad, { orgId: CONF_ORG, runId: CONF_RUN });
    return o.status === 'refused' ? null : `status ${o.status}`;
  });
  await attempt('CP-2', 'another organization or run is refused', 'contract', async () => {
    const port = await target.portFor(ctxFor(base), base);
    const d = await port.request({ orgId: CONF_ORG, runId: CONF_RUN, profile: 'typecheck' });
    const a = await port.run(d, { orgId: 'org-other', runId: CONF_RUN });
    const b = await port.run(d, { orgId: CONF_ORG, runId: 'run-other' });
    return a.status === 'refused' && b.status === 'refused' ? null : `got ${a.status}/${b.status}`;
  });
  await attempt(
    'CP-3',
    'a request that needs approval is refused without one',
    'contract',
    async () => {
      const f = fixtures.find((x) => x.id === 'FX-INSTALL-NO-APPROVAL') ?? base;
      const port = await target.portFor(ctxFor(f), f);
      const d = await port.request({ orgId: CONF_ORG, runId: CONF_RUN, profile: 'install-deps' });
      if (!d.allowed) return 'the install request itself was refused';
      const o = await port.run(d, { orgId: CONF_ORG, runId: CONF_RUN });
      return o.status === 'refused' && o.stderr.includes('approval_required')
        ? null
        : `status ${o.status}`;
    },
  );
  await attempt(
    'CP-4',
    'an already-aborted signal ends as terminated, nothing runs',
    'contract',
    async () => {
      const port = await target.portFor(ctxFor(base), base);
      const d = await port.request({ orgId: CONF_ORG, runId: CONF_RUN, profile: 'typecheck' });
      const ac = new AbortController();
      ac.abort();
      const o = await port.run(d, { orgId: CONF_ORG, runId: CONF_RUN, signal: ac.signal });
      return o.status === 'terminated' ? null : `status ${o.status}`;
    },
  );
  await attempt(
    'CP-5',
    'the outcome has the contract shape and carries no command or environment',
    'contract',
    async () => {
      const { outcome } = await runFixture(target, base);
      if (!outcome) return 'no outcome';
      // `usage` is the optional, additive measured-usage member (contract 0.1 + CONTRACT-04-4)
      const keys = Object.keys(outcome)
        .filter((k) => k !== 'usage')
        .sort()
        .join(',');
      if (keys !== 'artifacts,durationMs,exitCode,status,stderr,stdout,truncated')
        return `unexpected members: ${keys}`;
      if (
        !STATUSES.has(outcome.status) ||
        typeof outcome.durationMs !== 'number' ||
        !Array.isArray(outcome.artifacts)
      )
        return 'member types';
      return null;
    },
  );
  await attempt(
    'CP-6',
    'the origin is truthful: REAL only for a live-verified target',
    'contract',
    async () => {
      if (target.origin === 'REAL' && target.label !== 'LIVE-VERIFIED')
        return 'a REAL port without live-verified evidence';
      if (target.label === 'LIVE-VERIFIED' && target.origin !== 'REAL')
        return 'live-verified label on a non-REAL port';
      return null;
    },
  );

  // ---- one case per synthetic fixture
  for (const f of fixtures) {
    const sup = target.supports(f.layer);
    if (sup !== true) {
      add(f.id, f.title, f.layer, 'SKIPPED', sup, realNodeNote(f));
      continue;
    }
    await attempt(
      f.id,
      f.title,
      f.layer,
      async () => {
        const { refusal, outcome } = await runFixture(target, f);
        const why = judge(f.expect, refusal, outcome);
        if (why) return why;
        const left = await target.leftovers();
        return left.length === 0 ? null : `left behind: ${left.length} workspace(s)/process(es)`;
      },
      target.label === 'LIVE-VERIFIED' ? null : realNodeNote(f),
    );
  }
  const count = (s: CaseStatus) => results.filter((r) => r.status === s).length;
  const fail = count('FAIL');
  return {
    conformanceVersion: CONFORMANCE_VERSION,
    statement: target.label === 'LIVE-VERIFIED' ? 'LIVE-VERIFIED target' : SIMULATED_STATEMENT,
    target: { name: target.name, origin: target.origin, label: target.label },
    total: results.length,
    pass: count('PASS'),
    fail,
    skipped: count('SKIPPED'),
    isolationEvidence:
      target.label === 'LIVE-VERIFIED' &&
      target.origin === 'REAL' &&
      fail === 0 &&
      count('SKIPPED') === 0,
    results,
    reportSha256: createHash('sha256')
      .update(canonicalJson({ v: CONFORMANCE_VERSION, t: target.name, r: results }))
      .digest('hex'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// targets available today (both SIMULATED)

/** the fixture's stand-in behaviour as a scripted mock outcome (a hang becomes "ran past the wall limit"; the mock executes nothing) */
function toScripted(f: SyntheticFixture, wallSeconds: number): ScriptedOutcome {
  const s = f.simulate;
  return {
    exitCode: s.hang ? null : (s.exitCode ?? 0),
    stdout: s.stdout ?? '',
    stderr: s.stderr ?? '',
    durationMs: s.hang ? wallSeconds * 1000 + 1 : (s.durationMs ?? 1),
    status: s.hang ? 'timeout' : (s.exitCode ?? 0) === 0 ? 'completed' : 'failed',
  };
}
export function createMockTarget(): ConformanceTarget {
  return {
    name: 'MockExecutionPort',
    origin: 'MOCK',
    label: 'SIMULATED',
    supports: (layer) =>
      layer === 'policy' || layer === 'runtime'
        ? true
        : `the mock does not exercise the "${layer}" layer (it has no workspace, installer, artifact reader or resource monitor)`,
    async portFor(ctx, f) {
      const port = createMockExecutionPort(ctx);
      const own = Object.prototype.hasOwnProperty.call(EXEC_PROFILES, f.request.profile);
      const wall = own ? EXEC_PROFILES[f.request.profile]!.limits.wallSeconds : 180;
      port.script(f.request.profile, toScripted(f, wall));
      return port;
    },
    leftovers: async () => [],
  };
}

export interface SimulatedNodeTargetOptions {
  pump?: (ms: number) => Promise<void>;
  now?: () => number;
}
/** the real-runtime port over a SimulatedWorkspaceRuntime, started through the full fail-closed attestation path with a throw-away test key */
export function createSimulatedNodeTarget(
  opts: SimulatedNodeTargetOptions = {},
): ConformanceTarget {
  const kit = createSimulatedKit();
  const now = opts.now ?? (() => Date.now());
  let last: SimulatedWorkspaceRuntime | null = null;
  return {
    name: 'RealRuntimeExecutionPort over SimulatedWorkspaceRuntime',
    origin: 'MOCK',
    label: 'SIMULATED',
    pump: opts.pump,
    supports: () => true,
    async portFor(ctx, f) {
      const node = { nodeId: 'sim-node', endpointId: 'sim-endpoint' };
      const runtime = new SimulatedWorkspaceRuntime({
        ...node,
        runtimeClass: 'gvisor-runsc',
        imageDigests: [SIMULATED_IMAGE_DIGEST],
      });
      runtime.setScript(() => f.simulate);
      last = runtime;
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
      return svc.portFor(ctx, {
        seedFiles: () => new Map(Object.entries(f.files())),
        canaries: () => [],
      });
    },
    async leftovers() {
      return last ? [...last.liveWorkspaces(), ...last.liveRuns()] : [];
    },
  };
}
