import { createHash } from 'node:crypto';
import {
  runQualification as runProviderTrack,
  tokenCostNano,
  trackWorstCase,
  twinTarget,
  type LiveSuiteApproval,
  type QualificationTrack,
} from '@nuzm/adapter-model';
// QA drives these internals directly, as the other QA suites do; they are not part of the modules' public surface
// eslint-disable-next-line no-restricted-imports -- the lifecycle runner and its in-memory ports are internal to the app builder module
import { runQualification as runLifecycleProjects } from '../../modules/appbuilder/internal/lifecycle/qualification';
// eslint-disable-next-line no-restricted-imports -- the escape-suite runner is internal to the sandbox module
import { runQualification as runEscapeSuite } from '../../modules/appbuilder/internal/sandbox/escape-runner';
// eslint-disable-next-line no-restricted-imports -- the staging rehearsal is internal to the deploy module
import { runStagingRehearsal } from '../../modules/deploy/internal/rehearsal';
import type { Scenario } from './scenarios';

/**
 * P3-S08 harness drivers. A driver runs ONE scenario and returns what happened as plain data; the runner turns that into an evidence record, labels it, seals it and verifies it.
 * `SIMULATED_DRIVERS` call the offline entry points that exist today (twins, in-memory ports, simulated nodes): their output is SIMULATED by construction, whatever it says.
 * `LIVE_DRIVERS` is empty on purpose: a live driver is added here only when the owning session's real entry point has landed AND the matching approvals are recorded;
 * until then the runner stops with the blocker. Neither kind may read a secret, call a provider or execute generated code on this machine in this repository state.
 */
export interface DriverOutput {
  result: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  checks: { id: string; result: 'PASS' | 'FAIL' | 'NOT_VERIFIED'; detail?: string }[];
  components: { name: string; version: string; origin: 'simulated' | 'offline' | 'real' }[];
  details: Record<string, unknown>;
  outputs?: { name: string; sha256: string; bytes?: number }[];
  inputs?: { name: string; sha256: string }[];
  /** USD micro-units actually used (live) */
  usedMicroUsd?: number;
  /** why it is NOT_VERIFIED (planned only) */
  blockers?: { id: string; text: string }[];
  identity?: Record<string, Record<string, string>>;
  durationMs?: number;
}
export interface Driver {
  run(scenario: Scenario): Promise<DriverOutput>;
}
export type DriverMap = Record<string, Driver>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Phase 2 lifecycle projects are run once and shared by the five S0x scenarios */
let lifecycleCache: Promise<Awaited<ReturnType<typeof runLifecycleProjects>>> | null = null;
const lifecycle = () => (lifecycleCache ??= runLifecycleProjects());
const BRIEF_OF: Record<string, string> = {
  'S01-synthetic-business-website': 'business-website',
  'S02-synthetic-ecommerce': 'ecommerce-frontend',
  'S03-synthetic-fullstack': 'full-stack-app',
  'S04-synthetic-crm': 'erp-crm-module',
  'S05-synthetic-flutter': 'flutter-app',
};
const lifecycleDriver: Driver = {
  async run(s) {
    const runs = await lifecycle();
    const r = runs.find((x) => x.brief.id === BRIEF_OF[s.id]);
    if (!r)
      return {
        result: 'FAIL',
        checks: [{ id: 'brief-found', result: 'FAIL' }],
        components: [],
        details: {},
      };
    const reached = r.status === 'waiting_approval';
    return {
      result: reached ? 'PASS' : 'FAIL',
      checks: [
        {
          id: 'reaches-deployment-approval-request',
          result: reached ? 'PASS' : 'FAIL',
          detail: r.status,
        },
        {
          id: 'deployment-not-performed',
          result: r.row.approval.includes('not decided') ? 'PASS' : 'FAIL',
        },
      ],
      components: [
        { name: 'lifecycle-runner', version: 'phase2', origin: 'offline' },
        { name: 'execution-gateway-mock-port', version: 'phase2', origin: 'simulated' },
        { name: 'placeholder-model (absent)', version: 'n/a', origin: 'simulated' },
      ],
      details: {
        briefId: r.brief.id,
        productType: r.row.productType,
        stack: r.row.stack,
        tasks: r.row.tasks,
        files: r.row.files,
        status: r.status,
        executions: r.row.executions,
      },
      inputs: [{ name: 'brief', sha256: sha(r.brief.prompt) }],
      outputs: [{ name: 'qualification-row', sha256: sha(JSON.stringify(r.row)) }],
    };
  },
};

