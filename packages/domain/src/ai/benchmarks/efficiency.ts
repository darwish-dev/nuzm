import type { GoldenTask, RunOutcome } from './types';

/**
 * Token, cost and latency efficiency. All integer arithmetic; no clock. `efficiencyScore` is 0-100 and deterministic:
 *  - tokens (weight 50): 100 at or below 25 % of the task's token budget, falling linearly to 0 at 100 %;
 *  - turns (weight 25): 100 at or below half of the turn budget, falling linearly to 0 at the budget;
 *  - latency (weight 25): 100 at or below 30 s, falling linearly to 0 at 180 s (a PROPOSED shape; the real latency target is owner-accepted threshold T11).
 */
export const EFFICIENCY_SHAPE = {
  tokenFullAtPct: 25,
  turnFullAtPct: 50,
  latencyFullMs: 30_000,
  latencyZeroMs: 180_000,
  weights: { tokens: 50, turns: 25, latency: 25 },
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export function efficiencyScore(
  task: GoldenTask,
  o: Pick<RunOutcome, 'tokens' | 'turns' | 'latencyMs'>,
): number {
  const E = EFFICIENCY_SHAPE;
  const tokPct = (100 * o.tokens) / Math.max(1, task.budget.maxTokens);
  const tok = clamp01((100 - tokPct) / (100 - E.tokenFullAtPct));
  const turnPct = (100 * o.turns) / Math.max(1, task.budget.maxTurns);
  const turn = clamp01((100 - turnPct) / (100 - E.turnFullAtPct));
  const lat = clamp01((E.latencyZeroMs - o.latencyMs) / (E.latencyZeroMs - E.latencyFullMs));
  const raw = E.weights.tokens * tok + E.weights.turns * turn + E.weights.latency * lat;
  return Math.round(raw * 10) / 10;
}

/** A rate card: credits per million input and output tokens (decimal integer strings). The real card is owner decision D6; tests use made-up numbers. */
export interface RateCard {
  creditsPerMillionInput: string;
  creditsPerMillionOutput: string;
}
/** Credits for a token count at a rate card, rounded UP to a whole credit (bigint integer math). */
export function creditsFor(tokensIn: number, tokensOut: number, rate: RateCard): bigint {
  return (
    (BigInt(tokensIn) * BigInt(rate.creditsPerMillionInput) +
      BigInt(tokensOut) * BigInt(rate.creditsPerMillionOutput) +
      999_999n) /
    1_000_000n
  );
}
