/** Pure helpers of the template workspace screen (S-K6: comparison with the template copy, the context preview, the adaptation run). No I/O: unit-tested in `generation.spec.ts`. */
import type { MessageKey } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { problemKey, type BuilderProblem } from './builder';

/** Per organization, default off (ADR-065 addendum H): while it is off the page says "not available" and the API answers 404. */
export const GENERATION_FLAG = 'knowledge.generation';

export type Workspace = Schemas['BuilderTemplateWorkspace'];
export type Diff = Schemas['BuilderWorkspaceDiff'];
export type ContextPreview = Schemas['BuilderGenerationContext'];
export type Plan = Schemas['BuilderGenerationPlan'];

export const PLAN_STATUSES = ['PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const EXCLUDE_REASONS = [
  'ai_processing_not_allowed',
  'too_large',
  'over_budget',
  'too_many_files',
  'not_text',
] as const;

/** A known status gets its own sentence; anything else is shown as "unknown", never as raw text. */
export const statusKey = (s: unknown): MessageKey =>
  (PLAN_STATUSES as readonly string[]).includes(String(s))
    ? (`gen.plan.status.${s as string}` as MessageKey)
    : 'gen.plan.status.UNKNOWN';

export const reasonKey = (r: unknown): MessageKey =>
  (EXCLUDE_REASONS as readonly string[]).includes(String(r))
    ? (`gen.ctx.reason.${r as string}` as MessageKey)
    : 'gen.ctx.reason.UNKNOWN';

/** The execution state of a plan as the API reports it (READY, BLOCKED, or the run's own status). */
export function executionOf(plan: Plan | null): { status: string; runId: string | null } {
  const ex = (plan?.plan as { execution?: { status?: unknown; runId?: unknown } } | undefined)
    ?.execution;
  return {
    status: typeof ex?.status === 'string' ? ex.status : 'BLOCKED',
    runId: typeof ex?.runId === 'string' ? ex.runId : null,
  };
}

/** A refusal while creating a plan or starting its run, by code. */
export function generationProblemKey(p: BuilderProblem): MessageKey {
  if (p.status === 409 && p.code !== 'idempotency_in_progress') return 'gen.err.conflict';
  return problemKey(p);
}

/** Whole percent, bounded; never NaN. */
export const pct = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;

/** The request of a plan: only a non-empty text of at most 2000 characters is a requirement. */
export function planBody(i: {
  projectId: string;
  text: string;
  mode: string;
}): Record<string, unknown> | null {
  const text = i.text.trim().slice(0, 2000);
  if (!text) return null;
  return {
    projectId: i.projectId,
    text,
    platform: 'WEB',
    mode: ['STRICT', 'ADAPTIVE', 'CREATIVE'].includes(i.mode) ? i.mode : 'ADAPTIVE',
  };
}