const trackTwin = (track: QualificationTrack): Driver => ({
  async run() {
    const { target } = twinTarget();
    const w = trackWorstCase(track);
    const approval: LiveSuiteApproval = {
      ref: 'twin-synthetic',
      approvedBy: 'twin',
      environment: 'non-production',
      maxRequests: w.requests,
      maxTotalTokens: w.totalTokens,
      maxCostNano: tokenCostNano(w.inputTokens, w.outputTokens, target.adapter.pricing).toString(),
    };
    const e = await runProviderTrack(track, target, approval, {});
    const checks = e.checks.map((c) => ({
      id: c.id,
      result: (!c.ran ? 'NOT_VERIFIED' : c.ok ? 'PASS' : 'FAIL') as
        'PASS' | 'FAIL' | 'NOT_VERIFIED',
    }));
    return {
      result: checks.some((c) => c.result === 'FAIL')
        ? 'FAIL'
        : checks.every((c) => c.result === 'PASS')
          ? 'PASS'
          : 'NOT_VERIFIED',
      checks,
      components: [{ name: 'mock-live-twin', version: e.contractVersion, origin: 'simulated' }],
      details: {
        track,
        totals: e.totals,
        note: 'mock twin: proves the harness and the evidence format, says nothing about any provider',
      },
      outputs: [{ name: 'native-evidence', sha256: sha(JSON.stringify(e)) }],
    };
  },
});

const escapeDriver: Driver = {
  async run() {
    const rep = await runEscapeSuite({ mode: 'simulated', endpoint: 'simulated:harness-node' });
    return {
      result: rep.totals.fail === 0 ? 'PASS' : 'FAIL',
      checks: [
        { id: 'control-plane-attempts-no-fail', result: rep.totals.fail === 0 ? 'PASS' : 'FAIL' },
        {
          id: 'isolating-attempts-verified',
          result: 'NOT_VERIFIED',
          detail: `${rep.totals.notVerified} isolating attempts cannot be verified on a simulated node`,
        },
      ],
      components: [
        { name: 'simulated-workspace-runtime', version: rep.suiteVersion, origin: 'simulated' },
      ],
      details: {
        suiteVersion: rep.suiteVersion,
        totals: rep.totals,
        eligibleForReview: rep.eligibleForReview,
      },
      outputs: [{ name: 'suite-report', sha256: rep.reportSha256 }],
    };
  },
};

const rehearsalDriver: Driver = {
  async run() {
    const r = await runStagingRehearsal({ mode: 'simulated' });
    return {
      result: r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'NOT_VERIFIED',
      checks: r.steps.map((s) => ({
        id: s.id,
        result:
          s.status === 'PASS'
            ? ('PASS' as const)
            : s.status === 'FAIL'
              ? ('FAIL' as const)
              : ('NOT_VERIFIED' as const),
      })),
      components: [
        { name: 'staging-rehearsal', version: 'phase2', origin: 'simulated' },
        { name: 'in-memory-publisher', version: 'phase2', origin: 'simulated' },
      ],
      details: { appHash: r.appHash, steps: r.steps.length, conclusion: r.conclusion },
      outputs: [{ name: 'rehearsal-report', sha256: sha(JSON.stringify(r)) }],
    };
  },
};

/** scenarios with no offline entry point yet: planned only, honestly NOT_VERIFIED */
const planned = (owner: string): Driver => ({
  async run(s) {
    return {
      result: 'NOT_VERIFIED',
      checks: [
        {
          id: 'entry-point-registered',
          result: 'NOT_VERIFIED',
          detail: `${owner} entry point not wired into the harness`,
        },
      ],
      components: [{ name: `${owner}-entry-point`, version: 'unregistered', origin: 'offline' }],
      details: { planned: true, entry: s.entry },
      blockers: [
        {
          id: 'entry-not-wired',
          text: `${owner}: no offline or real entry point is registered for ${s.id} yet (${s.entry}); nothing was run.`,
        },
      ],
    };
  },
});

export const SIMULATED_DRIVERS: DriverMap = {
  'P01-provider-connection': trackTwin('A'),
  'P02-tool-calling': trackTwin('B'),
  'P03-codegen': trackTwin('C'),
  'R01-runtime-isolation': escapeDriver,
  'D00-real-preview': planned('P3-S07'),
  'D01-preview-deploy-rollback': rehearsalDriver,
  'S01-synthetic-business-website': lifecycleDriver,
  'S02-synthetic-ecommerce': lifecycleDriver,
  'S03-synthetic-fullstack': lifecycleDriver,
  'S04-synthetic-crm': lifecycleDriver,
  'S05-synthetic-flutter': lifecycleDriver,
  'B01-build-repair': planned('P3-S03'),
  'W01-website': planned('P3-S04'),
  'F01-fullstack': planned('P3-S05'),
  'M01-android-apk': planned('P3-S06'),
  'M02-ios-build': planned('P3-S06'),
  'H01-benchmark-stage-a': planned('P3-S08'),
  'Q01-credential-leak-scan': planned('P3-S08'),
  'Q02-ledger-reconciliation': planned('P3-S08'),
};

/** Real drivers. EMPTY until the owning session's real entry point exists and the approvals are recorded; see docs/phase3/sessions/REPORT-P3-S08.md. */
export const LIVE_DRIVERS: DriverMap = {};
