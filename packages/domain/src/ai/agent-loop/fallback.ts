/**
 * Why the loop handed over to the single-call adaptation (S-K6). A fallback never gives the loop's work more power than the loop had: nothing was applied before it (the loop applies
 * only at its very end), the same safety checks apply, and the run's budget is the same budget.
 */
export type FallbackReason =
  | 'agentic_disabled'
  | 'tools_unavailable'
  | 'no_tool_capable_model'
  | 'provider_error'
  | 'invalid_proposal'
  | 'ceiling_turns'
  | 'ceiling_time'
  | 'ceiling_tokens';

export const FALLBACK_REASONS: readonly FallbackReason[] = [
  'agentic_disabled',
  'tools_unavailable',
  'no_tool_capable_model',
  'provider_error',
  'invalid_proposal',
  'ceiling_turns',
  'ceiling_time',
  'ceiling_tokens',
];

/**
 * What the loop does with an error code of the model gateway. A model that cannot call tools or a provider that is failing → fall back to the single call. Everything that is a decision
 * of the platform or the owner (budget, credits, kill switch, residency, data terms, content and secret blocks, a cancelled call) is final: the run fails honestly and nothing else is tried.
 */
export function classifyGatewayError(
  code: string,
): { action: 'fallback'; reason: FallbackReason } | { action: 'fail' } {
  if (code === 'unsupported_capability')
    return { action: 'fallback', reason: 'no_tool_capable_model' };
  if (code === 'service_unavailable') return { action: 'fallback', reason: 'provider_error' };
  return { action: 'fail' };
}

export const ceilingFallback = (r: 'turns' | 'time' | 'tokens'): FallbackReason => `ceiling_${r}`;
