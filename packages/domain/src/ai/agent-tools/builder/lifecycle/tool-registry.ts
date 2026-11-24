import { projectPathProblem } from '../changeset';
import { sha256Hex } from '../sha256';
import { STEP_DEFS, type StepId } from './steps';

/**
 * The builder tool registry (PHASE-2 S05, ADR-066). One table says what every tool is, who may call it, with which permission, from which step and with which argument limits. Nothing
 * outside this table can be invoked by the lifecycle, and the table is closed:
 *
 *  - `read`             : read-only and pure. The ONLY class a model may be offered (S-AG2); it is also what the runner uses between steps.
 *  - `proposal`         : a structured answer a model returns for a step (files, a repair). It is validated by code and changes nothing; it is not a callable tool of the model.
 *  - `change`           : a change of the project through the validated safe-change pipeline (preview, then apply). Runner only; permission `builder:write`.
 *  - `execution_request`: a REQUEST to the Execution Gateway (S-AG6). The gateway decides; nothing runs here. Runner only; permission `builder:test`.
 *  - `approval_request` : opens a human approval. Runner only. The decision is a person's.
 *
 * No entry executes code, runs a command or reaches a network, and a test (`tool-registry.spec.ts`) fails if a `modelExposed` entry is anything but `read`.
 */
export type ToolClass = 'read' | 'proposal' | 'change' | 'execution_request' | 'approval_request';
export type Caller = 'model' | 'runner';

