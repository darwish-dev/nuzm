import { TASK_KINDS, type TaskCategory } from './categories';
import type { BenchmarkReport, KindSummary } from './report';
import type { TaskKind, TaskScore } from './types';

/**
 * PROPOSED acceptance thresholds for the owner (AC-AG-10). Status is PROPOSED until the owner accepts them in writing; nothing here is a decision. They are checked against
 * a report; a regression against a stored baseline blocks rollout independently of the absolute values.
 */
export type Metric = Exclude<keyof KindSummary, 'tasks'>;
export interface Threshold {
  id: string;
  scope: TaskKind | TaskCategory | 'all';
  metric: Metric;
  op: '>=' | '<=' | '==';
  value: number;
  why: string;
}
/** `2-proposed` = the 11 original thresholds (T01-T11, unchanged) plus the Session 03 additions (T12-T20). An acceptance names this version; a change of the list means a new version and a new acceptance. */
export const THRESHOLDS_VERSION = '2-proposed';
export const ORIGINAL_THRESHOLD_IDS = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11'] as const;
export const PROPOSED_THRESHOLDS: readonly Threshold[] = [
  {
    id: 'T01',
    scope: 'all',
    metric: 'validPatchRate',
    op: '>=',
    value: 0.95,
    why: 'a proposal that cannot be applied is a wasted run and a customer-visible failure',
  },
  {
    id: 'T02',
    scope: 'all',
    metric: 'modeViolations',
    op: '==',
    value: 0,
    why: 'a path escape, sensitive file or secret in a proposal is never acceptable',
  },
  {
    id: 'T03',
    scope: 'all',
    metric: 'toolCallValidity',
    op: '>=',
    value: 0.95,
    why: 'rejected tool calls cost turns and tokens and signal a model that ignores the schemas',
  },
  {
    id: 'T04',
    scope: 'all',
    metric: 'budgetKeptRate',
    op: '>=',
    value: 0.95,
    why: 'runs must stay inside the ceilings the customer was shown',
  },
  {
    id: 'T05',
    scope: 'website',
    metric: 'passRate',
    op: '>=',
    value: 0.85,
    why: 'the most common request; small, well-bounded edits',
  },
  {
    id: 'T06',
    scope: 'webapp',
    metric: 'passRate',
    op: '>=',
    value: 0.75,
    why: 'multi-file edits are harder; a lower bar than websites',
  },
  {
    id: 'T07',
    scope: 'code-edit',
    metric: 'passRate',
    op: '>=',
    value: 0.85,
    why: 'single-file edits with a clear expected outcome',
  },
  {
    id: 'T08',
    scope: 'tool-calling',
    metric: 'passRate',
    op: '>=',
    value: 0.9,
    why: 'exploration before editing is what the agent adds over a single call',
  },
  {
    id: 'T09',
    scope: 'all',
    metric: 'meanQuality',
    op: '>=',
    value: 85,
    why: 'weighted score (checks 60, tools 15, budget 15, discipline 10)',
  },
  {
    id: 'T10',
    scope: 'all',
    metric: 'meanTokens',
    op: '<=',
    value: 30_000,
    why: 'cost per task: about 30k tokens keeps a task below one credit-bundle at the proposed rate (D6)',
  },
  {
    id: 'T11',
    scope: 'all',
    metric: 'p95LatencyMs',
    op: '<=',
    value: 90_000,
    why: 'a customer should not wait much more than a minute and a half at the 95th percentile',
  },
  {
    id: 'T12',
    scope: 'all',
    metric: 'meanSecurity',
    op: '>=',
    value: 95,
    why: 'static security findings (injection, weak crypto, hard-coded credentials, unsafe markup) in what the model changed should be rare',
  },
  {
    id: 'T13',
    scope: 'all',
    metric: 'minSecurity',
    op: '>=',
    value: 60,
    why: 'one badly insecure proposal must be visible even when the mean is high',
  },
  {
    id: 'T14',
    scope: 'all',
    metric: 'meanCodeQuality',
    op: '>=',
    value: 90,
    why: 'no any, debug leftovers, TODOs, empty catches or ignored type errors in changed code',
  },
  {
    id: 'T15',
    scope: 'all',
    metric: 'meanUiQuality',
    op: '>=',
    value: 90,
    why: 'alt text, labels, language and direction, contrast, viewport and focus handling in changed UI',
  },
  {
    id: 'T16',
    scope: 'all',
    metric: 'meanFunctional',
    op: '>=',
    value: 90,
    why: 'share of the task checks satisfied, including tasks that did not fully pass',
  },
  {
    id: 'T17',
    scope: 'all',
    metric: 'meanEfficiency',
    op: '>=',
    value: 50,
    why: 'tokens, turns and latency relative to the task budget (a lean run scores high)',
  },
  {
    id: 'T18',
    scope: 'security-remediation',
    metric: 'passRate',
    op: '>=',
    value: 0.9,
    why: 'fixing a vulnerability correctly is the one place a wrong answer is worse than none',
  },
  {
    id: 'T19',
    scope: 'arabic-rtl',
    metric: 'passRate',
    op: '>=',
    value: 0.85,
    why: 'Arabic (RTL) is the default locale of the product (D-32)',
  },
  {
    id: 'T20',
    scope: 'accessibility',
    metric: 'passRate',
    op: '>=',
    value: 0.85,
    why: 'WCAG 2.1 AA is a product target for every screen',
  },
];
/** Every measured category must reach this pass rate (PROPOSED; a floor under the per-kind bars so one weak category cannot hide in an average). */
export const CATEGORY_PASS_FLOOR = { value: 0.7, status: 'PROPOSED' as const };
/** Human acceptance (a person judges the result) cannot be measured offline: it needs named reviewers and a protocol. Proposed: at least 0.70 of reviewed runs accepted. */
export const HUMAN_ACCEPTANCE_PROPOSAL = { value: 0.7, status: 'NOT MEASURED' as const };

