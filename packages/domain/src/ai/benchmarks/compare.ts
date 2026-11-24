import type { BenchmarkReport, KindSummary } from './report';
import type { TaskScore } from './types';

/**
 * Model comparison. Compares reports of the SAME dataset version only; every row carries its evidence label, and a comparison that includes REFERENCE, MOCK or mixed evidence says
 * so (`notModelEvidence`). Ranking is a deterministic total order, never a judgement: violations first, then pass rate, quality, security floor, cost, label.
 */
export interface ComparisonEntry {
  label: string;
  report: BenchmarkReport;
  scores: readonly TaskScore[];
}
export interface ComparisonRow {
  label: string;
  evidence: BenchmarkReport['evidence']['label'];
  tasks: number;
  passRate: number;
  meanQuality: number;
  meanSecurity: number | null;
  minSecurity: number | null;
  meanEfficiency: number;
  meanTokens: number;
  p95LatencyMs: number;
  modeViolations: number;
  creditsPerPassedTask: string | null;
}
export interface Pairwise {
  a: string;
  b: string;
  aWins: number;
  bWins: number;
  ties: number;
  /** two-sided exact sign test over the tasks where exactly one passed (null when there is no such task) */
  signTestP: number | null;
}
export interface ModelComparison {
  comparable: boolean;
  problems: string[];
  /** true when any entry is not a recorded run: the table shows plumbing, not model quality */
  notModelEvidence: boolean;
  datasetVersion: string | null;
  rows: ComparisonRow[];
  ranking: string[];
  pairwise: Pairwise[];
  /** per category, the label with the highest pass rate (ties: `tie`); only categories every entry measured */
  categoryLeaders: Record<string, string>;
}

/** Two-sided exact binomial (sign) test, p = 2 * P(X <= min(w, l)) for X ~ Bin(n, 1/2), capped at 1. */
export function signTest(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  const k = Math.min(wins, losses);
  let logC = 0; // log C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC - n * Math.LN2);
  }
  return Math.round(Math.min(1, 2 * sum) * 10_000) / 10_000;
}
const cmpNum = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const credits = (s: string | null) => (s === null ? Number.POSITIVE_INFINITY : Number(s));

export function compareModels(entries: readonly ComparisonEntry[]): ModelComparison {
  const problems: string[] = [];
  const versions = new Set(entries.map((e) => e.report.datasetVersion));
  const hashes = new Set(entries.map((e) => e.report.datasetHash));
  if (entries.length < 2) problems.push('at least two entries are needed');
  if (versions.size > 1) problems.push(`entries use different dataset versions: ${[...versions].join(', ')}`);
  else if (hashes.size > 1) problems.push('entries use the same dataset version with different content hashes');
  if (new Set(entries.map((e) => e.label)).size !== entries.length) problems.push('labels must be unique');
  const idSets = entries.map((e) => new Set(e.scores.map((s) => s.taskId)));
  const common: string[] = idSets.length === 0 ? [] : [...idSets[0]!].filter((id) => idSets.every((s) => s.has(id)));
  if (idSets.some((s) => s.size !== common.length)) problems.push('entries did not score the same tasks: pairwise results use the common tasks only');
  const comparable = versions.size === 1 && hashes.size === 1 && entries.length >= 2;
  const notModel = entries.some((e) => e.report.evidence.label !== 'OFFLINE_REPLAY_OF_RECORDED_RUN');
  const rows: ComparisonRow[] = entries.map((e) => ({
    label: e.label,
    evidence: e.report.evidence.label,
    tasks: e.report.overall.tasks,
    passRate: e.report.overall.passRate,
    meanQuality: e.report.overall.meanQuality,
    meanSecurity: e.report.overall.meanSecurity,
    minSecurity: e.report.overall.minSecurity,
    meanEfficiency: e.report.overall.meanEfficiency,
    meanTokens: e.report.overall.meanTokens,
    p95LatencyMs: e.report.overall.p95LatencyMs,
    modeViolations: e.report.overall.modeViolations,
    creditsPerPassedTask: e.report.creditsPerPassedTask,
  }));
  const ordered = [...rows].sort(
    (a, b) =>
      cmpNum(a.modeViolations, b.modeViolations) ||
      cmpNum(b.passRate, a.passRate) ||
      cmpNum(b.meanQuality, a.meanQuality) ||
      cmpNum(b.minSecurity ?? -1, a.minSecurity ?? -1) ||
      cmpNum(credits(a.creditsPerPassedTask), credits(b.creditsPerPassedTask)) ||
      (a.label < b.label ? -1 : 1),
  );
  const pairwise: Pairwise[] = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const A = new Map(entries[i]!.scores.map((s) => [s.taskId, s.passed]));
      const B = new Map(entries[j]!.scores.map((s) => [s.taskId, s.passed]));
      let aw = 0;
      let bw = 0;
      let ties = 0;
      for (const id of common) {
        const a = A.get(id)!;
        const b = B.get(id)!;
        if (a === b) ties += 1;
        else if (a) aw += 1;
        else bw += 1;
      }
      pairwise.push({ a: entries[i]!.label, b: entries[j]!.label, aWins: aw, bWins: bw, ties, signTestP: signTest(aw, bw) });
    }
  const leaders: Record<string, string> = {};
  const cats = entries.map((e) => e.report.byCategory);
  const shared = Object.keys(cats[0] ?? {}).filter((c) => cats.every((m) => (m as Record<string, KindSummary | undefined>)[c] !== undefined));
  for (const c of shared.sort()) {
    const best = Math.max(...cats.map((m) => (m as Record<string, KindSummary>)[c]!.passRate));
    const winners = entries.filter((e) => (e.report.byCategory as Record<string, KindSummary>)[c]!.passRate === best);
    leaders[c] = winners.length === 1 ? winners[0]!.label : 'tie';
  }
  return {
    comparable,
    problems,
    notModelEvidence: notModel,
    datasetVersion: versions.size === 1 ? [...versions][0]! : null,
    rows: ordered,
    ranking: ordered.map((r) => r.label),
    pairwise,
    categoryLeaders: leaders,
  };
}
