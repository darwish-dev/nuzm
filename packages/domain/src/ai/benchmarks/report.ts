import { TASK_KINDS, type TaskCategory } from './categories';
import { fingerprint } from './canonical';
import { creditsFor, type RateCard } from './efficiency';
import { DATASET_VERSION, buildManifest } from './registry';
import { replayTask } from './replay';
import { scoreRunDetailed } from './score';
import type { GoldenTask, Recording, TaskKind, TaskScore } from './types';

export interface KindSummary {
  tasks: number;
  passRate: number;
  validPatchRate: number;
  meanQuality: number;
  meanTokens: number;
  meanToolCalls: number;
  toolCallValidity: number;
  modeViolations: number;
  budgetKeptRate: number;
  p95LatencyMs: number;
  /** dimensions (0-100). Nullable ones are `null` when no task of the group changed a file the dimension applies to. */
  meanFunctional: number;
  meanCodeQuality: number | null;
  meanSecurity: number | null;
  /** the lowest security score of any task: one insecure proposal is visible even when the mean is high */
  minSecurity: number | null;
  meanUiQuality: number | null;
  meanEfficiency: number;
}
/** What kind of evidence a report is. Offline replay is NEVER real-model performance; a replay of a RECORDED run says what the captured model did, offline. */
export type EvidenceLabel =
  | 'NONE'
  | 'OFFLINE_REFERENCE_ORACLE'
  | 'OFFLINE_MOCK_REPLAY'
  | 'OFFLINE_REPLAY_OF_RECORDED_RUN'
  | 'MIXED_ORIGINS_NOT_COMPARABLE';
export interface RejectedRecording {
  taskId: string;
  reason: string;
}
export interface BenchmarkReport {
  schema: 'nuzm.benchmark-report/2';
  datasetVersion: string;
  datasetHash: string;
  /** where the recordings came from: a suite built only from REFERENCE recordings proves the machinery, never a model */
  origins: Recording['origin'][];
  evidence: { label: EvidenceLabel; disclaimer: string };
  adapters: string[];
  tasks: number;
  missingRecordings: string[];
  /** recordings that were NOT scored: wrong dataset version, or RECORDED without capture provenance */
  rejectedRecordings: RejectedRecording[];
  byKind: Partial<Record<TaskKind, KindSummary>>;
  byCategory: Partial<Record<TaskCategory, KindSummary>>;
  overall: KindSummary;
  /** credits for the tokens used, at the given rate card (credits per million tokens; the real rate card is D6) */
  estimatedCredits: string | null;
  /** credits divided by passed tasks, rounded up; null when nothing passed or no rate card */
  creditsPerPassedTask: string | null;
  /** number of findings per rule id, across dimensions */
  findingsByRule: Record<string, number>;
  /** measures that cannot exist offline */
  notMeasured: string[];
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const meanOrNull = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : round(mean(v), 2);
};
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};
export function summarize(scores: readonly TaskScore[]): KindSummary {
  const n = scores.length;
  const sec = scores.map((s) => s.dimensions.security).filter((x): x is number => x !== null);
  return {
    tasks: n,
    passRate: round(n === 0 ? 0 : scores.filter((s) => s.passed).length / n),
    validPatchRate: round(n === 0 ? 0 : scores.filter((s) => s.validPatch).length / n),
    meanQuality: round(mean(scores.map((s) => s.quality)), 2),
    meanTokens: Math.round(mean(scores.map((s) => s.tokens))),
    meanToolCalls: round(mean(scores.map((s) => s.toolCalls)), 2),
    toolCallValidity: round(mean(scores.map((s) => s.toolCallValidity))),
    modeViolations: scores.reduce((a, s) => a + s.modeViolations, 0),
    budgetKeptRate: round(n === 0 ? 0 : scores.filter((s) => s.withinBudget).length / n),
    p95LatencyMs: p95(scores.map((s) => s.latencyMs)),
    meanFunctional: round(mean(scores.map((s) => s.dimensions.functional)), 2),
    meanCodeQuality: meanOrNull(scores.map((s) => s.dimensions.codeQuality)),
    meanSecurity: meanOrNull(scores.map((s) => s.dimensions.security)),
    minSecurity: sec.length === 0 ? null : Math.min(...sec),
    meanUiQuality: meanOrNull(scores.map((s) => s.dimensions.uiQuality)),
    meanEfficiency: round(mean(scores.map((s) => s.efficiency)), 2),
  };
}