export interface ThresholdResult extends Threshold {
  actual: number | null;
  status: 'PASS' | 'FAIL' | 'NOT MEASURED';
}
export function evaluateThresholds(
  report: BenchmarkReport,
  thresholds: readonly Threshold[] = PROPOSED_THRESHOLDS,
): ThresholdResult[] {
  return thresholds.map((t) => {
    const src =
      t.scope === 'all'
        ? report.overall
        : (report.byKind as Record<string, KindSummary | undefined>)[t.scope] ?? (report.byCategory as Record<string, KindSummary | undefined>)[t.scope];
    if (!src || src.tasks === 0) return { ...t, actual: null, status: 'NOT MEASURED' };
    const actual = src[t.metric];
    if (actual === null) return { ...t, actual: null, status: 'NOT MEASURED' };
    const ok =
      t.op === '>=' ? actual >= t.value : t.op === '<=' ? actual <= t.value : actual === t.value;
    return { ...t, actual, status: ok ? 'PASS' : 'FAIL' };
  });
}

export interface Regression {
  scope: string;
  metric: string;
  from: number | null;
  to: number | null;
  /** BLOCKING stops a rollout; WARNING is shown but does not block */
  severity: 'BLOCKING' | 'WARNING';
  text: string;
}
/** A category has few tasks, so one task moves its pass rate by a third: its tolerance is wider than the overall one. */
export const CATEGORY_REGRESSION_TOLERANCE = 0.2;
/**
 * Regression against a stored baseline of the SAME dataset version. A different version (or hash) is not comparable and is itself blocking: the baseline must be re-recorded.
 * Blocking: a fall in a rate beyond `tolerance`, in quality beyond `tolerance x 100`, in mean security beyond 2 points or in the security floor at all, any rise in violations,
 * mean tokens up by more than 10 %, and (per category) a pass-rate fall beyond the wider category tolerance. Warnings: p95 latency up more than 25 %, efficiency down more than 5.
 */
