import type { Db } from '@nuzm/platform';
import { DSR_TYPES, type ReasonCode, type Subject } from './types';

/** What a module needs to answer a data-subject request about one subject in one organization. */
export interface HandlerCtx {
  orgId: string;
  subject: Subject;
  now: Date;
  db: Db;
}
export type HandlerResult =
  | { outcome: 'done'; summary: Record<string, string | number | boolean | null>; data?: unknown }
  | { outcome: 'not_applicable'; summary: Record<string, never> }
  | {
      outcome: 'refused';
      reason: ReasonCode;
      summary: Record<string, string | number | boolean | null>;
    };

/**
 * Each module that holds personal data registers one handler (docs/10 §4). `export` reads; `erase` removes what may be removed and REFUSES with a reason
 * what must stay (mandatory retention); `rectify` applies a limited patch. Handlers must be idempotent: a task may run again after a crash.
 */
export interface DsrHandler {
  readonly name: string;
  /** `schema.table` datasets the handler touches: a legal hold on any of them blocks its erasure. */
  readonly datasets: readonly string[];
  export(ctx: HandlerCtx): Promise<HandlerResult>;
  erase(ctx: HandlerCtx): Promise<HandlerResult>;
  rectify(ctx: HandlerCtx, patch: Record<string, unknown>): Promise<HandlerResult>;
}

/** The registry later milestones add their handlers to (M05+ each register theirs). */
export class DsrRegistry {
  private readonly list = new Map<string, DsrHandler>();
  register(h: DsrHandler) {
    if (this.list.has(h.name)) throw new Error(`DSR handler ${h.name} is already registered`);
    this.list.set(h.name, h);
  }
  all(): DsrHandler[] {
    return [...this.list.values()];
  }
  get(name: string) {
    return this.list.get(name);
  }
}
export const NOT_APPLICABLE: HandlerResult = { outcome: 'not_applicable', summary: {} };
export const refused = (
  reason: ReasonCode,
  summary: Record<string, string | number | boolean | null> = {},
): HandlerResult => ({ outcome: 'refused', reason, summary });
export const done = (
  summary: Record<string, string | number | boolean | null>,
  data?: unknown,
): HandlerResult => ({ outcome: 'done', summary, ...(data !== undefined ? { data } : {}) });
export { DSR_TYPES };
