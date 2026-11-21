import { validateSchema, type Schema } from '../schema';

/**
 * Validation of the tool calls a model asked for (D-46, SCR-K-10 §4). The model's answer is DATA: a call is executed only if its tool is declared for this request and its
 * arguments satisfy that tool's schema. A call that fails is not an error of the run: it is returned with its reasons so the caller can tell the model (a `tool_result` with
 * `isError`) and let it correct itself, within the run's ceilings. Pure; no tool is run here.
 */
export interface ToolDecl {
  name: string;
  inputSchema: Record<string, unknown>;
}
export interface RequestedCall {
  id: string;
  name: string;
  args: unknown;
}
export interface RejectedCall {
  id: string;
  name: string;
  reasons: string[];
}
export const MAX_REASONS = 5;

export function validateToolCalls(
  declared: readonly ToolDecl[],
  calls: readonly RequestedCall[],
): { valid: RequestedCall[]; rejected: RejectedCall[] } {
  const valid: RequestedCall[] = [];
  const rejected: RejectedCall[] = [];
  const byName = new Map(declared.map((t) => [t.name, t]));
  for (const c of calls) {
    const decl = byName.get(c.name);
    if (!decl) {
      rejected.push({
        id: c.id,
        name: c.name,
        reasons: ['the tool is not declared for this request'],
      });
      continue;
    }
    const errs = validateSchema(decl.inputSchema as Schema, c.args)
      .slice(0, MAX_REASONS)
      .map((e) => `${e.path} ${e.message}`);
    if (errs.length) rejected.push({ id: c.id, name: c.name, reasons: errs });
    else valid.push(c);
  }
  return { valid, rejected };
}
