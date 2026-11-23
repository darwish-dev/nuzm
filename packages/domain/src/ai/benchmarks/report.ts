import { replayTask } from './replay';
import { scoreRun } from './score';
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
}
export interface BenchmarkReport {
  /** where the recordings came from: a suite built only from REFERENCE recordings proves the machinery, never a model */
  origins: ('REFERENCE' | 'RECORDED')[];
  adapters: string[];
  tasks: number;
  missingRecordings: string[];
  byKind: Partial<Record<TaskKind, KindSummary>>;
  overall: KindSummary;
  /** credits for the tokens used, at the given rate card (credits per million tokens; the real rate card is D6) */
  estimatedCredits: string | null;
  /** measures that cannot exist offline */
  notMeasured: string[];
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const p95 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};
function summarize(scores: TaskScore[]): KindSummary {
  const n = scores.length;
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
  };
}

/** Replays and scores every task that has a recording; a task without one is listed, never silently dropped or counted as a pass. */
export function runSuite(
  tasks: readonly GoldenTask[],
  recordings: ReadonlyMap<string, Recording>,
  rate?: { creditsPerMillionInput: string; creditsPerMillionOutput: string },
): { scores: TaskScore[]; report: BenchmarkReport } {
  const scores: TaskScore[] = [];
  const missing: string[] = [];
  const used: Recording[] = [];
  let tin = 0n;
  let tout = 0n;
  for (const t of tasks) {
    const rec = recordings.get(t.id);
    if (!rec) {
      missing.push(t.id);
      continue;
    }
    used.push(rec);
    scores.push(scoreRun(t, replayTask(t, rec)));
    for (const turn of rec.turns) {
      tin += BigInt(turn.tokensIn);
      tout += BigInt(turn.tokensOut);
    }
  }
  const byKind: BenchmarkReport['byKind'] = {};
  for (const k of ['website', 'webapp', 'code-edit', 'tool-calling'] as const) {
    const of = scores.filter((s) => s.kind === k);
    if (of.length > 0) byKind[k] = summarize(of);
  }
  const credits =
    rate === undefined
      ? null
      : // integer arithmetic, rounded up: credits are whole numbers
        (
          (tin * BigInt(rate.creditsPerMillionInput) +
            tout * BigInt(rate.creditsPerMillionOutput) +
            999_999n) /
          1_000_000n
        ).toString();
  return {
    scores,
    report: {
      origins: [...new Set(used.map((r) => r.origin))],
      adapters: [...new Set(used.map((r) => `${r.adapterId}:${r.model}`))],
      tasks: scores.length,
      missingRecordings: missing,
      byKind,
      overall: summarize(scores),
      estimatedCredits: credits,
      notMeasured: [
        'human acceptance rate (needs named reviewers)',
        'latency of a real provider',
        'cost at the real rate card (D6)',
      ],
    },
  };
}

export function renderReport(r: BenchmarkReport): string {
  const row = (k: string, s: KindSummary) =>
    `| ${k} | ${s.tasks} | ${s.passRate} | ${s.validPatchRate} | ${s.meanQuality} | ${s.toolCallValidity} | ${s.modeViolations} | ${s.meanTokens} | ${s.meanToolCalls} | ${s.p95LatencyMs} |`;
  return [
    `Origins: ${r.origins.join(', ') || 'none'} · adapters: ${r.adapters.join(', ') || 'none'} · tasks: ${r.tasks}${r.missingRecordings.length ? ` · missing recordings: ${r.missingRecordings.join(', ')}` : ''}`,
    '',
    '| kind | tasks | pass | valid patch | quality | tool validity | violations | mean tokens | mean calls | p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.byKind).map(([k, s]) => row(k, s!)),
    row('ALL', r.overall),
    '',
    `Estimated credits: ${r.estimatedCredits ?? 'n/a (no rate card)'} · Not measured offline: ${r.notMeasured.join('; ')}`,
  ].join('\n');
}
