import { createHash } from 'node:crypto';
import { executionGateway as eg, scanForSecrets } from '@nuzm/domain';
import { runInRuntime } from '../sandbox/run-in-runtime';
import {
  verifySandboxIsolation,
  type IsolationVerdict,
  type SandboxIsolationEvidence,
} from './db-provisioning';
import { generateProject, runtimeFiles, SCAFFOLD_VERSION } from './project';
import { platformFileHashes, runStaticGates, type GateReport } from './static-gates';
import type { FullStackOptions } from './options';
import type { AppSpec } from '../spec/app-spec';

/**
 * P3-S05 run-and-probe harness, PLATFORM SIDE. The probe itself (`probe/run.ts` + `probe/suite.ts` of the template) runs INSIDE the isolated runtime: it starts an ephemeral PostgreSQL, migrates, starts the
 * app, probes it and prints one `NUZM_PROBE_REPORT <json>` line. This module
 *   1. runs the static gates on the generated project (a failure never reaches the runtime and feeds the repair loop),
 *   2. asks the runtime for the probe through a PORT (today: the simulated runtime through `runInRuntime`; later the qualified runtime, same code path),
 *   3. treats the output as UNTRUSTED DATA: it parses, validates the shape, RECOMPUTES every count and the verdict itself, screens for secrets, and
 *   4. produces an evidence record whose label is decided HERE from the runtime's origin, never from anything the report says.
 * A run on the simulated runtime can at best be `SIMULATED`; with no real node it is `NOT VERIFIED`. Nothing here executes generated code on the machine it runs on.
 */

/**
 * The files that are seeded into the runtime workspace. Documentation that exists only for people (`.env.example`, markdown) is NOT seeded: it carries placeholders that the gateway's strict
 * secret screen (which cannot tell a placeholder from a secret, by design) refuses, and nothing at run time reads it.
 */
export function workspaceSeed(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, c] of files) if (p !== '.env.example' && !/\.md$/.test(p)) out.set(p, c);
  return out;
}

/** The runtime profile used to start the probe. Today the closed catalogue only has `run-script` (human approval, script name from the project): `probe` is a script of the generated package.json.
 *  CONTRACT-P3-S05-1 asks P3-S02 for a dedicated `app-probe` profile (loopback-only network, ephemeral PostgreSQL binaries in the image, no approval needed); switching is changing this constant. */
export const PROBE_PROFILE = { profile: 'run-script', params: { script: 'probe' } } as const;
export const REPORT_PREFIX = 'NUZM_PROBE_REPORT ';
/** Mirrors `REQUIRED_CHECKS` of `templates/webapp-runtime/probe/suite.ts` (a unit test keeps the two identical). */
export const REQUIRED_CHECKS = [
  'health',
  'security-headers',
  'unauthenticated-rejected',
  'login',
  'login-wrong-password',
  'me',
  'crud',
  'validation',
  'pagination',
  'cross-user-isolation',
  'logout-revokes',
  'login-rate-limit',
  'cross-origin-refused',
] as const;
const MAX_REPORT_BYTES = 200_000;
const CHECK_STATUS = new Set(['pass', 'fail', 'skipped']);