const DISCLAIMER: Record<EvidenceLabel, string> = {
  NONE: 'No recording was scored. Nothing was measured.',
  OFFLINE_REFERENCE_ORACLE:
    'Produced by this repository\'s reference oracle, not by a model. It proves the benchmark machinery and is the baseline; it says nothing about any real model.',
  OFFLINE_MOCK_REPLAY:
    'Scripted by a mock or test double, not by a model. It exercises the pipeline; it says nothing about any real model.',
  OFFLINE_REPLAY_OF_RECORDED_RUN:
    'An offline replay of a run captured through the gated live runner. It reports what that captured run did; it is not a live measurement, and the capture provenance must be checked.',
  MIXED_ORIGINS_NOT_COMPARABLE: 'The recordings have different origins; the numbers are not comparable and are not evidence for a rollout.',
};
export function evidenceLabel(origins: readonly Recording['origin'][]): EvidenceLabel {
  const o = new Set(origins);
  if (o.size === 0) return 'NONE';
  if (o.size > 1) return 'MIXED_ORIGINS_NOT_COMPARABLE';
  const only = [...o][0]!;
  return only === 'REFERENCE' ? 'OFFLINE_REFERENCE_ORACLE' : only === 'MOCK' ? 'OFFLINE_MOCK_REPLAY' : 'OFFLINE_REPLAY_OF_RECORDED_RUN';
}

/** Why a recording may not be scored, or `null` when it may. */
export function recordingProblem(rec: Recording, datasetVersion: string): string | null {
  if (rec.datasetVersion !== undefined && rec.datasetVersion !== datasetVersion)
    return `recorded against dataset ${rec.datasetVersion}, not ${datasetVersion}`;
  if (rec.origin === 'RECORDED' && (!rec.capture || !rec.capture.runId || !rec.capture.approvalRef || !rec.capture.providerEvidenceRef))
    return 'a RECORDED run needs capture provenance (run id, approval reference, provider evidence reference)';
  return null;
}

/**
 * Replays and scores every task that has an acceptable recording. A task without one is listed (`missingRecordings`), a recording that may not be used is listed with its reason
 * (`rejectedRecordings`): neither is silently dropped or counted as a pass.
 */
export function runSuite(
  tasks: readonly GoldenTask[],
  recordings: ReadonlyMap<string, Recording>,
  rate?: RateCard,
  opts: { datasetVersion?: string } = {},
): { scores: TaskScore[]; report: BenchmarkReport } {
  const datasetVersion = opts.datasetVersion ?? DATASET_VERSION;
  const scores: TaskScore[] = [];
  const missing: string[] = [];
  const rejected: RejectedRecording[] = [];
  const used: Recording[] = [];
  const findings: Record<string, number> = {};
  let tin = 0;
  let tout = 0;
  for (const t of tasks) {
    const rec = recordings.get(t.id);
    if (!rec) {
      missing.push(t.id);
      continue;
    }
    const problem = recordingProblem(rec, datasetVersion);
    if (problem) {
      rejected.push({ taskId: t.id, reason: problem });
      continue;
    }
    used.push(rec);
    const r = scoreRunDetailed(t, replayTask(t, rec));
    scores.push(r.score);
    for (const f of r.findings) findings[f.rule] = (findings[f.rule] ?? 0) + 1;
    tin += r.score.tokensIn;
    tout += r.score.tokensOut;
  }
  const byKind: BenchmarkReport['byKind'] = {};
  for (const k of TASK_KINDS) {
    const of = scores.filter((s) => s.kind === k);
    if (of.length > 0) byKind[k] = summarize(of);
  }
  const byCategory: BenchmarkReport['byCategory'] = {};
  for (const c of [...new Set(scores.map((s) => s.category))].sort()) byCategory[c] = summarize(scores.filter((s) => s.category === c));
  const credits = rate === undefined ? null : creditsFor(tin, tout, rate);
  const passed = scores.filter((s) => s.passed).length;
  const origins = [...new Set(used.map((r) => r.origin))].sort();
  const label = evidenceLabel(origins);
  return {
    scores,
    report: {
      schema: 'nuzm.benchmark-report/2',
      datasetVersion,
      datasetHash: buildManifest(tasks, datasetVersion).hash,
      origins,
      evidence: { label, disclaimer: DISCLAIMER[label] },
      adapters: [...new Set(used.map((r) => `${r.adapterId}:${r.model}`))].sort(),
      tasks: scores.length,
      missingRecordings: missing,
      rejectedRecordings: rejected,
      byKind,
      byCategory,
      overall: summarize(scores),
      estimatedCredits: credits === null ? null : credits.toString(),
      creditsPerPassedTask: credits === null || passed === 0 ? null : ((credits + BigInt(passed) - 1n) / BigInt(passed)).toString(),
      findingsByRule: Object.fromEntries(Object.entries(findings).sort(([a], [b]) => (a < b ? -1 : 1))),
      notMeasured: [
        'human acceptance rate (needs named reviewers)',
        'latency of a real provider',
        'cost at the real rate card (D6)',
        'build and visual validation of generated apps (needs D-21)',
      ],
    },
  };
}

