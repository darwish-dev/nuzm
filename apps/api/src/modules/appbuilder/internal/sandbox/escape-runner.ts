import { createHash } from 'node:crypto';
import { executionGateway as eg } from '@nuzm/domain';
import { CanaryRegistry, MemorySecurityAlerts } from './canary';
import { DEFAULT_ALLOW, EgressPolicy } from './egress';
import { EndpointSandboxRuntime } from './endpoint-runtime';
import { runEscapeSuite, SUITE_VERSION, type SuiteReport } from './escape-suite';
import { checkPath, scanSecrets } from './paths';

/**
 * S-AG6 PHASE 2 (OFFLINE): the ESCAPE-SUITE QUALIFICATION RUNNER. It runs suite 1.1.0 against a runtime endpoint and reports PASS/FAIL per case:
 *   control-plane attempts  -> run for real in this process (egress policy, confinement, secret checks, gateway policy, ...): PASS = BLOCKED, FAIL = ESCAPED
 *   isolating attempts      -> sent to the node, but ONLY in a live qualification (below); otherwise NOT_VERIFIED
 *
 * Modes:
 *   `simulated`  the endpoint is a `SimulatedWorkspaceRuntime` (`simulated:<node>`). Every isolating attempt is NOT_VERIFIED. The result is labelled SIMULATED. This is the only mode
 *                that can run in this repository today.
 *   `qualify`    first qualification of a staging node: needs a node declaration, an approval reference (HG-10-02 or D-21) in the call AND `NUZM_QUALIFICATION_APPROVED=<same ref>` in
 *                the environment, a staging node, and a node client (none exists yet: D-21). Output: the suite report and a DRAFT attestation for the human reviewer.
 *   `requalify`  periodic re-run on an already attested node: the attestation must verify in live mode first (fail-closed), then the suite runs, and the new numbers must not be
 *                worse than the attestation's.
 * The runner never produces a verified attestation and never talks to a non-simulated endpoint in this repository (`endpoint_client_unavailable`).
 */
export type QualificationMode = 'simulated' | 'qualify' | 'requalify';
export interface QualificationInput {
  mode: QualificationMode;
  /** `simulated:<nodeId>` today; an `https://` endpoint needs the node client (blocked on D-21) */
  endpoint: string;
  declaration?: eg.NodeDeclaration;
  attestation?: unknown;
  trust?: eg.TrustedKeys;
  approvalRef?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** injected node factory (tests, and the future HTTPS client) */
  connect?: (endpoint: string) => Promise<eg.WorkspaceRuntime | null>;
}
export interface CaseLine {
  id: string;
  category: string;
  requires: 'control-plane' | 'isolating-runtime';
  verdict: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  note: string;
}
export interface QualificationReport {
  suiteVersion: string;
  mode: QualificationMode;
  endpoint: string;
  label: 'SIMULATED' | 'NOT VERIFIED' | 'LIVE-VERIFIED';
  totals: {
    total: number;
    pass: number;
    fail: number;
    notVerified: number;
    isolatingAttempts: number;
    isolatingPass: number;
  };
  /** the suite report digest the attestation points at */
  reportSha256: string;
  lines: CaseLine[];
  /** a draft for the reviewer (live qualification only) */
  draftAttestation: eg.DraftAttestation | null;
  /** true only for a live qualification where every isolating attempt passed and nothing escaped; still NOT a verdict: the human review (HG-10-02) decides */
  eligibleForReview: boolean;
  problems: string[];
  /** non-blocking remarks (e.g. attempts that need the database and are covered by the integration spec) */
  notes: string[];
}
export class QualificationRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`qualification refused: ${reasons.join(',')}`);
    this.name = 'QualificationRefused';
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function defaultConnect(endpoint: string): Promise<eg.WorkspaceRuntime | null> {
  const m = /^simulated:([a-z0-9-]{1,40})$/.exec(endpoint);
  if (!m) return null;
  return new eg.SimulatedWorkspaceRuntime({
    nodeId: m[1]!,
    endpointId: `simulated-${m[1]}`,
    runtimeClass: 'gvisor-runsc',
    imageDigests: [eg.SIMULATED_IMAGE_DIGEST],
  });
}

