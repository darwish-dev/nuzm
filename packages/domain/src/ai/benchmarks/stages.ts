import type { PriceCard } from './budget';
import { costMinor, worstCaseTaskMinor, type BenchmarkBudget } from './budget';
import { CORE_TASKS } from './dataset';
import { TASK_KINDS } from './categories';
import type { GoldenTask } from './types';

/**
 * Staged qualification strategy (Phase 2). Five stages, each a pure plan over the golden dataset: which tasks, how many runs, what it costs (estimated AND maximum), how long, what must
 * be true before it starts, and what ends it. Nothing here calls a provider or a clock; running a stage is the gated live runner's job, and only after every precondition holds.
 *
 *  A smoke           one task per kind plus one Arabic task: proves capture, usage accounting, budget ledger and provenance end to end at a cost of cents.
 *  B representative  one task per category (23): first real signal per category; calibrates the cost model used by C-E.
 *  C qualification   the whole suite, one run per task, for ONE model: the evidence the rollout gate and the human review use.
 *  D comparison      the whole suite for each of 2+ candidate models: ranks models on identical tasks.
 *  E regression      the 24 core tasks on a schedule (and on every change), the full suite monthly: detects drift against the stage C baseline.
 *
 * Every price here is an INPUT supplied by the caller (`PriceCard`); `REFERENCE_RATE_INPUTS` are the vendor's public list prices as read on 2026-11-24 and are NOT confirmed against
 * any contract: Session 02 / decision D6 owns the confirmed numbers. Every estimate rests on `CostAssumptions`, which are assumptions until stage A measures them.
 */
export const STAGE_IDS = ['A', 'B', 'C', 'D', 'E'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface RateInput {
  model: string;
  price: PriceCard;
  /** where the numbers come from, with the date they were read */
  source: string;
  status: 'TO_BE_CONFIRMED_BY_S02_D6';
}
const SRC = 'vendor public pricing page, read 2026-11-24 (no contract, no account)';
/** USD cents per million tokens. The vendor page printed no API model ids for these rows, so the model is named as the page names it. Never used as a customer price. */
export const REFERENCE_RATE_INPUTS: readonly RateInput[] = [
  {
    model: 'Claude Fable 5.2',
    price: { currency: 'USD', minorPerMillionInput: '800', minorPerMillionOutput: '4000' },
    source: SRC,
    status: 'TO_BE_CONFIRMED_BY_S02_D6',
  },
  {
    model: 'Claude Opus 5.5',
    price: { currency: 'USD', minorPerMillionInput: '400', minorPerMillionOutput: '2000' },
    source: SRC,
    status: 'TO_BE_CONFIRMED_BY_S02_D6',
  },
  {
    model: 'Claude Sonnet 5.5',
    price: { currency: 'USD', minorPerMillionInput: '200', minorPerMillionOutput: '1000' },
    source: SRC,
    status: 'TO_BE_CONFIRMED_BY_S02_D6',
  },
  {
    model: 'Claude Haiku 5.5 (prompts up to 100,000 tokens)',
    price: { currency: 'USD', minorPerMillionInput: '10', minorPerMillionOutput: '50' },
    source: SRC,
    status: 'TO_BE_CONFIRMED_BY_S02_D6',
  },
];

/** Assumptions behind every ESTIMATE (the maximum never depends on them). Integers; replaced by what stage A measures. */
export interface CostAssumptions {
  /** share of a task's token ceiling a run is expected to use, in thousandths */
  usagePermille: number;
  /** share of those tokens that are input, in thousandths (agent loops re-send context: input-heavy) */
  inputSharePermille: number;
  /** expected mean wall time of one task, seconds */
  meanTaskSeconds: number;
  /** wall time at which one task is considered to have run to its limit, seconds */
  maxTaskSeconds: number;
  status: 'ASSUMPTION';
  basis: string;
}
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  // threshold T10 proposes a mean of 30,000 tokens per task; the mean ceiling of the suite is 4,180,000 / 83 = 50,361 tokens: 30,000 / 50,361 = 0.596, rounded up to 0.60
  usagePermille: 600,
  inputSharePermille: 850,
  meanTaskSeconds: 45,
  // threshold T11 proposes p95 <= 90 s
  maxTaskSeconds: 90,
  status: 'ASSUMPTION',
  basis:
    'usage 0.60 of the ceiling (T10 30,000 / mean ceiling 50,361); input 85% (assumed: agent loops re-send context); 45 s mean and 90 s limit per task (T11). All to be replaced by the measurements of stage A.',
};

