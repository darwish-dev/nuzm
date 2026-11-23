/**
 * Ceilings of the agent loop (D-46, SCR-K-10 §5). They bound ONE run; the run's own budget (tokens, credits, set at creation) and the tool gateway's per-run limits (60 calls, 400 000
 * result bytes) apply as well. Reaching a loop ceiling never throws the run away: the loop stops and falls back to the single-call adaptation (which applies the same safety checks).
 */
export const AGENT_LOOP_LIMITS = {
  /** model turns, repairs of an invalid proposal included */
  maxTurns: 12,
  /** invalid proposals answered with feedback before the loop gives up and falls back */
  maxRepairs: 2,
  /** wall-clock minutes from the first turn (kept across a resume) */
  maxMinutes: 10,
  /** input plus output tokens of the loop's own model calls */
  maxTokens: 400_000,
  /** the output ceiling of one turn */
  maxCompletionTokens: 16_000,
  /** the plan text kept for the customer's timeline */
  planChars: 500,
} as const;
export type AgentLoopLimits = { -readonly [K in keyof typeof AGENT_LOOP_LIMITS]: number };