export interface ParsedCheck {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
  ms: number;
}
export interface VerifiedProbe {
  checks: ParsedCheck[];
  passed: number;
  failed: number;
  skipped: number;
  requiredNotPassed: string[];
  /** recomputed by the platform: no failed check and every required check passed */
  ok: boolean;
  tenancy: 'single' | 'multi';
  signup: boolean;
  app: string;
  isolation: IsolationVerdict;
  isolationEvidence: SandboxIsolationEvidence | undefined;
  migrationLog: string[];
}
export type ParseResult = { ok: true; probe: VerifiedProbe } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Extracts and validates the report from the stdout of the probe run. Never trusts a field the platform can recompute. */
export function parseProbeOutput(stdout: string): ParseResult {
  const lines = stdout.split('\n').filter((l) => l.startsWith(REPORT_PREFIX));
  if (lines.length === 0) return { ok: false, reason: 'no_probe_report' };
  if (lines.length > 1) return { ok: false, reason: 'more_than_one_probe_report' }; // a second line could be an attempt to override the first
  const raw = (lines[0] as string).slice(REPORT_PREFIX.length);
  if (raw.length > MAX_REPORT_BYTES) return { ok: false, reason: 'report_too_large' };
  if (scanForSecrets(raw).length > 0) return { ok: false, reason: 'report_contains_secret' };
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'report_not_json' };
  }
  if (!isRecord(j) || !isRecord(j['report'])) return { ok: false, reason: 'report_shape' };
  const r = j['report'];
  if (r['schema'] !== 'nuzm.app-probe/1')
    return { ok: false, reason: r['fatal'] !== undefined ? 'probe_fatal' : 'report_schema' };
  if (!Array.isArray(r['checks']) || r['checks'].length === 0 || r['checks'].length > 100)
    return { ok: false, reason: 'report_checks' };
  const checks: ParsedCheck[] = [];
  const seen = new Set<string>();
  for (const c of r['checks']) {
    if (
      !isRecord(c) ||
      typeof c['id'] !== 'string' ||
      !/^[a-z][a-z0-9-]{0,40}$/.test(c['id']) ||
      seen.has(c['id'])
    )
      return { ok: false, reason: 'report_check_id' };
    if (typeof c['status'] !== 'string' || !CHECK_STATUS.has(c['status']))
      return { ok: false, reason: 'report_check_status' };
    if (typeof c['title'] !== 'string' || typeof c['detail'] !== 'string')
      return { ok: false, reason: 'report_check_text' };
    seen.add(c['id']);
    checks.push({
      id: c['id'],
      title: c['title'].slice(0, 200),
      status: c['status'] as ParsedCheck['status'],
      detail: c['detail'].slice(0, 300),
      ms: typeof c['ms'] === 'number' ? c['ms'] : 0,
    });
  }
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const requiredNotPassed = REQUIRED_CHECKS.filter(
    (id) => checks.find((c) => c.id === id)?.status !== 'pass',
  );
  const iso = isRecord(j['isolation']) ? (j['isolation'] as SandboxIsolationEvidence) : undefined;
  const tenancy = r['tenancy'] === 'multi' ? 'multi' : 'single';
  return {
    ok: true,
    probe: {
      checks,
      passed,
      failed,
      skipped,
      requiredNotPassed: [...requiredNotPassed],
      ok: failed === 0 && requiredNotPassed.length === 0,
      tenancy,
      signup: r['signup'] === true,
      app: typeof r['app'] === 'string' ? r['app'].slice(0, 60) : '',
      isolation: verifySandboxIsolation(iso, { multiTenant: tenancy === 'multi' }),
      isolationEvidence: iso,
      migrationLog: Array.isArray(j['migrationLog'])
        ? (j['migrationLog'] as unknown[])
            .filter((x): x is string => typeof x === 'string')
            .slice(0, 20)
            .map((x) => x.slice(0, 120))
        : [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------- runtime port
export interface ProbeRuntimeResult {
  /** `MOCK` = a stand-in (simulated runtime or fixture); `REAL` = a qualified, attested node */
  origin: 'MOCK' | 'REAL';
  label: 'SIMULATED' | 'LIVE';
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** the verified attestation of the node that ran it (real runs only) */
  attestationId?: string;
  nodeId?: string;
}
export interface ProbeRuntimePort {
  run(files: ReadonlyMap<string, string>): Promise<ProbeRuntimeResult>;
}
/**
 * The SIMULATED runtime: the existing `runInRuntime` entry in `simulated` mode (policy, workspace seeding and secret screening of the real gateway; nothing is executed). `stdout` lets a test script what the
 * stand-in node prints; by default it prints a placeholder, so the harness reports NOT VERIFIED rather than a pass.
 */
export function simulatedProbeRuntime(
  o: { stdout?: string; exitCode?: number; endpoint?: string } = {},
): ProbeRuntimePort {
  return {
    async run(files) {
      const endpoint = o.endpoint ?? 'simulated:p3-s05';
      const r = await runInRuntime({
        mode: 'simulated',
        endpoint,
        profile: PROBE_PROFILE.profile,
        params: { ...PROBE_PROFILE.params },
        files,
        approvalId: 'simulated-approval',
        projectScripts: ['probe'],
        ...(o.stdout !== undefined || o.exitCode !== undefined
          ? {
              connect: async (ep: string) => {
                const rt = new eg.SimulatedWorkspaceRuntime({
                  nodeId: 'p3-s05',
                  endpointId: `simulated-${ep.slice(10)}`,
                  runtimeClass: 'gvisor-runsc',
                  imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
                });
                rt.setScript(() => ({ exitCode: o.exitCode ?? 0, stdout: o.stdout ?? '' }));
                return rt;
              },
            }
          : {}),
      });
      return {
        origin: r.origin,
        label: r.label,
        status: r.outcome.status,
        exitCode: r.outcome.exitCode,
        stdout: r.outcome.stdout,
        stderr: r.outcome.stderr,
        durationMs: r.outcome.durationMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------- evidence
export type EvidenceLabel = 'LIVE-VERIFIED' | 'SIMULATED' | 'NOT VERIFIED';
export interface ProbeEvidence {
  schema: 'nuzm.evidence.fullstack-probe/1';
  id: string;
  createdAt: string;
  /** decided by the platform from the runtime's origin and the verified report; never copied from the report */
  label: EvidenceLabel;
  verdict: 'PASS' | 'FAIL' | 'NOT VERIFIED';
  reasons: string[];
  components: { scaffold: string; toolchain: Record<string, string>; probeSchema: string };
  runtime: {
    origin: 'MOCK' | 'REAL' | 'NONE';
    label: string;
    profile: string;
    nodeId: string | null;
    attestationId: string | null;
    status: string | null;
    exitCode: number | null;
  };
  approvals: Record<string, string>;
  inputs: {
    specHash: string;
    filesDigest: string;
    platformFilesDigest: string;
    options: { tenancy: string; signupRole: string | null };
  };
  outputs: { reportDigest: string | null };
  result: {
    checks: { id: string; status: string }[];
    passed: number;
    failed: number;
    skipped: number;
    requiredNotPassed: string[];
    isolation: IsolationVerdict | null;
  };
  gates: { ok: boolean; blockers: number; warnings: number };
  durationMs: number;
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface ProbeInput {
  spec: AppSpec;
  options?: FullStackOptions;
  /** a project that was changed after generation (the repair loop's current files); default: the pristine generated project */
  files?: ReadonlyMap<string, string>;
  runtime: ProbeRuntimePort;
  stage?: 'generated' | 'locked';
  approvals?: Record<string, string>;
  now?: () => Date;
  id?: string;
}
export interface ProbeOutcome {
  /** where the pipeline stopped */
  stage: 'static_gates' | 'runtime' | 'report' | 'verdict';
  gates: GateReport;
  probe: VerifiedProbe | null;
  evidence: ProbeEvidence;
}

export async function probeGeneratedApp(i: ProbeInput): Promise<ProbeOutcome> {
  const now = i.now ?? (() => new Date());
  const t0 = now().getTime();
  const project = generateProject(i.spec, i.options ?? {});
  const files = i.files ?? project.files;
  const platform = platformFileHashes(runtimeFiles());
  const gates = runStaticGates(files, { platformFiles: platform, stage: i.stage ?? 'generated' });
  const auth = {
    tenancy: i.options?.tenancy ?? 'single',
    signupRole: (i.options?.signupRole ?? null) as string | null,
  };
  const base = (): Omit<
    ProbeEvidence,
    'label' | 'verdict' | 'reasons' | 'runtime' | 'outputs' | 'result' | 'durationMs'
  > => ({
    schema: 'nuzm.evidence.fullstack-probe/1',
    id: i.id ?? `fsp-${sha(gates.inputDigest + t0).slice(0, 16)}`,
    createdAt: now().toISOString(),
    components: {
      scaffold: SCAFFOLD_VERSION,
      toolchain: { node: '>=22.15', typescript: '~5.9.3', pg: '^8.13.0' },
      probeSchema: 'nuzm.app-probe/1',
    },
    approvals: i.approvals ?? {},
    inputs: {
      specHash: project.specHash,
      filesDigest: gates.inputDigest,
      platformFilesDigest: sha(JSON.stringify(platform)),
      options: auth,
    },
    gates: {
      ok: gates.ok,
      blockers: gates.findings.filter((f) => f.severity === 'blocker').length,
      warnings: gates.findings.filter((f) => f.severity === 'warning').length,
    },
  });
  const finish = (
    stage: ProbeOutcome['stage'],
    ev: Omit<ProbeEvidence, keyof ReturnType<typeof base> | 'durationMs'>,
    probe: VerifiedProbe | null,
  ): ProbeOutcome => ({
    stage,
    gates,
    probe,
    evidence: { ...base(), ...ev, durationMs: now().getTime() - t0 },
  });
  const empty = {
    checks: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    requiredNotPassed: [...REQUIRED_CHECKS],
    isolation: null,
  };

  if (!gates.ok)
    return finish(
      'static_gates',
      {
        label: 'NOT VERIFIED',
        verdict: 'FAIL',
        reasons: [
          'static_gates_failed',
          ...new Set(
            gates.findings
              .filter((f) => f.severity === 'blocker')
              .map((f) => `${f.gate}:${f.rule}`),
          ),
        ],
        runtime: {
          origin: 'NONE',
          label: 'not run',
          profile: PROBE_PROFILE.profile,
          nodeId: null,
          attestationId: null,
          status: null,
          exitCode: null,
        },
        outputs: { reportDigest: null },
        result: empty,
      },
      null,
    );

  let run: ProbeRuntimeResult;
  try {
    run = await i.runtime.run(workspaceSeed(files));
  } catch (e) {
    return finish(
      'runtime',
      {
        label: 'NOT VERIFIED',
        verdict: 'NOT VERIFIED',
        reasons: ['runtime_refused:' + (e instanceof Error ? e.message.slice(0, 120) : 'error')],
        runtime: {
          origin: 'NONE',
          label: 'refused',
          profile: PROBE_PROFILE.profile,
          nodeId: null,
          attestationId: null,
          status: null,
          exitCode: null,
        },
        outputs: { reportDigest: null },
        result: empty,
      },
      null,
    );
  }
  const rt: ProbeEvidence['runtime'] = {
    origin: run.origin,
    label: run.label,
    profile: PROBE_PROFILE.profile,
    nodeId: run.nodeId ?? null,
    attestationId: run.attestationId ?? null,
    status: run.status,
    exitCode: run.exitCode,
  };
  const parsed = parseProbeOutput(run.stdout);
  if (!parsed.ok) {
    // a simulated node prints a placeholder: that is "not verified", not a failure of the app
    const simulatedPlaceholder = run.origin === 'MOCK' && parsed.reason === 'no_probe_report';
    return finish(
      'report',
      {
        label: simulatedPlaceholder ? 'SIMULATED' : 'NOT VERIFIED',
        verdict: simulatedPlaceholder || run.status !== 'completed' ? 'NOT VERIFIED' : 'FAIL',
        reasons: [
          parsed.reason,
          ...(simulatedPlaceholder ? ['simulated_runtime_output_is_a_placeholder'] : []),
          ...(run.status !== 'completed' ? ['runtime_status:' + run.status] : []),
        ],
        runtime: rt,
        outputs: { reportDigest: null },
        result: empty,
      },
      null,
    );
  }
  const p = parsed.probe;
  const reasons: string[] = [];
  if (!p.ok)
    reasons.push(
      ...p.requiredNotPassed.map((c) => 'required_not_passed:' + c),
      ...p.checks.filter((c) => c.status === 'fail').map((c) => 'failed:' + c.id),
    );
  if (!p.isolation.ok)
    reasons.push(...p.isolation.checks.filter((c) => !c.ok).map((c) => 'isolation:' + c.id));
  if (run.exitCode !== 0) reasons.push('probe_exit_code:' + String(run.exitCode));
  if (p.app !== i.spec.slug) reasons.push('report_for_another_app');
  const pass = reasons.length === 0;
  // the label is decided here: only a REAL, attested run can be LIVE-VERIFIED, and only when the whole verdict passes
  const live = run.origin === 'REAL' && run.label === 'LIVE' && !!run.attestationId;
  const label: EvidenceLabel =
    run.origin === 'MOCK' ? 'SIMULATED' : live && pass ? 'LIVE-VERIFIED' : 'NOT VERIFIED';
  return finish(
    'verdict',
    {
      label,
      verdict: pass ? 'PASS' : 'FAIL',
      reasons: run.origin === 'MOCK' ? [...reasons, 'origin_mock_not_live_evidence'] : reasons,
      runtime: rt,
      outputs: { reportDigest: sha(JSON.stringify(p.checks.map((c) => [c.id, c.status]))) },
      result: {
        checks: p.checks.map((c) => ({ id: c.id, status: c.status })),
        passed: p.passed,
        failed: p.failed,
        skipped: p.skipped,
        requiredNotPassed: p.requiredNotPassed,
        isolation: p.isolation,
      },
    },
    p,
  );
}
