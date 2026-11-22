/** Pure helpers of the read-only agent timeline (S-AG3). No I/O: unit-tested in `agent-timeline.spec.ts`. Everything shown is the customer's own run data; nothing here can start, change or run anything. */
import type { MessageKey } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';

/** Per organization, default off (ADR-066): while it is off the option to start the agent is not offered and the API answers 422 to it. */
export const AGENTIC_FLAG = 'knowledge.agentic_generation';

export type Timeline = Schemas['BuilderAgentTimeline'];
export type TimelineStep = Schemas['BuilderAgentStep'];
export type TimelineCall = Schemas['BuilderAgentToolCall'];

const MODES = ['NONE', 'SINGLE_CALL', 'AGENTIC', 'AGENTIC_FELL_BACK'] as const;
const RUN_STATES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
] as const;
const PHASES = ['plan', 'explore', 'propose', 'validate', 'apply', 'fallback'] as const;
const STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'waiting_approval',
  'skipped',
  'cancelled',
] as const;
const CALL_STATUSES = ['succeeded', 'failed', 'denied', 'waiting_approval'] as const;
const FALLBACKS = [
  'agentic_disabled',
  'tools_unavailable',
  'no_tool_capable_model',
  'provider_error',
  'invalid_proposal',
  'ceiling_turns',
  'ceiling_time',
  'ceiling_tokens',
] as const;
export const LIMIT_NAMES = ['turns', 'toolCalls', 'resultBytes', 'tokens', 'seconds'] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];

/** A known value gets its own sentence; anything else is "unknown", never raw text from the server. */
function known<T extends string>(prefix: string, list: readonly T[], v: unknown): MessageKey {
  return (list.includes(v as T) ? `${prefix}.${v as string}` : `${prefix}.UNKNOWN`) as MessageKey;
}
export const modeKey = (v: unknown) => known('agt.mode', MODES, v);
export const stateKey = (v: unknown) => known('agt.state', RUN_STATES, v);
export const phaseKey = (v: unknown) => known('agt.phase', PHASES, v);
export const stepStatusKey = (v: unknown) => known('agt.stepStatus', STEP_STATUSES, v);
export const callStatusKey = (v: unknown) => known('agt.callStatus', CALL_STATUSES, v);
export const fallbackKey = (v: unknown) => known('agt.fallback', FALLBACKS, v);
export const limitKey = (n: LimitName): MessageKey => `agt.limit.${n}` as MessageKey;

/** Whole percent of a limit, bounded; never NaN, never above 100. */
export function limitPct(l: { used?: unknown; max?: unknown } | undefined): number {
  const used = Number(l?.used);
  const max = Number(l?.max);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
}

/** A byte count for people: 0 B, 1.5 KB, 2.0 MB. */
export function bytesLabel(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** The arguments of a tool call as one short line (they are already redacted by the server; this only bounds them). */
export function argsLine(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const s = Object.entries(args as Record<string, unknown>)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/** Only a valid timeline of the expected shape is shown; anything else is an error state, not a half-rendered page. */
export function isTimeline(v: unknown): v is Timeline {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.planId === 'string' &&
    typeof t.mode === 'string' &&
    Array.isArray(t.steps) &&
    !!t.limits &&
    typeof t.limits === 'object'
  );
}

/** Still moving: the timeline is worth polling. */
export const isLive = (t: Timeline | null): boolean =>
  !!t && (t.runState === 'queued' || t.runState === 'running' || t.runState === 'waiting_approval');
