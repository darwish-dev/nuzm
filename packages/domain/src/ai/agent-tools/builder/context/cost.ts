import type { ImplementationPlan, TaskKind } from '../planning/types';
import { costMinor } from './tokens';
import type { ContextKind } from './compress';

/** Per size point, a planning figure for the tokens a task of this kind reads (context) and writes (output). Estimates, not measurements: the provider's usage is authoritative. */
export const TASK_TOKENS: Record<TaskKind, { input: number; output: number }> = {
  config: { input: 800, output: 600 },
  schema: { input: 1500, output: 1200 },
  backend: { input: 2500, output: 2000 },
  frontend: { input: 3000, output: 2500 },
  auth: { input: 2500, output: 2200 },
  integration: { input: 2200, output: 1800 },
  tests: { input: 2500, output: 2500 },
  docs: { input: 1200, output: 1500 },
  review: { input: 3000, output: 600 },
};

export interface Rates {
  /** integer minor units per 1000 input tokens */
  inputPer1k: number;
  /** integer minor units per 1000 output tokens */
  outputPer1k: number;
}
export interface TaskEstimate {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
}
export interface PlanEstimate {
  tasks: TaskEstimate[];
  inputTokens: number;
  outputTokens: number;
  /** extra allowance for the repair loop (a share of the build tasks' tokens, per round) */
  repairTokens: number;
  totalTokens: number;
  costMinor: number;
}

export function estimatePlan(plan: ImplementationPlan, rates: Rates, opts: { repairRounds?: number } = {}): PlanEstimate {
  const rounds = Math.max(0, Math.min(opts.repairRounds ?? 1, 3));
  const tasks = plan.tasks.map((t) => {
    const base = TASK_TOKENS[t.kind];
    const inputTokens = base.input * t.size;
    const outputTokens = base.output * t.size;
    return { taskId: t.id, inputTokens, outputTokens, costMinor: costMinor(inputTokens, rates.inputPer1k) + costMinor(outputTokens, rates.outputPer1k) };
  });
  const inputTokens = tasks.reduce((n, t) => n + t.inputTokens, 0);
  const outputTokens = tasks.reduce((n, t) => n + t.outputTokens, 0);
  const repairTokens = Math.ceil(((inputTokens + outputTokens) * 0.3 * rounds)); // 30% of the build work per round
  return {
    tasks,
    inputTokens,
    outputTokens,
    repairTokens,
    totalTokens: inputTokens + outputTokens + repairTokens,
    // the repair allowance is priced at the blended rate of the plan
    costMinor: tasks.reduce((n, t) => n + t.costMinor, 0) + costMinor(Math.ceil(repairTokens / 2), rates.inputPer1k) + costMinor(Math.ceil(repairTokens / 2), rates.outputPer1k),
  };
}

export type BudgetAllocation =
  | { ok: true; perTask: { taskId: string; tokens: number }[]; reserve: number }
  | { ok: false; reason: 'infeasible'; needed: number };

/** Splits a token budget over the tasks in proportion to their estimates (never below a floor), keeping a reserve for the repair loop. Refuses a budget that cannot cover the floors. */
export function allocateBudget(plan: ImplementationPlan, maxTokens: number, opts: { floor?: number; reserveShare?: number } = {}): BudgetAllocation {
  const floor = opts.floor ?? 2_000;
  const reserve = Math.floor(maxTokens * Math.min(Math.max(opts.reserveShare ?? 0.15, 0), 0.5));
  const usable = maxTokens - reserve;
  const need = plan.tasks.length * floor;
  if (need > usable) return { ok: false, reason: 'infeasible', needed: need + reserve };
  const weights = plan.tasks.map((t) => (TASK_TOKENS[t.kind].input + TASK_TOKENS[t.kind].output) * t.size);
  const sum = weights.reduce((a, b) => a + b, 0);
  let spare = usable - need;
  const perTask = plan.tasks.map((t, i) => {
    const extra = Math.floor((spare * weights[i]!) / sum);
    return { taskId: t.id, tokens: floor + extra };
  });
  spare = usable - perTask.reduce((n, x) => n + x.tokens, 0);
  if (perTask.length) perTask[perTask.length - 1]!.tokens += spare; // rounding remainder
  return { ok: true, perTask, reserve };
}

/** Whole-file replacement is simplest, but costs output tokens in proportion to the FILE; a unified diff costs in proportion to the CHANGE. */
export function chooseEditMode(f: { bytes: number; changedLines: number; totalLines: number }): 'whole_file' | 'unified_diff' {
  if (f.bytes < 2_000 || f.totalLines <= 0) return 'whole_file';
  return f.changedLines / f.totalLines <= 0.3 ? 'unified_diff' : 'whole_file';
}

const STABILITY: Record<ContextKind, number> = { system: 0, memory: 1, plan: 2, file: 3, tool_result: 4, note: 5, diagnostic: 6, turn: 7 };
/** Orders prompt parts from most stable to most volatile, so a provider that caches a shared prefix can reuse it between turns. Stable sort: parts of one kind keep their order. */
export function cacheFriendlyOrder<T extends { kind: ContextKind }>(parts: readonly T[]): T[] {
  return parts.map((p, i) => ({ p, i })).sort((a, b) => STABILITY[a.p.kind] - STABILITY[b.p.kind] || a.i - b.i).map((x) => x.p);
}