export type PrerequisiteId =
  | 'FLAG_ON'
  | 'LIVE_GATE_OPEN'
  | 'ENVIRONMENT_NON_PRODUCTION'
  | 'PROVIDER_VERIFIED'
  | 'CAPTURE_SOURCE_BUILT'
  | 'RATES_CONFIRMED'
  | 'VENDOR_SPEND_CAP'
  | 'THRESHOLDS_ACCEPTED'
  | 'BUDGET_APPROVED_FOR_STAGE'
  | 'REVIEWERS_NAMED'
  | 'SECURITY_REVIEW_PASSED'
  | 'PREVIOUS_STAGE_EXITED'
  | 'BASELINE_RECORDED';

/** What each prerequisite means and who provides it (documentation shown in the admin console and the approval pack). */
export const PREREQUISITES: Record<PrerequisiteId, { owner: string; text: string }> = {
  FLAG_ON: { owner: 'owner (flag)', text: 'BENCHMARK_LIVE_ENABLED is on (default off)' },
  LIVE_GATE_OPEN: {
    owner: 'owner (D9)',
    text: 'the live-provider gate AI_LIVE_PROVIDERS is open for the environment',
  },
  ENVIRONMENT_NON_PRODUCTION: {
    owner: 'owner',
    text: 'a named non-production environment',
  },
  PROVIDER_VERIFIED: {
    owner: 'S02 (D2-D5, D9)',
    text: 'the provider and model passed the live verification suite; an evidence reference exists',
  },
  CAPTURE_SOURCE_BUILT: {
    owner: 'S02 / integration',
    text: 'an adapter-backed CaptureSource for exactly that provider and model exists and is tested against mocks',
  },
  RATES_CONFIRMED: {
    owner: 'owner (D6) / S02',
    text: 'the price card used for the budget is confirmed against the agreement or console (the public list price is only a reference)',
  },
  VENDOR_SPEND_CAP: {
    owner: 'owner (D4)',
    text: 'the vendor-side monthly spend limit is set, at or above the stage maximum and the approved budget',
  },
  THRESHOLDS_ACCEPTED: {
    owner: 'owner (AC-AG-10)',
    text: 'thresholds version 2-proposed (or a newer one) accepted in writing BEFORE any live result is seen',
  },
  BUDGET_APPROVED_FOR_STAGE: {
    owner: 'owner (BUD)',
    text: 'an approved budget whose caps cover this stage worst case (preflight proves it)',
  },
  REVIEWERS_NAMED: { owner: 'owner (REV)', text: 'at least two named reviewers' },
  SECURITY_REVIEW_PASSED: {
    owner: 'owner (SEC-AG)',
    text: 'the agent security review is recorded as passed',
  },
  PREVIOUS_STAGE_EXITED: {
    owner: 'this engine',
    text: 'the previous stage ended and met every exit criterion for the same model, dataset version and thresholds version',
  },
  BASELINE_RECORDED: {
    owner: 'this engine',
    text: 'a stage C report of the same dataset version exists and the model is QUALIFIED (or the owner accepted a first run without baseline)',
  },
};
/** The prerequisites the live runner's preflight already enforces for ANY live run (see `livePreflight`). */
const ALL_LIVE: PrerequisiteId[] = [
  'FLAG_ON',
  'LIVE_GATE_OPEN',
  'ENVIRONMENT_NON_PRODUCTION',
  'PROVIDER_VERIFIED',
  'CAPTURE_SOURCE_BUILT',
  'RATES_CONFIRMED',
  'VENDOR_SPEND_CAP',
  'THRESHOLDS_ACCEPTED',
  'BUDGET_APPROVED_FOR_STAGE',
  'REVIEWERS_NAMED',
  'SECURITY_REVIEW_PASSED',
];

