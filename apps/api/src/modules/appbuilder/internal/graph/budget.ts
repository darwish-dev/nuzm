import { RUN_CEILINGS } from '../core';
import type { RunBudget, RunUsage } from '../ports/m09';

export type BudgetDimension = 'tokens' | 'cost' | 'minutes' | 'steps';
/** Thrown BEFORE a call that cannot fit (hard stop at 100 %). The run ends `budget_exceeded`; nothing was sent to the gateway. */
export class BudgetExceeded extends Error {
  constructor(
    readonly dimension: BudgetDimension,
    detail: string,
  ) {
    super(`run budget exhausted (${dimension}): ${detail}`);
    this.name = 'BudgetExceeded';
  }
}
export interface Reservation {
  id: number;
  tokens: number;
  costMinor: number;
}
export interface BudgetSnapshot {
  tokens: { used: number; reserved: number; cap: number };
  costMinor: { used: number; reserved: number; cap: number };
  minutes: { used: number; cap: number };
  steps: { used: number; cap: number };
  /** Highest utilisation over the four dimensions, 0..100+ (including in-flight reservations). */
  pct: number;
  warn: boolean;
}

/** Clamp a requested budget to the ceilings of M10 §9 (2,000,000 tokens, 60 minutes). The cost cap is `min(run cap, org remaining)` and is applied per reservation. */
export function clampBudget(b: RunBudget): RunBudget {
  return {
    maxTokens: Math.min(b.maxTokens, RUN_CEILINGS.maxTokens),
    maxCostMinor: b.maxCostMinor,
    maxMinutes: Math.min(b.maxMinutes, RUN_CEILINGS.maxMinutes),
  };
}

/**
 * Budget arithmetic of one run (M10 §9, AC-M10-04). Pre-flight RESERVATION: before every gateway call the worst case (`inputEstimate + maxTokens` tokens priced at
 * the rate) is added to what is in flight; the call proceeds only if used + in-flight + worst case fits every cap, so a run can overshoot a cap by at most the
 * difference between a reservation and the actual usage of ONE call (never by a second call). Cost cap = min(run cap, org remaining credit), re-read at every reservation.
 * Money is integer minor units; no floats.
 */
export class BudgetLedger {
  private seq = 0;
  private readonly open = new Map<number, Reservation>();
  private warned = false;
  constructor(
    private readonly budget: RunBudget,
    private used: RunUsage,
    private readonly startedAtMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxSteps: number = RUN_CEILINGS.maxSteps,
  ) {}

  private reservedTokens = () => [...this.open.values()].reduce((a, r) => a + r.tokens, 0);
  private reservedCost = () => [...this.open.values()].reduce((a, r) => a + r.costMinor, 0);
  private minutesUsed = () => (this.now() - this.startedAtMs) / 60_000;

  /** `orgRemainingMinor` = remaining organization credit BEFORE this run's usage so far (the wallet projection already nets earlier settled calls: pass the current remaining). */
  reserve(
    inputTokensEstimate: number,
    maxOutputTokens: number,
    ratePer1kMinor: number,
    orgRemainingMinor: number,
  ): Reservation {
    const tokens =
      Math.max(0, Math.ceil(inputTokensEstimate)) + Math.max(0, Math.ceil(maxOutputTokens));
    const costMinor = Math.ceil((tokens * ratePer1kMinor) / 1000);
    const tokenCap = this.budget.maxTokens;
    const costCap = Math.min(
      this.budget.maxCostMinor,
      this.used.costMinor + this.reservedCost() + Math.max(0, orgRemainingMinor),
    );
    if (this.minutesUsed() >= this.budget.maxMinutes)
      throw new BudgetExceeded('minutes', `${this.budget.maxMinutes} minutes elapsed`);
    if (this.used.steps >= this.maxSteps)
      throw new BudgetExceeded('steps', `${this.maxSteps} steps used`);
    if (this.used.tokensIn + this.used.tokensOut + this.reservedTokens() + tokens > tokenCap)
      throw new BudgetExceeded(
        'tokens',
        `${this.used.tokensIn + this.used.tokensOut} used, ${tokens} needed, cap ${tokenCap}`,
      );
    if (this.used.costMinor + this.reservedCost() + costMinor > costCap)
      throw new BudgetExceeded(
        'cost',
        `${this.used.costMinor} used, ${costMinor} needed, cap ${costCap}`,
      );
    const r: Reservation = { id: ++this.seq, tokens, costMinor };
    this.open.set(r.id, r);
    this.checkWarn();
    return r;
  }
  /** The call finished with known usage. */
  settle(r: Reservation, actual: { tokensIn: number; tokensOut: number; costMinor: number }): void {
    this.open.delete(r.id);
    this.used = {
      ...this.used,
      tokensIn: this.used.tokensIn + actual.tokensIn,
      tokensOut: this.used.tokensOut + actual.tokensOut,
      costMinor: this.used.costMinor + actual.costMinor,
    };
    this.checkWarn();
  }
  /** The call provably never happened (nothing was sent): release the reservation. */
  release(r: Reservation): void {
    this.open.delete(r.id);
  }
  /** Uncertain outcome (timeout): reconcile conservatively, i.e. count the whole reservation as spent. The provider may have consumed it. */
  settleUncertain(r: Reservation): { tokens: number; costMinor: number } {
    this.settle(r, { tokensIn: 0, tokensOut: r.tokens, costMinor: r.costMinor });
    return { tokens: r.tokens, costMinor: r.costMinor };
  }
  countStep(): void {
    this.used = { ...this.used, steps: this.used.steps + 1 };
  }
  private checkWarn() {
    if (!this.warned && this.snapshot().pct >= RUN_CEILINGS.warnAtPct) this.warned = true;
  }
  /** True once utilisation reached 80 % (the run viewer shows a warning; checked by the caller to emit the alert once). */
  get warnedOnce(): boolean {
    return this.warned;
  }
  snapshot(): BudgetSnapshot {
    const tokens = {
      used: this.used.tokensIn + this.used.tokensOut,
      reserved: this.reservedTokens(),
      cap: this.budget.maxTokens,
    };
    const costMinor = {
      used: this.used.costMinor,
      reserved: this.reservedCost(),
      cap: this.budget.maxCostMinor,
    };
    const minutes = { used: this.minutesUsed(), cap: this.budget.maxMinutes };
    const steps = { used: this.used.steps, cap: this.maxSteps };
    const pct = Math.max(
      ((tokens.used + tokens.reserved) / Math.max(1, tokens.cap)) * 100,
      ((costMinor.used + costMinor.reserved) / Math.max(1, costMinor.cap)) * 100,
      (minutes.used / Math.max(1, minutes.cap)) * 100,
      (steps.used / Math.max(1, steps.cap)) * 100,
    );
    return { tokens, costMinor, minutes, steps, pct, warn: pct >= RUN_CEILINGS.warnAtPct };
  }
}