const cell = (n: number | null) => (n === null ? 'n/a' : String(n));
const row = (k: string, s: KindSummary) =>
  `| ${k} | ${s.tasks} | ${s.passRate} | ${s.validPatchRate} | ${s.meanQuality} | ${s.toolCallValidity} | ${s.modeViolations} | ${s.meanTokens} | ${s.meanToolCalls} | ${s.p95LatencyMs} |`;
const dimRow = (k: string, s: KindSummary) =>
  `| ${k} | ${s.meanFunctional} | ${cell(s.meanCodeQuality)} | ${cell(s.meanSecurity)} | ${cell(s.minSecurity)} | ${cell(s.meanUiQuality)} | ${s.meanEfficiency} |`;

export function renderReport(r: BenchmarkReport): string {
  return [
    `Evidence: ${r.evidence.label} — ${r.evidence.disclaimer}`,
    `Dataset ${r.datasetVersion} (${r.datasetHash.slice(0, 12)}) · origins: ${r.origins.join(', ') || 'none'} · adapters: ${r.adapters.join(', ') || 'none'} · tasks: ${r.tasks}${r.missingRecordings.length ? ` · missing recordings: ${r.missingRecordings.join(', ')}` : ''}${r.rejectedRecordings.length ? ` · rejected recordings: ${r.rejectedRecordings.map((x) => `${x.taskId} (${x.reason})`).join('; ')}` : ''}`,
    '',
    '| kind | tasks | pass | valid patch | quality | tool validity | violations | mean tokens | mean calls | p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.byKind).map(([k, s]) => row(k, s!)),
    row('ALL', r.overall),
    '',
    '| category | tasks | pass | valid patch | quality | tool validity | violations | mean tokens | mean calls | p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.byCategory).map(([k, s]) => row(k, s!)),
    '',
    '| dimension (mean) | functional | code quality | security | min security | UI quality | efficiency |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(r.byKind).map(([k, s]) => dimRow(k, s!)),
    dimRow('ALL', r.overall),
    '',
    `Estimated credits: ${r.estimatedCredits ?? 'n/a (no rate card)'}${r.creditsPerPassedTask ? ` (${r.creditsPerPassedTask} per passed task)` : ''} · Static findings: ${Object.entries(r.findingsByRule).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
    `Not measured offline: ${r.notMeasured.join('; ')}`,
  ].join('\n');
}

/** Machine-readable, stable serialization (sorted keys): the same report always produces the same bytes. */
export { canonicalJson as renderReportJson } from './canonical';
export const reportFingerprint = (r: BenchmarkReport): string => fingerprint(r);

/** One CSV line per category (and per kind and ALL), for spreadsheets. Values are numbers or empty; no free text, so no quoting is needed. */
export function renderReportCsv(r: BenchmarkReport): string {
  const head = 'scope,name,tasks,passRate,validPatchRate,meanQuality,toolCallValidity,modeViolations,budgetKeptRate,meanTokens,p95LatencyMs,meanFunctional,meanCodeQuality,meanSecurity,minSecurity,meanUiQuality,meanEfficiency';
  const line = (scope: string, name: string, s: KindSummary) =>
    [scope, name, s.tasks, s.passRate, s.validPatchRate, s.meanQuality, s.toolCallValidity, s.modeViolations, s.budgetKeptRate, s.meanTokens, s.p95LatencyMs, s.meanFunctional, s.meanCodeQuality ?? '', s.meanSecurity ?? '', s.minSecurity ?? '', s.meanUiQuality ?? '', s.meanEfficiency].join(',');
  return [
    head,
    line('all', 'ALL', r.overall),
    ...Object.entries(r.byKind).map(([k, s]) => line('kind', k, s!)),
    ...Object.entries(r.byCategory).map(([k, s]) => line('category', k, s!)),
  ].join('\n');
}