export interface StageDefinition {
  id: StageId;
  title: string;
  purpose: string;
  /** the selection rule, in words (the code in `selectStageTasks` is the rule) */
  selectionRule: string;
  runsPerTask: number;
  /** minimum and maximum number of models this stage covers */
  models: { min: number; max: number };
  prerequisites: PrerequisiteId[];
  exitCriteria: string[];
}
export const STAGES: readonly StageDefinition[] = [
  {
    id: 'A',
    title: 'Minimal synthetic smoke',
    purpose:
      'prove the real path end to end (capture, provenance, usage accounting, budget ledger, stop rules) and measure the cost-model inputs, at a cost of cents',
    selectionRule:
      'for each of the 4 kinds the task with the smallest token ceiling (ties: lowest id), plus the lowest-id task of the category arabic-rtl whose locale is ar (distinct): 5 tasks',
    runsPerTask: 1,
    models: { min: 1, max: 1 },
    prerequisites: [...ALL_LIVE],
    exitCriteria: [
      'status COMPLETED (not refused, not stopped)',
      'every task recorded; no recording rejected for provenance or dataset version; no uncertain outcome',
      'actual cost, tokens and requests are within the stage MAXIMUM, and the usage the provider reported matches what the ledger committed',
      'zero mode violations (T02); a violation stops the programme until understood',
      'the measured usage share and input share are recorded and fed into the cost model for B-E (`calibrateAssumptions`)',
    ],
  },
  {
    id: 'B',
    title: 'Representative subset',
    purpose:
      'first real signal in every one of the 23 categories, and the calibrated cost model for the expensive stages',
    selectionRule: 'for each of the 23 categories the task with the lowest id: 23 tasks',
    runsPerTask: 1,
    models: { min: 1, max: 1 },
    prerequisites: [...ALL_LIVE, 'PREVIOUS_STAGE_EXITED'],
    exitCriteria: [
      'status COMPLETED; all 23 recorded; none rejected',
      'actual cost within 1.25 x the calibrated estimate and within the stage maximum',
      'zero mode violations; no category with a security finding scored below the proposed floor (T13) without a written explanation',
      'the calibrated estimate for stage C is recomputed and the owner is shown the new number before C starts',
      'pass rates are reported but NOT gated: one task per category cannot support a pass-rate claim',
    ],
  },
  {
    id: 'C',
    title: 'Full qualification suite',
    purpose:
      'the evidence for the rollout gate: all 83 tasks, all 23 categories, for the one model being qualified',
    selectionRule: 'every task of the dataset version in force: 83 tasks',
    runsPerTask: 1,
    models: { min: 1, max: 1 },
    prerequisites: [...ALL_LIVE, 'PREVIOUS_STAGE_EXITED'],
    exitCriteria: [
      'status COMPLETED; every task recorded; none rejected; evidence label OFFLINE_REPLAY_OF_RECORDED_RUN',
      'actual cost within the stage maximum',
      'every threshold evaluated (T01-T20, category floor); the rollout gate decision recorded, with its failed checks if any',
      'the human review plan is created from this run (blind, at least 20 tasks) and the reviewers are notified; the qualification record moves to EVIDENCE_ATTACHED',
      'the report is stored as the model baseline for stage E ONLY when the gate has passed',
    ],
  },
  {
    id: 'D',
    title: 'Comparative model evaluation',
    purpose: 'rank two or more candidate models on identical tasks, same dataset, same thresholds',
    selectionRule: 'every task of the dataset version in force, for each candidate model',
    runsPerTask: 1,
    models: { min: 2, max: 4 },
    prerequisites: [...ALL_LIVE, 'PREVIOUS_STAGE_EXITED'],
    exitCriteria: [
      'every candidate ran the full suite of the same dataset version, thresholds version and currency (the stage C run of a candidate may be reused while its model version, dataset and thresholds are unchanged)',
      'the comparison is `comparable` and every row is labelled with its evidence',
      'pairwise sign tests are reported; no model is promoted on a difference that is not significant, and the owner decides (a recommendation, never an automatic switch)',
    ],
  },
  {
    id: 'E',
    title: 'Continuous regression',
    purpose:
      'detect a silent change (model version, prompt, tools, adapter, dataset) before customers do',
    selectionRule:
      'the 24 core tasks on a schedule and on every relevant change; the full suite monthly',
    runsPerTask: 1,
    models: { min: 1, max: 1 },
    prerequisites: [...ALL_LIVE, 'PREVIOUS_STAGE_EXITED', 'BASELINE_RECORDED'],
    exitCriteria: [
      'status COMPLETED within the monthly budget cap; no blocking regression against the baseline of the same dataset version',
      'a blocking regression suspends the model qualification (suspend event) and opens an incident; a warning is shown and tracked',
      'a dataset or thresholds version change expires the baseline: the next run is a stage C',
    ],
  },
];
export const stageDefinition = (id: StageId): StageDefinition => STAGES.find((s) => s.id === id)!;

