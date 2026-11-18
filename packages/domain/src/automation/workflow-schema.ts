import { ExpressionError, compileExpression, templateExpressions } from './expression';

/**
 * M11 S51: workflow definition = a JSON DAG, validated here (pure; no I/O). Sequential v1 semantics: a step has one successor (`next`),
 * a `condition` has two (`onTrue`/`onFalse`); branches may rejoin. A `loop` runs an inline linear `body` at most `maxIterations` (<= 100) times.
 * Every expression/template is parsed at publish time, so a definition that cannot run is refused before it can be versioned.
 * Secrets never live in a definition: values that look like credentials are refused (use a connector, which holds a vault reference).
 */
export const STEP_TYPES = [
  'http_request',
  'nuzm_api',
  'send_email',
  'start_ai_run',
  'create_deployment',
  'delay',
  'condition',
  'loop',
  'transform',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const LIMITS = {
  maxSteps: 100,
  maxLoopIterations: 100,
  maxLoopBody: 20,
  maxDelaySeconds: 86_400,
  maxDefinitionBytes: 256 * 1024,
  maxRetryAttempts: 10,
} as const;

export interface RetrySpec {
  maxAttempts?: number;
}
export interface StepDef {
  id: string;
  type: StepType;
  name?: string;
  params: Record<string, unknown>;
  next?: string;
  onTrue?: string;
  onFalse?: string;
  retry?: RetrySpec;
  /** Template rendered per execution; the idempotency-key MAPPING that makes a non-idempotent action retryable (sent as `Idempotency-Key`). */
  idempotencyKey?: string;
}
export interface WorkflowDefinition {
  schemaVersion: 1;
  start: string;
  steps: StepDef[];
}
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}
export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Connector ids the definition refers to (the caller checks each is authorized in the org). */
  connectorIds: string[];
  stepCount: number;
}

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SECRETISH_KEY =
  /(secret|password|passwd|token|api[-_]?key|authorization|private[-_]?key|credential)/i;
