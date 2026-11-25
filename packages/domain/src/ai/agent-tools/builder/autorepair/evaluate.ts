import { previewChangeSet, type FileOp } from '../changeset';
import { diagnoseBuildLog, fingerprint, type Diagnostic } from '../diagnose';
import type { RepairStrategy } from '../repair';
import type { ErrorClass } from './classes';
import {
  countClasses,
  outcomeOf,
  summarizeRepairs,
  type RepairMetrics,
  type RepairRoundRecord,
} from './metrics';
import { ERROR_CLASSES } from './classes';

/**
 * Offline repair evaluation (P3-S03). A CASE is a broken project plus where its failure log came from; a VERIFIER decides whether a project is green and produces the log of a
 * project that is not. The runner repeats: verify → diagnose → strategy → guards → apply → verify, within a round limit, and records per round what the engine did. It measures the
 * ENGINE (diagnosis, class routing, guards, rounds, bookkeeping) and, with a scripted completion, nothing about a model; with a recorded real log and a real compiler as the
 * verifier it shows that the deterministic repairs really turn a failing build green.
 *
 * Labels carried in every result: `verifier` (what decided green) and `strategyKind`, so a SIMULATED run is never mistaken for a live one and rates are never added across origins.
 */
export interface RepairCase {
  id: string;
  title: string;
  /** the project as generated (broken) */
  files: Record<string, string>;
  /** classes the FIRST failure must show (checked: a case whose recorded log no longer classifies as expected is a failing case) */
  expectClasses: readonly ErrorClass[];
  /** where the first log came from, e.g. `recorded: tsc 5.9.3, 2026-11-24` or `format from the tool's documentation` */
  provenance: string;
}
export interface VerifyResult {
  passed: boolean;
  /** the tool output of the failing run (empty when passed) */
  log: string;
}
export interface Verifier {
  /** `typescript-in-memory`, `predicate`, `mock-port`, `real-runtime` */
  readonly name: string;
  verify(files: ReadonlyMap<string, string>): Promise<VerifyResult>;
}
export interface CaseResult {
  id: string;
  verifier: string;
  strategyKind: string;
  firstClasses: ErrorClass[];
  classesAsExpected: boolean;
  green: boolean;
  rounds: RepairRoundRecord[];
  stop:
    | 'green'
    | 'round_limit'
    | 'no_progress'
    | 'strategy_gave_up'
    | 'proposal_rejected'
    | 'needs_approval';
  metrics: RepairMetrics;
  files: Map<string, string>;
}

export interface RunOptions {
  maxRounds?: number;
  /** tokens each model turn used, when the strategy is model-backed and the caller knows (a scripted completion reports a fixed number) */
  tokensOf?: (strategy: RepairStrategy) => number;
  strategyKind: string;
  origin: RepairMetrics['origin'];
}

