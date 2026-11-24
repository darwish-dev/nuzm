import type { BenchmarkReport } from './report';
import type { ThresholdResult } from './thresholds';

/**
 * The qualification scorecard: the seven dimensions the owner reads a model by, each with its measured value, the number of tasks behind it, and the thresholds that judge it.
 * A pure view over a report; it adds no new judgement. A dimension no task measured is `null`, never 100.
 */
export const SCORECARD_DIMENSIONS = [
  'functional',
  'code-quality',
  'security',
  'arabic-rtl',
  'tool-calling-reliability',
  'cost-token-efficiency',
  'latency',
] as const;
export type ScorecardDimension = (typeof SCORECARD_DIMENSIONS)[number];

export interface ScorecardRow {
  dimension: ScorecardDimension;
  /** the headline number (0-100 for scores, 0-1 for rates, ms for latency, tokens for cost) */
  value: number | null;
  unit: 'score' | 'rate' | 'ms' | 'tokens';
  /** how many tasks the number rests on */
  tasks: number;
  /** supporting numbers, named */
  detail: Record<string, number | string | null>;
  /** the thresholds that judge this dimension and their current status */
  thresholds: { id: string; status: ThresholdResult['status'] }[];
}

const THRESHOLDS_OF: Record<ScorecardDimension, string[]> = {
  functional: ['T01', 'T16'],
  'code-quality': ['T14'],
  security: ['T02', 'T12', 'T13', 'T18'],
  'arabic-rtl': ['T15', 'T19'],
  'tool-calling-reliability': ['T03', 'T08'],
  'cost-token-efficiency': ['T10', 'T17'],
  latency: ['T11'],
};

export function buildScorecard(
  report: BenchmarkReport,
  results: readonly ThresholdResult[],
): ScorecardRow[] {
  const o = report.overall;
  const n = o.tasks;
  const ar = report.arabicRtl;
  const tool = report.byKind['tool-calling'];
  const th = (d: ScorecardDimension) =>
    THRESHOLDS_OF[d].map((id) => ({
      id,
      status: results.find((x) => x.id === id)?.status ?? ('NOT MEASURED' as const),
    }));
  const row = (
    dimension: ScorecardDimension,
    value: number | null,
    unit: ScorecardRow['unit'],
    tasks: number,
    detail: ScorecardRow['detail'],
  ): ScorecardRow => ({ dimension, value, unit, tasks, detail, thresholds: th(dimension) });
  return [
    row('functional', n === 0 ? null : o.meanFunctional, 'score', n, {
      passRate: n === 0 ? null : o.passRate,
      validPatchRate: n === 0 ? null : o.validPatchRate,
    }),
    row('code-quality', o.meanCodeQuality, 'score', n, {}),
    row('security', o.meanSecurity, 'score', n, {
      minSecurity: o.minSecurity,
      modeViolations: n === 0 ? null : o.modeViolations,
    }),
    row('arabic-rtl', ar ? ar.passRate : null, 'rate', ar?.tasks ?? 0, {
      meanUiQuality: ar?.meanUiQuality ?? null,
      meanQuality: ar?.meanQuality ?? null,
      categoryPassRate: report.byCategory['arabic-rtl']?.passRate ?? null,
    }),
    row('tool-calling-reliability', n === 0 ? null : o.toolCallValidity, 'rate', n, {
      toolCallingKindPassRate: tool?.passRate ?? null,
      meanToolCalls: n === 0 ? null : o.meanToolCalls,
    }),
    row('cost-token-efficiency', n === 0 ? null : o.meanTokens, 'tokens', n, {
      meanEfficiency: n === 0 ? null : o.meanEfficiency,
      estimatedCredits: report.estimatedCredits,
      creditsPerPassedTask: report.creditsPerPassedTask,
    }),
    row('latency', n === 0 ? null : o.p95LatencyMs, 'ms', n, {}),
  ];
}