/** The tasks a stage runs (a deterministic function of the dataset: the same input always selects the same tasks). */
export function selectStageTasks(id: StageId, tasks: readonly GoldenTask[]): GoldenTask[] {
  const byId = (a: GoldenTask, b: GoldenTask) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...tasks].sort(byId);
  switch (id) {
    case 'A': {
      const chosen: GoldenTask[] = [];
      for (const k of TASK_KINDS) {
        const of = sorted
          .filter((t) => t.kind === k)
          .sort((a, b) => a.budget.maxTokens - b.budget.maxTokens || byId(a, b));
        if (of[0]) chosen.push(of[0]);
      }
      const ar = sorted.find(
        (t) => t.category === 'arabic-rtl' && t.locale === 'ar' && !chosen.includes(t),
      );
      if (ar) chosen.push(ar);
      return chosen.sort(byId);
    }
    case 'B': {
      const seen = new Set<string>();
      const out: GoldenTask[] = [];
      for (const t of sorted)
        if (!seen.has(t.category)) {
          seen.add(t.category);
          out.push(t);
        }
      return out;
    }
    case 'C':
    case 'D':
      return sorted;
    case 'E': {
      const core = new Set(CORE_TASKS.map((t) => t.id));
      return sorted.filter((t) => core.has(t.id));
    }
  }
}

export interface StagePlan {
  stage: StageId;
  title: string;
  taskIds: string[];
  tasks: number;
  categories: number;
  models: number;
  /** tasks x runs per task x models */
  runs: number;
  currency: string;
  /** MAXIMUM: the sum of every task ceiling billed at the dearer price, for every run: what the ledger will never let the stage exceed (plus at most one call's max_tokens, see the doc) */
  max: { tokens: number; requests: number; costMinor: string };
  /** ESTIMATE: rests on the stated assumptions */
  estimate: { tokens: number; tokensIn: number; tokensOut: number; costMinor: string };
  /** minutes: estimate at the mean task time, maximum at the task limit (sequential execution) */
  duration: { estimatedMinutes: number; maximumMinutes: number };
  /** the smallest budget that lets this stage start: the maximum, as caps */
  minimumBudgetCaps: { maxCostMinor: string; maxTokens: number; maxRequests: number };
  assumptions: CostAssumptions;
  problems: string[];
}
export function planStage(
  id: StageId,
  allTasks: readonly GoldenTask[],
  prices: readonly PriceCard[],
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): StagePlan {
  const def = stageDefinition(id);
  const tasks = selectStageTasks(id, allTasks);
  const problems: string[] = [];
  if (prices.length < def.models.min || prices.length > def.models.max)
    problems.push(
      `stage ${id} covers ${def.models.min === def.models.max ? def.models.min : `${def.models.min}-${def.models.max}`} model(s); ${prices.length} price card(s) given`,
    );
  const currency = prices[0]?.currency ?? '';
  if (prices.some((p) => p.currency !== currency))
    problems.push('the price cards use different currencies');
  if (tasks.length === 0) problems.push('no task selected');
  const a = assumptions;
  if (
    ![a.usagePermille, a.inputSharePermille].every(
      (x) => Number.isInteger(x) && x >= 0 && x <= 1000,
    )
  )
    problems.push('assumption shares must be integers between 0 and 1000');

  let maxTokens = 0;
  let maxRequests = 0;
  let maxCost = 0n;
  let estIn = 0;
  let estOut = 0;
  let estCost = 0n;
  for (const price of prices) {
    for (const t of tasks) {
      for (let r = 0; r < def.runsPerTask; r++) {
        maxTokens += t.budget.maxTokens;
        maxRequests += t.budget.maxTurns;
        maxCost += worstCaseTaskMinor(t, price);
        const tok = Math.ceil((t.budget.maxTokens * a.usagePermille) / 1000);
        const tin = Math.ceil((tok * a.inputSharePermille) / 1000);
        estIn += tin;
        estOut += tok - tin;
        estCost += costMinor(tin, tok - tin, price);
      }
    }
  }
  const runs = tasks.length * def.runsPerTask * prices.length;
  return {
    stage: id,
    title: def.title,
    taskIds: tasks.map((t) => t.id),
    tasks: tasks.length,
    categories: new Set(tasks.map((t) => t.category)).size,
    models: prices.length,
    runs,
    currency,
    max: { tokens: maxTokens, requests: maxRequests, costMinor: maxCost.toString() },
    estimate: {
      tokens: estIn + estOut,
      tokensIn: estIn,
      tokensOut: estOut,
      costMinor: estCost.toString(),
    },
    duration: {
      estimatedMinutes: Math.ceil((runs * a.meanTaskSeconds) / 60),
      maximumMinutes: Math.ceil((runs * a.maxTaskSeconds) / 60),
    },
    minimumBudgetCaps: {
      maxCostMinor: maxCost.toString(),
      maxTokens,
      maxRequests,
    },
    assumptions: a,
    problems,
  };
}