export async function runRepairCase(
  c: Pick<RepairCase, 'id' | 'files' | 'expectClasses'>,
  verifier: Verifier,
  strategy: RepairStrategy,
  o: RunOptions,
): Promise<CaseResult> {
  const maxRounds = o.maxRounds ?? 3;
  let files = new Map(Object.entries(c.files));
  const rounds: RepairRoundRecord[] = [];
  const seen = new Set<string>();
  let v = await verifier.verify(files);
  const first = v.passed ? [] : diagnoseBuildLog(v.log);
  const firstClasses = first.map((d) => d.class ?? 'unknown');
  const classesAsExpected = c.expectClasses.every((k) => firstClasses.includes(k));
  let stop: CaseResult['stop'] = 'green';
  let diags: Diagnostic[] = first;
  while (!v.passed) {
    const n = rounds.length + 1;
    const fp = fingerprint(diags);
    if (n > maxRounds) {
      stop = 'round_limit';
      break;
    }
    if (seen.has(fp)) {
      stop = 'no_progress';
      break;
    }
    seen.add(fp);
    const before = countClasses(diags.map((d) => d.class));
    const history = rounds.map((r) => ({
      round: r.round,
      classes: Object.keys(r.before),
      strategy: r.strategy,
      note: r.note ?? '',
      outcome:
        r.outcome === 'resolved' ||
        r.outcome === 'partial' ||
        r.outcome === 'unchanged' ||
        r.outcome === 'worse'
          ? r.outcome
          : ('pending' as const),
    }));
    const proposal = await strategy.propose({
      iteration: n,
      files,
      findings: [],
      diagnostics: diags,
      rejected: [],
      history,
    });
    const rec: RepairRoundRecord = {
      ...(proposal?.meta?.targeted ? { targeted: proposal.meta.targeted as ErrorClass[] } : {}),
      round: n,
      before,
      strategy: proposal?.meta?.strategy ?? 'none',
      opsApplied: 0,
      asks: proposal?.meta?.asks ?? 0,
      tokens: o.tokensOf?.(strategy) ?? 0,
      refused: [...(proposal?.meta?.refused ?? [])],
      outcome: 'gave_up',
    };
    if (proposal?.note) rec.note = 'proposed';
    rounds.push(rec);
    if (!proposal || proposal.ops.length === 0) {
      stop = 'strategy_gave_up';
      break;
    }
    const prev = previewChangeSet(files, proposal.ops as FileOp[], { hasHead: true });
    if (!prev.ok) {
      rec.outcome = 'rejected';
      rec.refused.push(...prev.errors.map((e) => e.code));
      stop = 'proposal_rejected';
      break;
    }
    if (prev.approval.required) {
      rec.outcome = 'rejected';
      rec.refused.push('needs_approval');
      stop = 'needs_approval';
      break;
    }
    files = prev.next!;
    rec.opsApplied = proposal.ops.length;
    v = await verifier.verify(files);
    diags = v.passed ? [] : diagnoseBuildLog(v.log);
    rec.after = countClasses(diags.map((d) => d.class));
    rec.outcome = outcomeOf(before, rec.after);
  }
  const metrics = summarizeRepairs(rounds, o.origin);
  return {
    id: c.id,
    verifier: verifier.name,
    strategyKind: o.strategyKind,
    firstClasses,
    classesAsExpected,
    green: v.passed,
    rounds,
    stop: v.passed ? 'green' : stop,
    metrics,
    files,
  };
}

export interface CorpusEvaluation {
  cases: number;
  green: number;
  /** integer basis points */
  greenRateBp: number;
  byClass: Record<
    string,
    { attempted: number; resolved: number; rateBp: number | null; cases: number }
  >;
  rounds: { total: number; mean10: number };
  tokens: number;
  verifier: string;
  strategyKind: string;
}

/** aggregates results of ONE verifier and ONE strategy kind (mixing origins is refused: a simulated and a live rate never share a number) */
export function aggregate(results: readonly CaseResult[]): CorpusEvaluation {
  const kinds = new Set(results.map((r) => `${r.verifier}|${r.strategyKind}`));
  if (kinds.size > 1)
    throw new Error('results of different verifiers or strategy kinds must not be aggregated');
  const byClass: CorpusEvaluation['byClass'] = {};
  let rounds = 0;
  let tokens = 0;
  for (const r of results) {
    rounds += r.rounds.length;
    tokens += r.metrics.tokens;
    for (const k of ERROR_CLASSES) {
      const m = r.metrics.byClass[k];
      if (!m) continue;
      const a = (byClass[k] ??= { attempted: 0, resolved: 0, rateBp: null, cases: 0 });
      a.attempted += m.attempted;
      a.resolved += m.resolved;
      a.cases += 1;
    }
  }
  for (const a of Object.values(byClass))
    a.rateBp = a.attempted ? Math.floor((a.resolved * 10_000) / a.attempted) : null;
  const green = results.filter((r) => r.green).length;
  const first = results[0];
  return {
    cases: results.length,
    green,
    greenRateBp: results.length ? Math.floor((green * 10_000) / results.length) : 0,
    byClass,
    rounds: {
      total: rounds,
      mean10: results.length ? Math.floor((rounds * 10) / results.length) : 0,
    },
    tokens,
    verifier: first?.verifier ?? 'none',
    strategyKind: first?.strategyKind ?? 'none',
  };
}
