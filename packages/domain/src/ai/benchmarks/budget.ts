import type { GoldenTask } from './types';

/**
 * Benchmark budget enforcement. A live benchmark spends money, so it runs inside an owner-approved cap that is checked BEFORE the run (worst case of the whole suite must fit),
 * BEFORE each task (the task's ceiling must fit what is left) and AFTER each call (actuals are committed; an overrun stops everything). All amounts are integers: tokens and
 * requests are counts, money is minor units of one currency (rounded UP per call). The cap and the price card are owner inputs (decision BUD and D6); nothing here invents one.
 */
export interface PriceCard {
  currency: string;
  /** minor units (e.g. cents) per million tokens, decimal integer strings */
  minorPerMillionInput: string;
  minorPerMillionOutput: string;
}
export interface BenchmarkBudget {
  /** reference of the owner's approval; required */
  ref: string;
  approvedBy: string;
  currency: string;
  /** money cap in minor units, decimal integer string */
  maxCostMinor: string;
  maxTokens: number;
  maxRequests: number;
}
export type BudgetCheck = { ok: true } | { ok: false; reasons: string[] };

export function validateBudget(b: BenchmarkBudget | null | undefined): BudgetCheck {
  const reasons: string[] = [];
  if (!b) return { ok: false, reasons: ['no approved budget'] };
  if (!b.ref.trim()) reasons.push('budget approval reference missing');
  if (!b.approvedBy.trim()) reasons.push('budget approver missing');
  if (!/^[A-Z]{3}$/.test(b.currency)) reasons.push('budget currency must be an ISO code');
  if (!/^[1-9]\d*$/.test(b.maxCostMinor)) reasons.push('maxCostMinor must be a positive integer string');
  if (!Number.isInteger(b.maxTokens) || b.maxTokens < 1) reasons.push('maxTokens must be a positive integer');
  if (!Number.isInteger(b.maxRequests) || b.maxRequests < 1) reasons.push('maxRequests must be a positive integer');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Money for tokens, rounded up to a whole minor unit. */
export function costMinor(tokensIn: number, tokensOut: number, p: PriceCard): bigint {
  return ceilDiv(BigInt(tokensIn) * BigInt(p.minorPerMillionInput) + BigInt(tokensOut) * BigInt(p.minorPerMillionOutput), 1_000_000n);
}
/** Worst-case cost of a task: all its token ceiling billed at the dearer of the two prices. */
export function worstCaseTaskMinor(task: GoldenTask, p: PriceCard): bigint {
  const dearer = BigInt(p.minorPerMillionInput) > BigInt(p.minorPerMillionOutput) ? p.minorPerMillionInput : p.minorPerMillionOutput;
  return ceilDiv(BigInt(task.budget.maxTokens) * BigInt(dearer), 1_000_000n);
}

/** Checks before anything is called: the budget is valid, currencies agree, and the worst case of the whole suite fits every cap. */
export function preflightBudget(tasks: readonly GoldenTask[], b: BenchmarkBudget | null, p: PriceCard): BudgetCheck & { worstCase?: { tokens: number; requests: number; costMinor: string } } {
  const v = validateBudget(b);
  if (!v.ok) return v;
  const budget = b!;
  const reasons: string[] = [];
  if (p.currency !== budget.currency) reasons.push('price card and budget use different currencies');
  const tokens = tasks.reduce((a, t) => a + t.budget.maxTokens, 0);
  const requests = tasks.reduce((a, t) => a + t.budget.maxTurns, 0);
  const cost = tasks.reduce((a, t) => a + worstCaseTaskMinor(t, p), 0n);
  if (tokens > budget.maxTokens) reasons.push(`worst-case tokens ${tokens} exceed the cap ${budget.maxTokens}`);
  if (requests > budget.maxRequests) reasons.push(`worst-case requests ${requests} exceed the cap ${budget.maxRequests}`);
  if (cost > BigInt(budget.maxCostMinor)) reasons.push(`worst-case cost ${cost} exceeds the cap ${budget.maxCostMinor} ${budget.currency}`);
  const worstCase = { tokens, requests, costMinor: cost.toString() };
  return reasons.length === 0 ? { ok: true, worstCase } : { ok: false, reasons, worstCase };
}

/** Running account of a live run. Stateful but clock-free and I/O-free. */
export class BudgetLedger {
  private tokens = 0;
  private requests = 0;
  private cost = 0n;
  private reserved: { tokens: number; requests: number; cost: bigint } | null = null;
  private stopped: string | null = null;
  constructor(
    readonly budget: BenchmarkBudget,
    readonly price: PriceCard,
  ) {
    const v = validateBudget(budget);
    if (!v.ok) throw new Error(`invalid benchmark budget: ${v.reasons.join('; ')}`);
    if (price.currency !== budget.currency) throw new Error('price card and budget use different currencies');
  }
  /** Reserves the task's ceiling; false (and nothing reserved) when it does not fit what is left or the ledger is stopped. */
  reserve(task: GoldenTask): boolean {
    if (this.stopped || this.reserved) return false;
    const need = { tokens: task.budget.maxTokens, requests: task.budget.maxTurns, cost: worstCaseTaskMinor(task, this.price) };
    if (this.tokens + need.tokens > this.budget.maxTokens || this.requests + need.requests > this.budget.maxRequests || this.cost + need.cost > BigInt(this.budget.maxCostMinor)) {
      this.stopped = 'the remaining budget cannot cover the next task';
      return false;
    }
    this.reserved = need;
    return true;
  }
  /** Commits what a task really used and releases its reservation. An actual above the reservation, or above a cap, stops the ledger for good. */
  commit(tokensIn: number, tokensOut: number, requests: number): void {
    const r = this.reserved;
    this.reserved = null;
    const t = tokensIn + tokensOut;
    const c = costMinor(tokensIn, tokensOut, this.price);
    this.tokens += t;
    this.requests += requests;
    this.cost += c;
    if (r && (t > r.tokens || requests > r.requests || c > r.cost)) this.stopped = 'a task used more than its reserved ceiling';
    if (this.tokens > this.budget.maxTokens || this.requests > this.budget.maxRequests || this.cost > BigInt(this.budget.maxCostMinor)) this.stopped = 'the budget cap was exceeded';
  }
  /** Releases a reservation for a call that never went out (nothing spent). */
  release(): void {
    this.reserved = null;
  }
  get stopReason(): string | null {
    return this.stopped;
  }
  usage() {
    return { tokens: this.tokens, requests: this.requests, costMinor: this.cost.toString(), currency: this.budget.currency, stopped: this.stopped };
  }
}
