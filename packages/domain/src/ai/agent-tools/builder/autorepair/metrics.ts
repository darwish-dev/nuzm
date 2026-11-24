import type { ErrorClass } from './classes';

/**
 * Repair metrics (P3-S03): what the repair rounds of a run achieved, per error class. A round records the classes that failed BEFORE it (with counts) and those that still failed
 * AFTER the rebuild; the difference is what the round resolved. Nothing here is a model-quality claim by itself: it is a measurement of one run, labelled by the origin of the build
 * (MOCK/twin or REAL) so a simulated rate is never added to a real one.
 */
export type RoundOutcome =
  'resolved' | 'partial' | 'unchanged' | 'worse' | 'pending' | 'rejected' | 'gave_up';
export type ClassCounts = Partial<Record<ErrorClass, number>>;

export interface RepairRoundRecord {
  round: number;
  /** what the round was about */
  before: ClassCounts;
  /** what still failed after the rebuild (undefined until it ran) */
  after?: ClassCounts;
  /** `deterministic:<fixer id>` (one or several, joined with `+`), `model`, or `none` when nothing was proposed */
  strategy: string;
  opsApplied: number;
  /** model turns used by the round (0 for a deterministic one) */
  asks: number;
  tokens: number;
  /** guard codes that refused a proposal of this round */
  refused: string[];
  outcome: RoundOutcome;
  /** the version this round created, when it did */
  versionId?: string;
  /** a short fixed-vocabulary note (the strategy's summary is NOT kept: it is model text) */
  note?: string;
}

export const countClasses = (classes: readonly (ErrorClass | undefined)[]): ClassCounts => {
  const out: ClassCounts = {};
  for (const c of classes) {
    const k = c ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

const total = (c: ClassCounts | undefined): number =>
  Object.values(c ?? {}).reduce((n, x) => n + (x ?? 0), 0);

/** the outcome of a round, from the classes before and after its rebuild */
export function outcomeOf(before: ClassCounts, after: ClassCounts): RoundOutcome {
  const b = total(before);
  const a = total(after);
  if (a === 0) return 'resolved';
  if (a > b) return 'worse';
  const fixedAny = (Object.keys(before) as ErrorClass[]).some(
    (c) => (after[c] ?? 0) < (before[c] ?? 0),
  );
  if (a === b && !fixedAny) return 'unchanged';
  return 'partial';
}

export interface ClassMetric {
  /** diagnostics of this class that a round tried to fix */
  attempted: number;
  /** of those, how many were gone after the rebuild */
  resolved: number;
  /** resolved / attempted in basis points (integer, no floats), null when nothing was attempted */
  rateBp: number | null;
  /** rounds that involved the class */
  rounds: number;
}
export interface RepairMetrics {
  rounds: number;
  /** a final verdict: the last round resolved everything */
  greenAfterRepair: boolean;
  byClass: Partial<Record<ErrorClass, ClassMetric>>;
  tokens: number;
  asks: number;
  deterministicRounds: number;
  modelRounds: number;
  refusedProposals: number;
  /** MOCK/twin results never count as REAL */
  origin: 'MOCK' | 'REAL' | 'TWIN';
}

export function summarizeRepairs(
  records: readonly RepairRoundRecord[],
  origin: RepairMetrics['origin'],
): RepairMetrics {
  const byClass: Partial<Record<ErrorClass, ClassMetric>> = {};
  let tokens = 0;
  let asks = 0;
  let det = 0;
  let model = 0;
  let refused = 0;
  for (const r of records) {
    tokens += r.tokens;
    asks += r.asks;
    refused += r.refused.length;
    if (r.strategy.startsWith('deterministic')) det++;
    else if (r.strategy === 'model') model++;
    for (const c of Object.keys(r.before) as ErrorClass[]) {
      const m = (byClass[c] ??= { attempted: 0, resolved: 0, rateBp: null, rounds: 0 });
      const was = r.before[c] ?? 0;
      m.attempted += was;
      m.rounds += 1;
      if (r.after) m.resolved += Math.max(0, was - (r.after[c] ?? 0));
    }
  }
  for (const m of Object.values(byClass))
    m.rateBp = m.attempted === 0 ? null : Math.floor((m.resolved * 10_000) / m.attempted);
  const last = records[records.length - 1];
  return {
    rounds: records.length,
    greenAfterRepair: !!last && last.outcome === 'resolved',
    byClass,
    tokens,
    asks,
    deterministicRounds: det,
    modelRounds: model,
    refusedProposals: refused,
    origin,
  };
}