export function detectRegressions(report: BenchmarkReport, baseline: BenchmarkReport, tolerance = 0.02): Regression[] {
  const out: Regression[] = [];
  const add = (scope: string, metric: string, from: number | null, to: number | null, severity: Regression['severity'], text: string) =>
    out.push({ scope, metric, from, to, severity, text: `${scope}: ${text}` });
  if (report.datasetVersion !== baseline.datasetVersion || report.datasetHash !== baseline.datasetHash)
    add('dataset', 'version', null, null, 'BLOCKING', `baseline is for dataset ${baseline.datasetVersion}, this report for ${report.datasetVersion}: not comparable, re-record the baseline`);
  const groups: [string, KindSummary | undefined, KindSummary | undefined, number][] = [
    ['all', report.overall, baseline.overall, tolerance],
    ...TASK_KINDS.map((k): [string, KindSummary | undefined, KindSummary | undefined, number] => [k, report.byKind[k], baseline.byKind[k], tolerance]),
    ...(Object.keys(baseline.byCategory) as TaskCategory[]).map((c): [string, KindSummary | undefined, KindSummary | undefined, number] => [
      `category ${c}`,
      report.byCategory[c],
      baseline.byCategory[c],
      CATEGORY_REGRESSION_TOLERANCE,
    ]),
  ];
  for (const [k, now, base, tol] of groups) {
    if (!base) continue;
    if (!now) {
      add(k, 'coverage', base.tasks, 0, 'BLOCKING', 'was measured in the baseline and is not measured now');
      continue;
    }
    const isCategory = k.startsWith('category ');
    const rates = isCategory ? (['passRate'] as const) : (['passRate', 'validPatchRate', 'toolCallValidity', 'budgetKeptRate'] as const);
    for (const m of rates) if (now[m] < base[m] - tol) add(k, m, base[m], now[m], 'BLOCKING', `${m} fell from ${base[m]} to ${now[m]}`);
    if (isCategory) {
      if (now.modeViolations > base.modeViolations) add(k, 'modeViolations', base.modeViolations, now.modeViolations, 'BLOCKING', `mode violations rose from ${base.modeViolations} to ${now.modeViolations}`);
      continue;
    }
    if (now.meanQuality < base.meanQuality - tol * 100) add(k, 'meanQuality', base.meanQuality, now.meanQuality, 'BLOCKING', `meanQuality fell from ${base.meanQuality} to ${now.meanQuality}`);
    if (now.modeViolations > base.modeViolations) add(k, 'modeViolations', base.modeViolations, now.modeViolations, 'BLOCKING', `mode violations rose from ${base.modeViolations} to ${now.modeViolations}`);
    if (base.meanTokens > 0 && now.meanTokens > base.meanTokens * 1.1) add(k, 'meanTokens', base.meanTokens, now.meanTokens, 'BLOCKING', `mean tokens rose from ${base.meanTokens} to ${now.meanTokens}`);
    if (base.meanSecurity !== null && now.meanSecurity !== null && now.meanSecurity < base.meanSecurity - 2)
      add(k, 'meanSecurity', base.meanSecurity, now.meanSecurity, 'BLOCKING', `meanSecurity fell from ${base.meanSecurity} to ${now.meanSecurity}`);
    if (base.minSecurity !== null && now.minSecurity !== null && now.minSecurity < base.minSecurity)
      add(k, 'minSecurity', base.minSecurity, now.minSecurity, 'BLOCKING', `the lowest security score fell from ${base.minSecurity} to ${now.minSecurity}`);
    if (base.p95LatencyMs > 0 && now.p95LatencyMs > base.p95LatencyMs * 1.25) add(k, 'p95LatencyMs', base.p95LatencyMs, now.p95LatencyMs, 'WARNING', `p95 latency rose from ${base.p95LatencyMs} to ${now.p95LatencyMs}`);
    if (now.meanEfficiency < base.meanEfficiency - 5) add(k, 'meanEfficiency', base.meanEfficiency, now.meanEfficiency, 'WARNING', `efficiency fell from ${base.meanEfficiency} to ${now.meanEfficiency}`);
  }
  return out;
}
/** Task-level regressions: tasks that passed in the baseline and fail now (same dataset version only). */
export function taskRegressions(now: readonly TaskScore[], baseline: readonly TaskScore[]): string[] {
  const was = new Map(baseline.map((s) => [s.taskId, s.passed]));
  return now.filter((s) => was.get(s.taskId) === true && !s.passed).map((s) => s.taskId).sort();
}
/** The blocking regressions as strings (the original API; warnings are not included). */
export function regressions(report: BenchmarkReport, baseline: BenchmarkReport, tolerance = 0.02): string[] {
  return detectRegressions(report, baseline, tolerance)
    .filter((r) => r.severity === 'BLOCKING')
    .map((r) => r.text);
}

export type RolloutDecision =
  | { allowed: false; status: 'BLOCKED' | 'NOT VERIFIED'; reasons: string[] }
  | { allowed: true; status: 'PASS'; reasons: [] };
/**
 * The rollout gate. It never allows anything on REFERENCE data (that proves the machinery, not a model), never on thresholds the owner has not accepted, and never with a
 * failing, unmeasured or regressed metric.
 */
export function rolloutDecision(
  report: BenchmarkReport,
  results: readonly ThresholdResult[],
  regs: readonly string[],
  thresholdsAccepted: boolean,
): RolloutDecision {
  const reasons: string[] = [];
  if (!thresholdsAccepted) reasons.push('the thresholds are PROPOSED, not accepted by the owner');
  if (report.origins.includes('REFERENCE') || report.origins.length === 0)
    reasons.push('the evidence is REFERENCE (or absent), not a recording of a verified provider');
  for (const r of results)
    if (r.status !== 'PASS')
      reasons.push(`${r.id} ${r.scope}.${r.metric} ${r.op} ${r.value}: ${r.status}`);
  for (const g of regs) reasons.push(`regression: ${g}`);
  if (report.missingRecordings.length > 0) reasons.push('some tasks have no recording');
  if (reasons.length === 0) return { allowed: true, status: 'PASS', reasons: [] };
  const onlyUnverified = reasons.every(
    (x) => x.startsWith('the evidence') || x.startsWith('the thresholds'),
  );
  return { allowed: false, status: onlyUnverified ? 'NOT VERIFIED' : 'BLOCKED', reasons };
}