const SECRETISH_VALUE: RegExp[] = [
  /^\s*(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bnzk_[A-Za-z0-9]{8,}/,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/** HTTP semantics: is this method safe to repeat with the same effect? POST/PATCH are not (unless the user maps an idempotency key). */
export const isIdempotentMethod = (m: string) =>
  ['GET', 'HEAD', 'PUT', 'DELETE'].includes(m.toUpperCase());

/**
 * Is a step retryable automatically? `delay`, `condition`, `transform`, `loop` have no external effect. `start_ai_run`/`create_deployment`/
 * `send_email`/`nuzm_api` POST-like effects go through an idempotency key the ENGINE derives (sha256(executionId|stepId|attempt-group)),
 * so they are idempotent by construction. An `http_request` is idempotent only by method or by a user-supplied key mapping.
 */
export function stepIsIdempotent(s: Pick<StepDef, 'type' | 'params' | 'idempotencyKey'>): boolean {
  switch (s.type) {
    case 'http_request':
      return (
        isIdempotentMethod(String(s.params.method ?? 'GET')) || typeof s.idempotencyKey === 'string'
      );
    // a Nuzm API call always carries the engine's derived Idempotency-Key (docs/04 §1: replay returns the original response)
    default:
      return true;
  }
}

function looksLikeSecret(v: string): boolean {
  return SECRETISH_VALUE.some((re) => re.test(v));
}

function scanSecrets(v: unknown, path: string, out: ValidationIssue[], depth = 0): void {
  if (depth > 12) return;
  if (typeof v === 'string') {
    if (looksLikeSecret(v) && !/^vault:\/\//.test(v))
      out.push({
        code: 'secret_in_definition',
        path,
        message: 'a credential-like value is not allowed in a definition; use a connector',
      });
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => scanSecrets(x, `${path}[${i}]`, out, depth + 1));
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (
        SECRETISH_KEY.test(k) &&
        typeof x === 'string' &&
        x.length > 0 &&
        !/\{\{/.test(x) &&
        !/^vault:\/\//.test(x)
      )
        out.push({
          code: 'secret_in_definition',
          path: `${path}.${k}`,
          message: `'${k}' must not hold a literal credential; use a connector`,
        });
      scanSecrets(x, `${path}.${k}`, out, depth + 1);
    }
}

function checkExpr(
  src: unknown,
  path: string,
  errors: ValidationIssue[],
  roots: Set<string>,
  allowedRoots: readonly string[],
) {
  if (typeof src !== 'string')
    return errors.push({
      code: 'invalid_expression',
      path,
      message: 'an expression must be a string',
    });
  try {
    const c = compileExpression(src);
    for (const r of c.roots)
      if (!allowedRoots.includes(r))
        errors.push({
          code: 'invalid_expression',
          path,
          message: `unknown name '${r}' (allowed: ${allowedRoots.join(', ')})`,
        });
    c.roots.forEach((r) => roots.add(r));
  } catch (e) {
    errors.push({
      code: 'invalid_expression',
      path,
      message: e instanceof ExpressionError ? e.message : 'invalid expression',
    });
  }
}
function checkTemplate(
  v: unknown,
  path: string,
  errors: ValidationIssue[],
  allowedRoots: readonly string[],
  depth = 0,
) {
  if (depth > 8) return;
  if (typeof v === 'string') {
    for (const e of templateExpressions(v)) checkExpr(e, path, errors, new Set(), allowedRoots);
    if ((v.match(/\{\{/g)?.length ?? 0) !== (v.match(/\}\}/g)?.length ?? 0))
      errors.push({ code: 'invalid_expression', path, message: 'unbalanced {{ }}' });
  } else if (Array.isArray(v))
    v.forEach((x, i) => checkTemplate(x, `${path}[${i}]`, errors, allowedRoots, depth + 1));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v))
      checkTemplate(x, `${path}.${k}`, errors, allowedRoots, depth + 1);
}

const BASE_ROOTS = ['input', 'steps', 'trigger', 'execution'] as const;
const LOOP_ROOTS = [...BASE_ROOTS, 'item', 'index'] as const;

function requireString(
  p: Record<string, unknown>,
  k: string,
  path: string,
  errors: ValidationIssue[],
  max = 2000,
) {
  if (typeof p[k] !== 'string' || (p[k] as string).length < 1 || (p[k] as string).length > max)
    errors.push({
      code: 'invalid_params',
      path: `${path}.params.${k}`,
      message: `${k} is required (1..${max} characters)`,
    });
}

function checkStepParams(
  s: StepDef,
  path: string,
  errors: ValidationIssue[],
  connectors: Set<string>,
  inLoop: boolean,
) {
  const p = s.params;
  const roots = inLoop ? LOOP_ROOTS : BASE_ROOTS;
  const connector = () => {
    if (p.connectorId === undefined) return;
    if (typeof p.connectorId !== 'string' || !UUID.test(p.connectorId))
      errors.push({
        code: 'invalid_params',
        path: `${path}.params.connectorId`,
        message: 'connectorId must be a uuid',
      });
    else connectors.add(p.connectorId.toLowerCase());
  };
  switch (s.type) {
    case 'http_request':
      if (!METHODS.includes(String(p.method ?? 'GET').toUpperCase() as (typeof METHODS)[number]))
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.method`,
          message: `method must be one of ${METHODS.join(', ')}`,
        });
      requireString(p, 'url', path, errors);
      if (typeof p.url === 'string' && !/^(https:\/\/|\{\{)/i.test(p.url.trim()))
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.url`,
          message: 'url must be https://',
        });
      if (
        p.headers !== undefined &&
        (typeof p.headers !== 'object' || p.headers === null || Array.isArray(p.headers))
      )
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.headers`,
          message: 'headers must be an object',
        });
      connector();
      break;
    case 'nuzm_api':
      if (!METHODS.includes(String(p.method ?? 'GET').toUpperCase() as (typeof METHODS)[number]))
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.method`,
          message: 'invalid method',
        });
      if (
        typeof p.path !== 'string' ||
        !/^\/v1\/[A-Za-z0-9/_{}.\- ?=&%,:$|'"+*()[\]]*$/.test(p.path) ||
        p.path.includes('..')
      )
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.path`,
          message: 'path must start with /v1/ and contain no ..',
        });
      if (typeof p.connectorId !== 'string')
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.connectorId`,
          message: 'a Nuzm API step needs the first-party connector (connectorId)',
        });
      connector();
      break;
    case 'send_email':
      // M08 `/v1/email/messages` accepts transactional mail only (marketing/bulk is blocked by policy): the action inherits that rule
      requireString(p, 'senderId', path, errors, 200);
      if (!Array.isArray(p.to) || p.to.length < 1 || p.to.length > 50)
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.to`,
          message: 'to must be 1..50 recipients',
        });
      if (p.templateId === undefined) requireString(p, 'subject', path, errors, 998);
      if (p.html === undefined && p.text === undefined && p.templateId === undefined)
        errors.push({
          code: 'invalid_params',
          path: `${path}.params`,
          message: 'one of html, text or templateId is required',
        });
      if (p.category !== undefined && p.category !== 'transactional')
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.category`,
          message: "only the 'transactional' category is allowed",
        });
      break;
    case 'start_ai_run':
      if (!['website', 'webapp', 'mobile', 'edit', 'chat', 'test-fix'].includes(String(p.kind)))
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.kind`,
          message: 'kind is not an AI run kind',
        });
      requireString(p, 'prompt', path, errors, 20_000);
      break;
    case 'create_deployment':
      requireString(p, 'projectId', path, errors, 200);
      if (p.target !== undefined && typeof p.target !== 'object')
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.target`,
          message: 'target must be an object',
        });
      break;
    case 'delay':
      if (
        !Number.isInteger(p.seconds) ||
        (p.seconds as number) < 1 ||
        (p.seconds as number) > LIMITS.maxDelaySeconds
      )
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.seconds`,
          message: `seconds must be an integer 1..${LIMITS.maxDelaySeconds}`,
        });
      break;
    case 'condition':
      checkExpr(p.expr, `${path}.params.expr`, errors, new Set(), roots);
      break;
    case 'transform':
      if (!p.output || typeof p.output !== 'object' || Array.isArray(p.output))
        errors.push({
          code: 'invalid_params',
          path: `${path}.params.output`,
          message: 'output must be an object of templates',
        });
      break;
    case 'loop':
      break; // checked by the caller
  }
  if (s.type !== 'condition') checkTemplate(p, `${path}.params`, errors, roots);
}

export function validateWorkflowDefinition(def: unknown): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const connectors = new Set<string>();
  const bad = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const done = (n: number): ValidationReport => ({
    ok: errors.length === 0,
    errors,
    warnings,
    connectorIds: [...connectors],
    stepCount: n,
  });

  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    bad('invalid_definition', '$', 'definition must be an object');
    return done(0);
  }
  const size = Buffer.byteLength(JSON.stringify(def), 'utf8');
  if (size > LIMITS.maxDefinitionBytes) {
    bad('too_large', '$', `definition is larger than ${LIMITS.maxDefinitionBytes} bytes`);
    return done(0);
  }
  const d = def as Partial<WorkflowDefinition> & Record<string, unknown>;
  for (const k of Object.keys(d))
    if (!['schemaVersion', 'start', 'steps'].includes(k))
      bad('invalid_definition', `$.${k}`, 'unknown property');
  if (d.schemaVersion !== 1)
    bad('invalid_definition', '$.schemaVersion', 'schemaVersion must be 1');
  if (!Array.isArray(d.steps) || d.steps.length < 1) {
    bad('invalid_definition', '$.steps', 'at least one step is required');
    return done(0);
  }
  if (d.steps.length > LIMITS.maxSteps) {
    bad('too_large', '$.steps', `at most ${LIMITS.maxSteps} steps`);
    return done(d.steps.length);
  }
  scanSecrets(d, '$', errors);

  const ids = new Set<string>();
  const top = new Map<string, StepDef>();
  const checkStep = (raw: unknown, path: string, inLoop: boolean): StepDef | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      bad('invalid_step', path, 'a step must be an object');
      return null;
    }
    const s = raw as StepDef & Record<string, unknown>;
    for (const k of Object.keys(s))
      if (
        ![
          'id',
          'type',
          'name',
          'params',
          'next',
          'onTrue',
          'onFalse',
          'retry',
          'idempotencyKey',
          'body',
        ].includes(k)
      )
        bad('invalid_step', `${path}.${k}`, 'unknown property');
    if (typeof s.id !== 'string' || !ID.test(s.id)) {
      bad('invalid_step', `${path}.id`, 'id must match ^[a-z][a-z0-9_]{0,39}$');
      return null;
    }
    if (ids.has(s.id)) bad('duplicate_step_id', `${path}.id`, `duplicate step id '${s.id}'`);
    ids.add(s.id);
    if (!STEP_TYPES.includes(s.type)) {
      bad('invalid_step', `${path}.type`, `type must be one of ${STEP_TYPES.join(', ')}`);
      return s;
    }
    if (inLoop && (s.type === 'loop' || s.type === 'delay'))
      bad('invalid_step', `${path}.type`, `a loop body cannot contain a ${s.type}`);
    if (!s.params || typeof s.params !== 'object' || Array.isArray(s.params)) s.params = {};
    if (s.retry !== undefined) {
      const m = (s.retry as RetrySpec).maxAttempts;
      if (m !== undefined && (!Number.isInteger(m) || m < 1 || m > LIMITS.maxRetryAttempts))
        bad(
          'invalid_step',
          `${path}.retry.maxAttempts`,
          `maxAttempts must be 1..${LIMITS.maxRetryAttempts}`,
        );
    }
    if (s.idempotencyKey !== undefined) {
      if (
        typeof s.idempotencyKey !== 'string' ||
        s.idempotencyKey.length < 1 ||
        s.idempotencyKey.length > 500
      )
        bad('invalid_step', `${path}.idempotencyKey`, 'idempotencyKey must be a template string');
      else
        checkTemplate(
          s.idempotencyKey,
          `${path}.idempotencyKey`,
          errors,
          inLoop ? LOOP_ROOTS : BASE_ROOTS,
        );
    }
    checkStepParams(s, path, errors, connectors, inLoop);
    if (s.type === 'http_request' && !stepIsIdempotent(s))
      warnings.push({
        code: 'non_idempotent',
        path,
        message:
          'this POST/PATCH is not retried automatically unless an idempotencyKey mapping is given',
      });
    return s;
  };

  (d.steps as unknown[]).forEach((raw, i) => {
    const s = checkStep(raw, `$.steps[${i}]`, false);
    if (!s) return;
    top.set(s.id, s);
    if (s.type === 'loop') {
      const p = s.params;
      checkExpr(p.over, `$.steps[${i}].params.over`, errors, new Set(), BASE_ROOTS);
      if (
        !Number.isInteger(p.maxIterations) ||
        (p.maxIterations as number) < 1 ||
        (p.maxIterations as number) > LIMITS.maxLoopIterations
      )
        bad(
          'invalid_params',
          `$.steps[${i}].params.maxIterations`,
          `maxIterations must be an integer 1..${LIMITS.maxLoopIterations}`,
        );
      const body = (s as unknown as { body?: unknown }).body;
      if (!Array.isArray(body) || body.length < 1 || body.length > LIMITS.maxLoopBody)
        bad(
          'invalid_step',
          `$.steps[${i}].body`,
          `a loop needs a body of 1..${LIMITS.maxLoopBody} steps`,
        );
      else body.forEach((b, j) => checkStep(b, `$.steps[${i}].body[${j}]`, true));
    }
  });
  if (errors.some((e) => e.code === 'duplicate_step_id')) return done(top.size);

  // graph
  const edges = (s: StepDef): string[] =>
    (s.type === 'condition' ? [s.onTrue, s.onFalse] : [s.next]).filter(
      (x): x is string => typeof x === 'string',
    );
  if (typeof d.start !== 'string' || !top.has(d.start))
    bad('invalid_graph', '$.start', 'start must name a step');
  for (const s of top.values()) {
    if (s.type === 'condition') {
      if (!s.onTrue && !s.onFalse)
        bad('invalid_graph', `$.steps.${s.id}`, 'a condition needs onTrue and/or onFalse');
      if (s.next !== undefined)
        bad('invalid_graph', `$.steps.${s.id}.next`, 'a condition uses onTrue/onFalse, not next');
    } else if (s.onTrue !== undefined || s.onFalse !== undefined)
      bad('invalid_graph', `$.steps.${s.id}`, 'onTrue/onFalse are only for conditions');
    for (const e of edges(s))
      if (!top.has(e)) bad('invalid_graph', `$.steps.${s.id}`, `unknown successor '${e}'`);
  }
  if (errors.some((e) => e.code === 'invalid_graph')) return done(top.size);
  // cycle detection (iterative DFS, three colours) + reachability
  const colour = new Map<string, 0 | 1 | 2>();
  const stack: { id: string; i: number }[] = [];
  const reachable = new Set<string>();
  const visit = (root: string) => {
    stack.push({ id: root, i: 0 });
    colour.set(root, 1);
    reachable.add(root);
    while (stack.length) {
      const top_ = stack[stack.length - 1]!;
      const succ = edges(top.get(top_.id)!);
      if (top_.i < succ.length) {
        const n = succ[top_.i++]!;
        const c = colour.get(n) ?? 0;
        if (c === 1) {
          bad(
            'cycle',
            `$.steps.${top_.id}`,
            `the graph has a cycle through '${n}' (use a loop step for repetition)`,
          );
          return;
        }
        if (c === 0) {
          colour.set(n, 1);
          reachable.add(n);
          stack.push({ id: n, i: 0 });
        }
      } else {
        colour.set(top_.id, 2);
        stack.pop();
      }
    }
  };
  if (typeof d.start === 'string' && top.has(d.start)) visit(d.start);
  for (const id of top.keys())
    if (!reachable.has(id) && !errors.some((e) => e.code === 'cycle'))
      bad('unreachable_step', `$.steps.${id}`, `step '${id}' cannot be reached from start`);
  return done(top.size);
}

/** Parse the validated definition into a typed object (call only after `validateWorkflowDefinition(...).ok`). */
export const asDefinition = (def: unknown): WorkflowDefinition => def as WorkflowDefinition;

/** Step by id, including loop-body steps. */
export function indexSteps(def: WorkflowDefinition): Map<string, StepDef & { body?: StepDef[] }> {
  const m = new Map<string, StepDef & { body?: StepDef[] }>();
  for (const s of def.steps) {
    m.set(s.id, s as StepDef & { body?: StepDef[] });
    const body = (s as unknown as { body?: StepDef[] }).body;
    if (body) for (const b of body) m.set(b.id, b);
  }
  return m;
}
