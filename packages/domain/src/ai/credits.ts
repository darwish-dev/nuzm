/**
 * Credit arithmetic (M09 S37). Everything is integer BigInt math: no floats anywhere near money or tokens (CLAUDE.md §4).
 * A rate card gives credits per MILLION tokens as integer strings; a cost is rounded UP so the platform never under-charges by rounding.
 */
export interface RateCard {
  creditsPerMillionInput: string;
  creditsPerMillionOutput: string;
}
export const parseRate = (s: string): bigint => {
  if (!/^\d{1,15}$/.test(s)) throw new Error('rate must be a non-negative integer string');
  return BigInt(s);
};
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const MILLION = 1_000_000n;

export function creditsFor(rate: RateCard, inputTokens: number, outputTokens: number): bigint {
  if (
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    throw new Error('token counts must be non-negative integers');
  return ceilDiv(
    BigInt(inputTokens) * parseRate(rate.creditsPerMillionInput) +
      BigInt(outputTokens) * parseRate(rate.creditsPerMillionOutput),
    MILLION,
  );
}
/** The worst case of one call: every prompt token plus `maxTokens` output tokens. This is what a pre-flight reservation holds. */
export const reservationFor = (rate: RateCard, promptTokens: number, maxTokens: number): bigint =>
  creditsFor(rate, promptTokens, maxTokens);

export interface BudgetLevel {
  /** remaining credits at this level, `null` = unlimited */
  remainingCredits: bigint | null;
  /** remaining tokens at this level, `null` = unlimited */
  remainingTokens: bigint | null;
}
export type ReserveDecision =
  { ok: true } | { ok: false; level: string; reason: 'credits' | 'tokens' };
/** A reservation must fit EVERY level (run, project, org day, balance). The first level that cannot hold it is named. */
export function fitsEveryLevel(
  levels: Record<string, BudgetLevel>,
  credits: bigint,
  tokens: bigint,
): ReserveDecision {
  for (const [level, l] of Object.entries(levels)) {
    if (l.remainingCredits !== null && l.remainingCredits < credits)
      return { ok: false, level, reason: 'credits' };
    if (l.remainingTokens !== null && l.remainingTokens < tokens)
      return { ok: false, level, reason: 'tokens' };
  }
  return { ok: true };
}