/** A budget proposal for the owner that exactly covers a stage worst case (the owner may approve a larger or a smaller number; a smaller one makes the preflight refuse). */
export function proposedBudgetFor(
  plan: StagePlan,
  ref: string,
  approvedBy: string,
): BenchmarkBudget {
  return {
    ref,
    approvedBy,
    currency: plan.currency,
    maxCostMinor: plan.minimumBudgetCaps.maxCostMinor,
    maxTokens: plan.minimumBudgetCaps.maxTokens,
    maxRequests: plan.minimumBudgetCaps.maxRequests,
  };
}

export interface ContinuousCadence {
  coreRunsPerMonth: number;
  fullRunsPerMonth: number;
}
/** Stage E monthly cost: `coreRunsPerMonth` core executions plus `fullRunsPerMonth` full ones, for one model. */
export function planContinuousMonth(
  allTasks: readonly GoldenTask[],
  price: PriceCard,
  cadence: ContinuousCadence = { coreRunsPerMonth: 4, fullRunsPerMonth: 1 },
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): {
  cadence: ContinuousCadence;
  core: StagePlan;
  full: StagePlan;
  monthly: { estimateCostMinor: string; maxCostMinor: string; maxTokens: number };
} {
  const core = planStage('E', allTasks, [price], assumptions);
  const full = planStage('C', allTasks, [price], assumptions);
  const n = BigInt(cadence.coreRunsPerMonth);
  const m = BigInt(cadence.fullRunsPerMonth);
  return {
    cadence,
    core,
    full,
    monthly: {
      estimateCostMinor: (
        BigInt(core.estimate.costMinor) * n +
        BigInt(full.estimate.costMinor) * m
      ).toString(),
      maxCostMinor: (BigInt(core.max.costMinor) * n + BigInt(full.max.costMinor) * m).toString(),
      maxTokens:
        core.max.tokens * cadence.coreRunsPerMonth + full.max.tokens * cadence.fullRunsPerMonth,
    },
  };
}

/** Replaces the usage and input shares with what a finished stage measured (rounded UP so later estimates are not too low). Latency is replaced too when measured. */
export function calibrateAssumptions(
  measured: {
    tokensIn: number;
    tokensOut: number;
    ceilingTokens: number;
    meanTaskSeconds?: number;
    maxTaskSeconds?: number;
  },
  from: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): CostAssumptions {
  const total = measured.tokensIn + measured.tokensOut;
  if (total <= 0 || measured.ceilingTokens <= 0) return from;
  return {
    ...from,
    usagePermille: Math.min(1000, Math.ceil((total * 1000) / measured.ceilingTokens)),
    inputSharePermille: Math.min(1000, Math.ceil((measured.tokensIn * 1000) / total)),
    meanTaskSeconds: measured.meanTaskSeconds ?? from.meanTaskSeconds,
    maxTaskSeconds: measured.maxTaskSeconds ?? from.maxTaskSeconds,
    basis: `measured by the previous stage (${total} tokens against a ceiling of ${measured.ceilingTokens})`,
  };
}

export interface StageState {
  /** prerequisites that currently hold, each with the reference that proves it */
  satisfied: Partial<Record<PrerequisiteId, string>>;
}
export interface StageEntry {
  stage: StageId;
  canStart: boolean;
  missing: { id: PrerequisiteId; owner: string; text: string }[];
}
/** Which prerequisites of a stage are missing. A prerequisite holds only with a non-blank evidence reference: an absent one fails closed. */
export function evaluateStageEntry(id: StageId, state: StageState): StageEntry {
  const missing = stageDefinition(id)
    .prerequisites.filter((p) => {
      const ref = state.satisfied[p];
      return typeof ref !== 'string' || ref.trim() === '';
    })
    .map((p) => ({ id: p, ...PREREQUISITES[p] }));
  return { stage: id, canStart: missing.length === 0, missing };
}