export interface ToolDef {
  name: string;
  class: ToolClass;
  /** the permission the ACTOR needs (a model has none of its own: the run's user does) */
  permission: string;
  /** offered to a model as a tool; only `read` entries may be */
  modelExposed: boolean;
  /** argument validator: the problems found, or [] */
  validate(args: unknown): string[];
  /** the largest result a caller keeps, in bytes (the rest is cut and says so) */
  maxResultBytes: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const noArgs = (a: unknown): string[] =>
  a === undefined || (isObj(a) && Object.keys(a).length === 0) ? [] : ['takes no arguments'];
const pathArg = (a: unknown, key = 'path'): string[] => {
  if (!isObj(a) || typeof a[key] !== 'string') return [`${key} must be a string`];
  const p = projectPathProblem(a[key] as string);
  return p ? [`${key}: ${p}`] : [];
};
const objArg =
  (...keys: string[]) =>
  (a: unknown): string[] =>
    !isObj(a)
      ? ['arguments must be an object']
      : keys.filter((k) => a[k] === undefined).map((k) => `${k} is required`);

const t = (
  name: string,
  cls: ToolClass,
  permission: string,
  validate: ToolDef['validate'],
  o: { modelExposed?: boolean; maxResultBytes?: number } = {},
): ToolDef => ({
  name,
  class: cls,
  permission,
  validate,
  modelExposed: o.modelExposed ?? false,
  maxResultBytes: o.maxResultBytes ?? 200_000,
});

export const BUILDER_TOOLS: Readonly<Record<string, ToolDef>> = Object.fromEntries(
  [
    t('list_files', 'read', 'builder:read', noArgs, { modelExposed: true }),
    t('read_file', 'read', 'builder:read', (a) => pathArg(a), {
      modelExposed: true,
      maxResultBytes: 100_000,
    }),
    t(
      'find_symbols',
      'read',
      'builder:read',
      (a) => (isObj(a) && typeof a.query === 'string' ? [] : ['query must be a string']),
      { modelExposed: true },
    ),
    t('analyze_imports', 'read', 'builder:read', noArgs, { modelExposed: true }),
    t('list_components', 'read', 'builder:read', noArgs, { modelExposed: true }),
    t('read_memory', 'read', 'builder:read', noArgs, { modelExposed: true }),
    t('analyze_requirements', 'read', 'builder:read', objArg('text')),
    t('choose_architecture', 'read', 'builder:read', objArg('analysis')),
    t('build_plan', 'read', 'builder:read', objArg('analysis')),
    t('derive_tasks', 'read', 'builder:read', objArg('plan')),
    t('review_project', 'read', 'builder:read', noArgs),
    t('diagnose_build', 'read', 'builder:read', objArg('logs')),
    t('prepare_deployment', 'read', 'builder:read', objArg('plan')),
    t('propose_files', 'proposal', 'builder:write', objArg('tasks')),
    t('propose_repair', 'proposal', 'builder:write', objArg('diagnostics')),
    t('preview_change', 'change', 'builder:read', objArg('ops')),
    t('apply_change', 'change', 'builder:write', objArg('ops', 'label')),
    t('request_execution', 'execution_request', 'builder:test', (a) =>
      !isObj(a) || !['typecheck', 'unit-tests', 'build'].includes(String(a.profile))
        ? ['profile must be typecheck, unit-tests or build']
        : [],
    ),
    t('request_deploy_approval', 'approval_request', 'deploy:create', objArg('summary')),
  ].map((d) => [d.name, d]),
);

export const toolNames = (): string[] => Object.keys(BUILDER_TOOLS);
/** the tools a model may be offered: read-only by construction */
export const modelTools = (): string[] =>
  Object.values(BUILDER_TOOLS)
    .filter((d) => d.modelExposed && d.class === 'read')
    .map((d) => d.name);

export interface Actor {
  /** the permissions of the user the run acts for (never of a model) */
  permissions: ReadonlySet<string>;
}
export interface AuthorizeInput {
  tool: string;
  step: StepId;
  caller: Caller;
  actor: Actor;
  args?: unknown;
}
export type DenyCode =
  'unknown_tool' | 'not_in_step' | 'model_not_allowed' | 'permission_denied' | 'invalid_arguments';
export type Authorization =
  { allowed: true; def: ToolDef } | { allowed: false; code: DenyCode; reason: string };

/** Every check, in this order, for every call. A denial is data (recorded and shown), never an exception that ends the run. */
export function authorizeTool(i: AuthorizeInput): Authorization {
  const def = Object.hasOwn(BUILDER_TOOLS, i.tool) ? BUILDER_TOOLS[i.tool] : undefined;
  if (!def) return { allowed: false, code: 'unknown_tool', reason: 'no such tool' };
  if (!STEP_DEFS[i.step].tools.includes(i.tool))
    return { allowed: false, code: 'not_in_step', reason: `${i.tool} is not usable in ${i.step}` };
  if (i.caller === 'model' && !(def.modelExposed && def.class === 'read'))
    return {
      allowed: false,
      code: 'model_not_allowed',
      reason: 'a model may call read-only tools only',
    };
  if (!i.actor.permissions.has(def.permission))
    return {
      allowed: false,
      code: 'permission_denied',
      reason: `permission ${def.permission} is required`,
    };
  const problems = def.validate(i.args);
  if (problems.length > 0)
    return { allowed: false, code: 'invalid_arguments', reason: problems.slice(0, 5).join('; ') };
  return { allowed: true, def };
}

// ---- the invocation lifecycle: requested → authorized | denied → running → succeeded | failed ----------------------------------------------------------------------------------------
export type InvocationStatus = 'denied' | 'running' | 'succeeded' | 'failed';
export interface ToolInvocation {
  /** supplied by the caller (deterministic: `<step>:<n>`), so a replay after a crash finds the same id */
  id: string;
  tool: string;
  step: StepId;
  caller: Caller;
  status: InvocationStatus;
  /** sha256 of the canonical arguments: the audit trail shows WHAT was asked without keeping the arguments */
  argsHash: string;
  startedAt: string;
  finishedAt?: string;
  code?: string;
  /** bytes of the result kept (after the tool's cap) */
  resultBytes?: number;
  truncated?: boolean;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isObj(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  ) ?? 'null';

export function beginInvocation(
  id: string,
  i: AuthorizeInput,
  now: string,
): { invocation: ToolInvocation; authorization: Authorization } {
  const authorization = authorizeTool(i);
  const base = {
    id,
    tool: i.tool,
    step: i.step,
    caller: i.caller,
    argsHash: sha256Hex(canonical(i.args ?? null)),
    startedAt: now,
  };
  return {
    authorization,
    invocation: authorization.allowed
      ? { ...base, status: 'running' }
      : { ...base, status: 'denied', finishedAt: now, code: authorization.code },
  };
}

export function finishInvocation(
  inv: ToolInvocation,
  now: string,
  o: { ok: true; resultBytes: number } | { ok: false; code: string },
): ToolInvocation {
  if (inv.status !== 'running') return inv; // a denied or settled invocation never changes
  if (!o.ok) return { ...inv, status: 'failed', finishedAt: now, code: o.code.slice(0, 60) };
  const cap = BUILDER_TOOLS[inv.tool]?.maxResultBytes ?? 0;
  return {
    ...inv,
    status: 'succeeded',
    finishedAt: now,
    resultBytes: Math.min(o.resultBytes, cap),
    ...(o.resultBytes > cap ? { truncated: true } : {}),
  };
}
