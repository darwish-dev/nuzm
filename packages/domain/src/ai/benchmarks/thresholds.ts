import type { BenchmarkReport, KindSummary } from './report';
import type { TaskKind } from './types';

/**
 * PROPOSED acceptance thresholds for the owner (AC-AG-10). Status is PROPOSED until the owner accepts them in writing; nothing here is a decision. They are checked against
 * a report; a regression against a stored baseline blocks rollout independently of the absolute values.
 */
export type Metric = Exclude<keyof KindSummary, 'tasks'>;
export interface Threshold {
  id: string;
  scope: TaskKind | 'all';
  metric: Metric;
  op: '>=' | '<=' | '==';
  value: number;
  why: string;
}
export const THRESHOLDS_VERSION = '1-proposed';
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
];
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
    const src = t.scope === 'all' ? report.overall : report.byKind[t.scope];
    if (!src || src.tasks === 0) return { ...t, actual: null, status: 'NOT MEASURED' };
    const actual = src[t.metric];
    if (actual === null) return { ...t, actual: null, status: 'NOT MEASURED' };
    const ok =
      t.op === '>=' ? actual >= t.value : t.op === '<=' ? actual <= t.value : actual === t.value;
    return { ...t, actual, status: ok ? 'PASS' : 'FAIL' };
  });
}

/** Regression against a stored baseline: a drop in a rate or quality beyond `tolerance`, a rise in violations, or tokens up by more than 10 %. Blocks rollout. */
export function regressions(
  report: BenchmarkReport,
  baseline: BenchmarkReport,
  tolerance = 0.02,
): string[] {
  const out: string[] = [];
  const pairs: [string, KindSummary | undefined, KindSummary | undefined][] = [
    ['all', report.overall, baseline.overall],
    ...(['website', 'webapp', 'code-edit', 'tool-calling'] as const).map(
      (k) =>
        [k, report.byKind[k], baseline.byKind[k]] as [
          string,
          KindSummary | undefined,
          KindSummary | undefined,
        ],
    ),
  ];
  for (const [k, now, base] of pairs) {
    if (!now || !base) continue;
    for (const m of ['passRate', 'validPatchRate', 'toolCallValidity', 'budgetKeptRate'] as const)
      if (now[m] < base[m] - tolerance) out.push(`${k}: ${m} fell from ${base[m]} to ${now[m]}`);
    if (now.meanQuality < base.meanQuality - tolerance * 100)
      out.push(`${k}: meanQuality fell from ${base.meanQuality} to ${now.meanQuality}`);
    if (now.modeViolations > base.modeViolations)
      out.push(`${k}: mode violations rose from ${base.modeViolations} to ${now.modeViolations}`);
    if (base.meanTokens > 0 && now.meanTokens > base.meanTokens * 1.1)
      out.push(`${k}: mean tokens rose from ${base.meanTokens} to ${now.meanTokens}`);
  }
  return out;
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