export async function runQualification(input: QualificationInput): Promise<QualificationReport> {
  const now = input.now ?? (() => Date.now());
  const env = input.env ?? {};
  const refuse: string[] = [];
  const connect = input.connect ?? defaultConnect;
  const live = input.mode !== 'simulated';

  if (live) {
    if (!input.approvalRef || !/^(HG-10-02|D-21)/.test(input.approvalRef))
      refuse.push('approval_reference_missing');
    else if (env.NUZM_QUALIFICATION_APPROVED !== input.approvalRef)
      refuse.push('approval_not_confirmed_in_environment');
    if (/^simulated:/.test(input.endpoint))
      refuse.push('simulated_endpoint_cannot_be_live_qualification');
    if (!input.declaration && input.mode === 'qualify') refuse.push('node_declaration_missing');
    if (input.declaration && input.declaration.node.environment !== 'staging')
      refuse.push('node_not_staging');
    if (input.mode === 'requalify') {
      if (!input.declaration) refuse.push('node_declaration_missing');
      else {
        const v = eg.verifyAttestation(
          input.attestation,
          {
            nodeId: input.declaration.node.nodeId,
            endpointId: input.declaration.node.endpointId,
            mode: 'live',
            environments: ['staging'],
            minSuiteVersion: SUITE_VERSION,
            minIsolatingAttempts: eg.DEFAULT_MIN_ISOLATING_ATTEMPTS,
            maxValidityDays: 90,
            now: new Date(now()),
          },
          input.trust ?? {},
        );
        if (!v.ok) refuse.push(...v.reasons.map((r) => `attestation:${r}`));
      }
    }
  } else if (!/^simulated:/.test(input.endpoint))
    refuse.push('only_simulated_endpoints_in_simulated_mode');
  if (refuse.length > 0) throw new QualificationRefused(refuse);

  const node = await connect(input.endpoint);
  if (!node) throw new QualificationRefused(['endpoint_client_unavailable']);
  const ident = await node.identity();
  if (
    live &&
    input.declaration &&
    (ident.nodeId !== input.declaration.node.nodeId ||
      ident.endpointId !== input.declaration.node.endpointId)
  )
    throw new QualificationRefused(['node_identity_mismatch']);

  // the suite is the verification in a live qualification: only then does the adapter present the node as `verified` to the suite's isolating attempts
  const rt = new EndpointSandboxRuntime(
    node,
    live ? 'verified' : 'simulated',
    ident.imageDigests[0] ?? eg.SIMULATED_IMAGE_DIGEST,
    ident.runtimeClass,
    now,
  );
  const egress = new EgressPolicy(DEFAULT_ALLOW, async (h) => {
    const m: Record<string, string[]> = {
      'npm-mirror.nuzm.internal': ['93.184.216.10'],
      'git.nuzm.internal': ['93.184.216.11'],
    };
    if (!m[h]) throw new Error('NXDOMAIN');
    return m[h]!;
  });
  const handle = await rt.create({
    sandboxId: `qual-${sha(String(now())).slice(0, 12)}`,
    orgId: 'org-qualification',
    projectId: 'project-qualification',
    quota: { vcpu: 1, memoryMb: 1024, diskGb: 1, pids: 64, buildTimeoutMinutes: 5 },
    egressProfile: 'standard',
  });
  let report: SuiteReport;
  try {
    report = await runEscapeSuite({
      egress,
      runtime: rt,
      canaries: new CanaryRegistry(new MemorySecurityAlerts()),
      handle,
      tickets: null,
      writeThroughChanges: async (p, c) => checkPath(p) === null && scanSecrets(c).length === 0,
    });
  } finally {
    await rt.destroy(handle).catch(() => undefined);
  }
  return buildReport(input, report, ident, now);
}