export interface StageOutcome {
  stage: StageId;
  status: 'COMPLETED' | 'REFUSED' | 'STOPPED_BUDGET' | 'STOPPED_UNCERTAIN' | 'STOPPED_FAILED';
  recorded: number;
  rejected: number;
  modeViolations: number;
  actual: { tokens: number; requests: number; costMinor: string };
  /** the calibrated estimate the owner saw before the stage (B: 1.25 x rule); omitted for A */
  estimateCostMinor?: string;
  /** C-E: the rollout gate / threshold / regression results */
  gateAllowed?: boolean;
  thresholdsEvaluated?: boolean;
  blockingRegressions?: number;
  comparable?: boolean;
}
export interface ExitCheck {
  id: string;
  ok: boolean;
  detail: string;
}
/** Whether a stage met its exit criteria. Pure; an unmet check is reported with its reason and the stage does NOT exit. */
export function evaluateStageExit(plan: StagePlan, o: StageOutcome): ExitCheck[] {
  const c: ExitCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => c.push({ id, ok, detail });
  add('completed', o.status === 'COMPLETED', `status ${o.status}`);
  add(
    'all_recorded',
    o.recorded === plan.runs && o.rejected === 0,
    `${o.recorded}/${plan.runs} recorded, ${o.rejected} rejected`,
  );
  const within =
    BigInt(o.actual.costMinor) <= BigInt(plan.max.costMinor) &&
    o.actual.tokens <= plan.max.tokens &&
    o.actual.requests <= plan.max.requests;
  add('within_maximum', within, `actual ${o.actual.costMinor} of maximum ${plan.max.costMinor}`);
  add('no_mode_violations', o.modeViolations === 0, `${o.modeViolations} violation(s)`);
  if (o.estimateCostMinor !== undefined && (o.stage === 'B' || o.stage === 'C')) {
    const limit = (BigInt(o.estimateCostMinor) * 125n + 99n) / 100n;
    add(
      'near_estimate',
      BigInt(o.actual.costMinor) <= limit,
      `actual ${o.actual.costMinor} against 1.25 x estimate ${limit}`,
    );
  }
  if (o.stage === 'C' || o.stage === 'D' || o.stage === 'E')
    add('thresholds_evaluated', o.thresholdsEvaluated === true, 'every threshold has a result');
  if (o.stage === 'C') add('gate_decision_recorded', o.gateAllowed !== undefined, 'gate decided');
  if (o.stage === 'D') add('comparable', o.comparable === true, 'reports are comparable');
  if (o.stage === 'E')
    add('no_blocking_regression', (o.blockingRegressions ?? 1) === 0, 'against the baseline');
  return c;
}
/** A stage exits only when every check passes. */
export const stageExited = (checks: readonly ExitCheck[]): boolean =>
  checks.length > 0 && checks.every((x) => x.ok);

/** Total exposure of the whole programme: A, B, C once, D with `candidates` models (the C model is counted again: conservative), plus `months` months of E. Integer minor units. */
export function programmeExposure(
  allTasks: readonly GoldenTask[],
  price: PriceCard,
  candidates: number,
  months: number,
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): { estimateMinor: string; maxMinor: string } {
  const one = (id: StageId) => planStage(id, allTasks, [price], assumptions);
  const d = planStage('D', allTasks, Array(Math.max(2, candidates)).fill(price), assumptions);
  const e = planContinuousMonth(allTasks, price, undefined, assumptions);
  const est =
    BigInt(one('A').estimate.costMinor) +
    BigInt(one('B').estimate.costMinor) +
    BigInt(one('C').estimate.costMinor) +
    BigInt(d.estimate.costMinor) +
    BigInt(e.monthly.estimateCostMinor) * BigInt(months);
  const max =
    BigInt(one('A').max.costMinor) +
    BigInt(one('B').max.costMinor) +
    BigInt(one('C').max.costMinor) +
    BigInt(d.max.costMinor) +
    BigInt(e.monthly.maxCostMinor) * BigInt(months);
  return { estimateMinor: est.toString(), maxMinor: max.toString() };
}
