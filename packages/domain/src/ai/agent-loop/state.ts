import { AGENT_LOOP_LIMITS, type AgentLoopLimits } from './limits';

/** The phases of the loop: plan, explore, propose, validate, apply (ADR-066), and `fallback` when it hands over to the single call. */
export type LoopPhase = 'plan' | 'explore' | 'propose' | 'validate' | 'apply' | 'fallback';

export interface LoopCounters {
  /** model turns made so far */
  turns: number;
  /** tool calls requested so far */
  toolCalls: number;
  /** input plus output tokens of the loop's model calls so far */
  tokens: number;
  /** invalid proposals answered so far */
  repairs: number;
  /** epoch milliseconds of the first turn */
  startedAtMs: number;
}
export const newCounters = (nowMs: number): LoopCounters => ({
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  repairs: 0,
  startedAtMs: nowMs,
});

export type CeilingReason = 'turns' | 'time' | 'tokens';

/** Which ceiling, if any, stops the loop BEFORE its next model turn. Pure: the caller supplies the clock. */
export function ceilingReached(
  c: LoopCounters,
  nowMs: number,
  limits: AgentLoopLimits = AGENT_LOOP_LIMITS,
): CeilingReason | null {
  if (c.turns >= limits.maxTurns) return 'turns';
  if (nowMs - c.startedAtMs >= limits.maxMinutes * 60_000) return 'time';
  if (c.tokens >= limits.maxTokens) return 'tokens';
  return null;
}

/** The phase a model turn belongs to: the first turn that explores is the plan; a turn without tool calls is the proposal; the others explore. */
export function turnPhase(turn: number, hadToolCalls: boolean): LoopPhase {
  if (!hadToolCalls) return 'propose';
  return turn === 1 ? 'plan' : 'explore';
}

/** Whether the next turn must be a proposal (no tools offered): the tool budget is gone, or only the last turn(s) remain. */
export function mustPropose(
  c: LoopCounters,
  toolsExhausted: boolean,
  limits: AgentLoopLimits = AGENT_LOOP_LIMITS,
): boolean {
  return toolsExhausted || c.turns >= limits.maxTurns - 1;
}