function buildReport(
  input: QualificationInput,
  report: SuiteReport,
  ident: eg.RuntimeIdentity,
  now: () => number,
): QualificationReport {
  const lines: CaseLine[] = report.results.map((r) => ({
    id: r.id,
    category: r.category,
    requires: r.requires,
    verdict: r.status === 'BLOCKED' ? 'PASS' : r.status === 'ESCAPED' ? 'FAIL' : 'NOT_VERIFIED',
    note: r.note,
  }));
  const iso = lines.filter((l) => l.requires === 'isolating-runtime');
  const totals = {
    total: lines.length,
    pass: lines.filter((l) => l.verdict === 'PASS').length,
    fail: lines.filter((l) => l.verdict === 'FAIL').length,
    notVerified: lines.filter((l) => l.verdict === 'NOT_VERIFIED').length,
    isolatingAttempts: iso.length,
    isolatingPass: iso.filter((l) => l.verdict === 'PASS').length,
  };
  const live = input.mode !== 'simulated';
  const reportSha256 = sha(
    eg.canonicalJson({
      suite: SUITE_VERSION,
      node: ident.nodeId,
      lines: lines.map((l) => [l.id, l.verdict]),
    }),
  );
  const problems: string[] = [];
  if (totals.fail > 0) problems.push(`${totals.fail} attempt(s) ESCAPED`);
  if (live && totals.isolatingPass !== totals.isolatingAttempts)
    problems.push('not every isolating attempt passed');
  const isoNotVerified = iso.filter((l) => l.verdict === 'NOT_VERIFIED').length;
  const cpNotVerified = totals.notVerified - isoNotVerified;
  const notes =
    cpNotVerified > 0
      ? [
          `${cpNotVerified} control-plane attempt(s) NOT_VERIFIED here (they need the database; sandbox.int.spec.ts runs them)`,
        ]
      : [];
  const eligible = live && problems.length === 0 && isoNotVerified === 0;
  let draft: eg.DraftAttestation | null = null;
  if (live && input.declaration)
    draft = eg.buildDraftAttestation(
      input.declaration,
      {
        version: SUITE_VERSION,
        reportSha256,
        isolatingAttempts: totals.isolatingAttempts,
        blocked: totals.isolatingPass,
        escaped: totals.fail,
        notVerified: isoNotVerified,
      },
      new Date(now()),
    );
  return {
    suiteVersion: SUITE_VERSION,
    mode: input.mode,
    endpoint: input.endpoint,
    label: live ? 'NOT VERIFIED' : 'SIMULATED',
    totals,
    reportSha256,
    lines,
    draftAttestation: draft,
    eligibleForReview: eligible,
    problems,
    notes,
  };
}

/** plain-text rendering of the report (one line per case) */
export function renderReport(r: QualificationReport): string {
  const out = [
    `escape suite ${r.suiteVersion} | mode=${r.mode} | endpoint=${r.endpoint} | evidence=${r.label}`,
    `cases=${r.totals.total} PASS=${r.totals.pass} FAIL=${r.totals.fail} NOT_VERIFIED=${r.totals.notVerified} (isolating ${r.totals.isolatingPass}/${r.totals.isolatingAttempts} pass)`,
    ...r.lines.map((l) => `${l.verdict.padEnd(12)} ${l.id.padEnd(14)} [${l.requires}] ${l.note}`),
    r.label === 'SIMULATED'
      ? 'SIMULATED: nothing was isolated or executed; isolating attempts are NOT_VERIFIED and are not evidence.'
      : `eligible for human review (HG-10-02): ${r.eligibleForReview ? 'yes' : 'no'}${r.problems.length ? ` | ${r.problems.join('; ')}` : ''}`,
    ...r.notes.map((n) => `note: ${n}`),
    `report sha256: ${r.reportSha256}`,
  ];
  return out.join('\n');
}
