import { CATEGORY_PASS_FLOOR, THRESHOLDS_VERSION, detectRegressions, evaluateThresholds, PROPOSED_THRESHOLDS, type Regression, type Threshold, type ThresholdResult } from './thresholds';
import { MIN_TASKS_PER_CATEGORY, type TaskCategory } from './categories';
import type { BenchmarkReport } from './report';
import { DATASET_VERSION } from './registry';
import type { HumanAcceptanceResult } from './review';

/**
 * The model rollout gate (the strict successor of `rolloutDecision`). It FAILS CLOSED: every check below must pass, an absent input is a failure, and nothing is inferred. It never
 * allows a rollout on REFERENCE, MOCK, mixed or absent evidence, on thresholds the owner has not accepted (by version), on a dataset other than the current one, with a missing
 * baseline, a regression, an unmeasured or failing metric, a category below the floor, an unmeasured human acceptance, or a missing security review.
 */
export interface ThresholdAcceptance {
  /** must equal THRESHOLDS_VERSION: an acceptance of an older list does not cover a newer one */
  version: string;
  acceptedBy: string;
  acceptedAt: string;
  /** the owner explicitly accepts a first run without a baseline to compare against */
  noBaselineAllowed?: boolean;
}
export interface SecurityReviewRecord {
  ref: string;
  reviewedBy: string;
  completedAt: string;
  passed: boolean;
}
export interface GateInput {
  report: BenchmarkReport;
  baseline: BenchmarkReport | null;
  acceptance: ThresholdAcceptance | null;
  humanReview: HumanAcceptanceResult | null;
  securityReview: SecurityReviewRecord | null;
  thresholds?: readonly Threshold[];
  currentDatasetVersion?: string;
}
export interface GateCheck {
  id: string;
  ok: boolean;
  detail: string;
}
export interface GateDecision {
  allowed: boolean;
  status: 'PASS' | 'BLOCKED' | 'NOT VERIFIED';
  checks: GateCheck[];
  failedThresholds: ThresholdResult[];
  regressions: Regression[];
  reasons: string[];
}

export function evaluateRolloutGate(input: GateInput): GateDecision {
  const { report } = input;
  const thresholds = input.thresholds ?? PROPOSED_THRESHOLDS;
  const dataset = input.currentDatasetVersion ?? DATASET_VERSION;
  const checks: GateCheck[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail: ok ? 'ok' : detail });

  const a = input.acceptance;
  check('thresholds-accepted', !!a && a.version === THRESHOLDS_VERSION && a.acceptedBy.trim() !== '' && a.acceptedAt.trim() !== '', `thresholds ${THRESHOLDS_VERSION} are PROPOSED: no owner acceptance of exactly this version`);
  check('evidence-recorded', report.evidence.label === 'OFFLINE_REPLAY_OF_RECORDED_RUN' && report.origins.length === 1 && report.origins[0] === 'RECORDED', `evidence is ${report.evidence.label}, not a replay of a recorded verified-provider run`);
  check('dataset-current', report.datasetVersion === dataset, `report is for dataset ${report.datasetVersion}, the current one is ${dataset}`);
  check('all-tasks-scored', report.missingRecordings.length === 0 && report.rejectedRecordings.length === 0 && report.tasks > 0, `${report.missingRecordings.length} task(s) without a recording, ${report.rejectedRecordings.length} rejected`);
  const results = evaluateThresholds(report, thresholds);
  const failed = results.filter((r) => r.status !== 'PASS');
  check('thresholds-pass', failed.length === 0, failed.map((r) => `${r.id} ${r.scope}.${r.metric} ${r.op} ${r.value}: ${r.status}`).join('; '));
  const weak = (Object.entries(report.byCategory) as [TaskCategory, NonNullable<BenchmarkReport['byCategory'][TaskCategory]>][]).filter(([, s]) => s.passRate < CATEGORY_PASS_FLOOR.value || s.tasks < MIN_TASKS_PER_CATEGORY);
  check('category-floor', weak.length === 0 && Object.keys(report.byCategory).length > 0, `categories below the floor or too small: ${weak.map(([c, s]) => `${c} (${s.passRate}, ${s.tasks} tasks)`).join(', ') || 'none measured'}`);
  let regs: Regression[] = [];
  if (input.baseline) {
    regs = detectRegressions(report, input.baseline).filter((r) => r.severity === 'BLOCKING');
    check('no-regression', regs.length === 0, regs.map((r) => r.text).join('; '));
  } else check('no-regression', a?.noBaselineAllowed === true, 'no baseline report, and the owner has not accepted a first run without one');
  const h = input.humanReview;
  check('human-acceptance', !!h && h.status === 'MEASURED' && h.meets === true, h ? `human acceptance is ${h.status}${h.rate !== null ? ` (${h.rate})` : ''}, bar ${h.bar}` : 'human acceptance not measured (no reviewers or no reviews)');
  const s = input.securityReview;
  check('security-review', !!s && s.passed && s.ref.trim() !== '' && s.reviewedBy.trim() !== '', 'agent security review not recorded as passed');

  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  const allowed = reasons.length === 0;
  const onlyUnverified = !allowed && checks.filter((c) => !c.ok).every((c) => ['thresholds-accepted', 'evidence-recorded', 'human-acceptance', 'security-review'].includes(c.id));
  return { allowed, status: allowed ? 'PASS' : onlyUnverified ? 'NOT VERIFIED' : 'BLOCKED', checks, failedThresholds: failed, regressions: regs, reasons };
}
