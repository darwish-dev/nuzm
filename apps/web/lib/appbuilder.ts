/** Pure helpers of the app-builder screens (UI-M10-01..11). No I/O: unit-tested in `builder.spec.ts`. */
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { problemOf, type ProblemInfo, type Tone } from './data';

export const APP_BUILDER_FLAG = 'app_builder.enabled';
/** the AI capability the builder API is gated on (`AiEnabledGuard` answers 404 for every builder route while it is off) */
export const AI_FLAG = 'ai.enabled';

const flagOn = (flags: unknown, key: string): boolean => {
  const v = (flags as Record<string, unknown> | null | undefined)?.[key];
  return (
    v === true ||
    (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true)
  );
};

/**
 * Which capability an organization lacks for the builder screens, in the order a person would fix it: the app builder itself, then the AI capability the builder API also requires
 * (DEFECT-20d: the gate used to look only at the first and let the API's 404 say "app builder not enabled" for the second). `null`: both are on.
 */
export function missingBuilderCapability(flags: unknown): 'app_builder' | 'ai' | null {
  if (!flagOn(flags, APP_BUILDER_FLAG)) return 'app_builder';
  if (!flagOn(flags, AI_FLAG)) return 'ai';
  return null;
}

/** Ceilings of a run (M10 §9, PROPOSED limits): shown as limits, enforced by the API before every model call. */
export const CEILINGS = {
  maxTokens: 2_000_000,
  maxMinutes: 60,
  maxSteps: 200,
  warnAtPct: 80,
} as const;
/** What the wizard starts with when the budgets endpoint is not readable for the member. */
export const DEFAULT_BUDGET = {
  maxTokens: 1_000_000,
  maxCostMinor: 50_000,
  maxMinutes: 30,
} as const;
export const APP_LOCALES = ['ar', 'en'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export type Run = {
  id: string;
  kind: string;
  projectId?: string | null;
  state: string;
  [k: string]: unknown;
};
export type Approval = Schemas['Approval'];
export type Sandbox = Schemas['Sandbox'];
export type TestRun = Schemas['TestRun'];
export type Deployment = Schemas['Deployment'];
export type ExportRow = Schemas['Export'];

/* ------------------------------------------------------------------ settle / problems */

export interface Res<T> {
  data?: T;
  error?: unknown;
  response: { ok: boolean; status: number };
}

/** A call that never throws: a network failure becomes status 0 (the screens call it "offline"). */
export async function settle<T>(call: () => Promise<Res<T>>): Promise<Res<T>> {
  try {
    return await call();
  } catch {
    return { response: { ok: false, status: 0 }, error: {} };
  }
}

export interface ApprovalRef {
  id: string;
  type: string;
  scopeHash: string;
}

/** The approvals a 403 `approval_required` lists (`approvals:[{id,type,scopeHash}]`); anything malformed is dropped. */
export function approvalsOf(error: unknown): ApprovalRef[] {
  const list = (error as { approvals?: unknown } | null | undefined)?.approvals;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .filter((x) => typeof x.id === 'string' && typeof x.scopeHash === 'string')
    .map((x) => ({
      id: x.id as string,
      type: typeof x.type === 'string' ? x.type : '',
      scopeHash: x.scopeHash as string,
    }));
}

/** Text from the API that is shown to a person: long token-like runs are masked so that a value the service quotes can never reach the screen. */
export function safeText(v: unknown, max = 200): string {
  if (typeof v !== 'string') return '';
  return (
    v
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[REDACTED]')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, max)
  );
}

export interface FieldProblem {
  field: string;
  message: string;
}
/** `errors[]` of a 422 problem as `{field, message}` (the field is `path` or `field`); messages go through `safeText`. */
export function fieldProblems(error: unknown): FieldProblem[] {
  const list = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      field: safeText(typeof x.path === 'string' ? x.path : x.field, 120),
      message: safeText(x.message),
    }))
    .filter((x) => x.field || x.message);
}

const BY_CODE: Record<string, MessageKey> = {
  budget_required: 'm10.err.budgetRequired',
  unsupported_capability: 'm10.err.unsupported',
  residency_denied: 'm10.err.residency',
  sandbox_quota_exceeded: 'm10.err.sandboxQuota',
  sandbox_no_capacity: 'm10.err.sandboxCapacity',
  base_mismatch: 'm10.err.baseMismatch',
  change_rejected: 'm10.err.changeRejected',
  dependency_blocked: 'm10.err.dependencyBlocked',
  stale_approval_hash: 'm10.err.staleApproval',
  gone: 'm10.err.expired',
  approval_required: 'm10.err.approvalRequired',
  invalid_state: 'm10.err.invalidState',
  health_gate_failed: 'm10.err.healthGate',
  export_blocked: 'm10.err.exportBlocked',
  test_suite_unavailable: 'm10.err.suiteUnavailable',
  run_budget_exceeded: 'm10.err.runBudget',
  egress_denied: 'm10.err.egressDenied',
  step_up_required: 'm8.err.stepUp',
  rate_limited: 'm8.err.rate',
};

/** Plain-language message for a failed app-builder call (never the raw problem text); `detail` carries the service's own reason for an unsupported option. */
export function builderError(locale: Locale, p: ProblemInfo): { text: string; detail?: string } {
  if (p.status === 0) return { text: t(locale, 'm10.err.offline') };
  const key = p.code ? BY_CODE[p.code] : undefined;
  if (key)
    return {
      text: t(locale, key),
      detail: p.code === 'unsupported_capability' ? safeText(p.detail) || undefined : undefined,
    };
  if (p.status === 404) return { text: t(locale, 'm10.err.notEnabledOrMissing') };
  if (p.status === 403) return { text: t(locale, 'state.forbidden.title') };
  if (p.status === 410) return { text: t(locale, 'm10.err.expired') };
  if (p.status === 402) return { text: t(locale, 'm10.err.budgetRequired') };
  if (p.status === 409) return { text: t(locale, 'err.conflict') };
  if (p.status === 422) return { text: t(locale, 'err.validation') };
  if (p.status === 429) return { text: t(locale, 'm8.err.rate') };
  if (p.status === 503) return { text: t(locale, 'm10.err.sandboxCapacity') };
  return { text: t(locale, 'state.error.title') };
}

export { problemOf };

/* ------------------------------------------------------------------ wizard (UI-M10-01) */

/** A positive integer up to `max`, or null (no signs, decimals or separators). */
export function parsePositiveInt(v: string, max: number): number | null {
  const s = v.trim();
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

/** SAR written by a person ("500", "12.5", "12.50") to integer halalas, without floating point. null when not a positive amount with at most two decimals. */
export function sarToMinor(v: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return minor > 0 ? minor : null;
}

/** Integer halalas as an editable SAR figure with two decimals ("500.00"), integer arithmetic only. */
export function minorToSar(minor: number): string {
  const n = Math.max(0, Math.trunc(minor));
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

export interface BudgetInput {
  tokens: string;
  cost: string;
  minutes: string;
}
export type BudgetErrors = Partial<Record<keyof BudgetInput, MessageKey>>;
/** Budget fields → the `budget` of POST /v1/ai/runs, or the field errors. Tokens and minutes are held to the ceilings. */
export function validateBudget(
  i: BudgetInput,
):
  | { ok: true; budget: { maxTokens: number; maxCostMinor: number; maxMinutes: number } }
  | { ok: false; errors: BudgetErrors } {
  const errors: BudgetErrors = {};
  const maxTokens = parsePositiveInt(i.tokens, CEILINGS.maxTokens);
  const maxCostMinor = sarToMinor(i.cost);
  const maxMinutes = parsePositiveInt(i.minutes, CEILINGS.maxMinutes);
  if (maxTokens === null) errors.tokens = 'm10.wiz.err.tokens';
  if (maxCostMinor === null) errors.cost = 'm10.wiz.err.cost';
  if (maxMinutes === null) errors.minutes = 'm10.wiz.err.minutes';
  if (maxTokens === null || maxCostMinor === null || maxMinutes === null)
    return { ok: false, errors };
  return { ok: true, budget: { maxTokens, maxCostMinor, maxMinutes } };
}

/** Names typed one per line (or separated by commas): trimmed, de-duplicated (case-insensitive), empty lines dropped. */
export function splitNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,،]+/)) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}
/** An entity or role name: 1..60 characters, no control characters or angle brackets. */
export const validName = (v: string) =>
  // eslint-disable-next-line no-control-regex
  v.length >= 1 && v.length <= 60 && !/[\u0000-\u001f\u007f<>]/.test(v);
/**
 * How much a customer may write to the AI builder: the first description of a project and one follow-up message. The API holds the same numbers
 * (`PROMPT_LIMITS` in packages/domain; a test keeps them equal). Over the limit is an error shown to the person, never a silent cut (no `maxLength` on these boxes).
 */
export const PROJECT_PROMPT_MAX = 30_000;
export const CHAT_MESSAGE_MAX = 20_000;

/** A name for the new project, taken from the first line of the prompt (80 characters at most). */
export function projectNameFrom(prompt: string): string {
  const first = prompt.trim().split(/\n/)[0] ?? '';
  const s = first.replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || 'App';
}

/* ------------------------------------------------------------------ runs (UI-M10-06) */

export const LIVE_RUN_STATES = ['queued', 'running', 'waiting_approval'] as const;
export const isLiveRun = (state: string) => (LIVE_RUN_STATES as readonly string[]).includes(state);

export function runTone(state: string): Tone {
  if (state === 'succeeded') return 'success';
  if (state === 'failed' || state === 'budget_exceeded') return 'danger';
  if (state === 'waiting_approval' || state === 'cancelled') return 'warn';
  return undefined;
}

export type MeterLevel = 'ok' | 'warn' | 'exceeded';
/** 0..100 (integer) share of `max` used; 0 when there is no usable limit. */
export function percentUsed(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0 || used <= 0) return 0;
  return Math.min(100, Math.round((used / max) * 100));
}
/** `warn` from 80 % (the warning of M10 §9), `exceeded` at 100 %. */
export const meterLevel = (pct: number): MeterLevel =>
  pct >= 100 ? 'exceeded' : pct >= CEILINGS.warnAtPct ? 'warn' : 'ok';

export interface RunMeter {
  key: 'tokens' | 'cost' | 'minutes';
  used: number;
  max: number;
  pct: number;
  level: MeterLevel;
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The three budget meters of a run from its budget, usage and `budgetRemaining` (minutes used = limit − remaining). */
export function runMeters(run: Pick<Run, 'budget' | 'usage' | 'budgetRemaining'>): RunMeter[] {
  const b = run.budget as Record<string, unknown>;
  const u = run.usage as Record<string, unknown>;
  const r = (run.budgetRemaining ?? {}) as Record<string, unknown>;
  const maxMinutes = num(b.maxMinutes);
  const rows: [RunMeter['key'], number, number][] = [
    ['tokens', num(u.tokensIn) + num(u.tokensOut), num(b.maxTokens)],
    ['cost', num(u.costMinor), num(b.maxCostMinor)],
    ['minutes', r.minutes === undefined ? 0 : Math.max(0, maxMinutes - num(r.minutes)), maxMinutes],
  ];
  return rows.map(([key, used, max]) => {
    const pct = percentUsed(used, max);
    return { key, used, max, pct, level: meterLevel(pct) };
  });
}
/** The run is at or over the warning line on any meter (or the server says so). */
export const runWarns = (
  run: Pick<Run, 'budget' | 'usage' | 'budgetRemaining'> & { warn?: boolean },
) => run.warn === true || runMeters(run).some((m) => m.level !== 'ok');

/** Argument values whose key names a secret are never shown, even if a service sent them (the API redacts first; this is a second line). */
const SECRET_KEY =
  /(secret|token|passw|authorization|api[-_]?key|credential|private[-_]?key|cookie)/i;
export function maskSecrets(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskSecrets(x, depth + 1));
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .slice(0, 50)
        .map(([k, x]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : maskSecrets(x, depth + 1)]),
    );
  return typeof v === 'string' ? safeText(v, 500) : v;
}
/** Pretty JSON of an action or tool-call summary for display (secrets masked, cut at `max` characters). */
export function prettyJson(v: unknown, max = 6000): string {
  let s: string;
  try {
    s = JSON.stringify(maskSecrets(v), null, 2) ?? '';
  } catch {
    s = '';
  }
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

/* ------------------------------------------------------------------ approvals (UI-M10-07) */

export type ApprovalType = Approval['type'];
export const APPROVAL_TYPES: ApprovalType[] = [
  'production_deploy',
  'production_rollback',
  'data_migration_rollback',
  'destructive_migration',
  'paid_resource',
  'egress_or_dependency',
  'budget_increase',
  'export_third_party',
  'mobile_signing',
  'release_owner',
];
/** Which role may decide which approval type (M10 §9). The API stays the authority: it answers 403 for any other role. */
export const APPROVAL_ROLES: Record<ApprovalType, readonly string[]> = {
  production_deploy: ['owner', 'admin'],
  production_rollback: ['owner', 'admin'],
  data_migration_rollback: ['owner', 'admin'],
  destructive_migration: ['owner', 'admin'],
  export_third_party: ['owner', 'admin'],
  mobile_signing: ['owner', 'admin'],
  paid_resource: ['owner', 'admin', 'billing_admin'],
  egress_or_dependency: ['owner', 'admin', 'developer'],
  budget_increase: ['owner', 'admin', 'billing_admin'],
  release_owner: ['owner'],
};
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export function approvalTone(status: string): Tone {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'pending' || status === 'expired') return 'warn';
  return undefined;
}
/** Pending but past its 24 h expiry (the list may not have been refreshed): it can no longer be decided. */
export const approvalLapsed = (a: Pick<Approval, 'status' | 'expiresAt'>, now = Date.now()) =>
  a.status === 'expired' || (a.status === 'pending' && Date.parse(a.expiresAt) <= now);

/** The decision error of an approval: stale hash → reload, 410 → expired, 403 → role of the approval type. */
export function decisionErrorKey(status: number, code?: string): MessageKey {
  if (code === 'stale_approval_hash') return 'm10.apr.err.stale';
  if (status === 410 || code === 'gone') return 'm10.apr.err.expired';
  if (status === 403) return 'm10.apr.err.role';
  if (status === 409) return 'm10.apr.err.decided';
  if (status === 404) return 'm10.err.notEnabledOrMissing';
  return 'state.error.title';
}

/* ------------------------------------------------------------------ sandboxes (UI-M10-03/04) */

export type Runtime = { kind?: string; isolation?: string } | null | undefined;
/** Only `isolation: verified` is isolated. Until D-21/HG-10-02 the API never answers it: every sandbox is a development stand-in. */
export const isIsolated = (rt: Runtime) => rt?.isolation === 'verified';
export const sandboxTone = (state: string): Tone =>
  state === 'ready'
    ? 'success'
    : state === 'failed'
      ? 'danger'
      : state === 'starting' || state === 'terminating'
        ? 'warn'
        : undefined;
export const sandboxUsable = (state: string) => state === 'ready' || state === 'starting';

/* ------------------------------------------------------------------ files (UI-M10-03) */

export interface TreeNode {
  name: string;
  /** Full project path (files only). */
  path?: string;
  size?: number;
  children: TreeNode[];
}
/** The file list as a tree: directories first, then files, each group sorted by name. */
export function buildTree(files: { path?: string; size?: number }[]): TreeNode[] {
  const root: TreeNode = { name: '', children: [] };
  for (const f of files) {
    if (typeof f.path !== 'string' || !safeRelPath(f.path)) continue;
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let next = cur.children.find(
        (c) => c.name === part && (last ? c.path !== undefined : c.path === undefined),
      );
      if (!next) {
        next = last
          ? { name: part, path: f.path, size: f.size, children: [] }
          : { name: part, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      const ad = a.path === undefined ? 0 : 1;
      const bd = b.path === undefined ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/* ------------------------------------------------------------------ changes (UI-M10-05) */

export const PATCH_OPS = ['add', 'modify', 'delete', 'rename'] as const;
export type PatchOp = (typeof PATCH_OPS)[number];
export interface PatchInput {
  op: PatchOp;
  path: string;
  content: string;
  from: string;
  expectedHash: string;
}
/** A project-relative path: no leading slash, drive letter, backslash, NUL or `..` segment (the API checks again and answers 422 `change_rejected`). */
export function safeRelPath(p: string): boolean {
  if (p.length < 1 || p.length > 300) return false;
  // eslint-disable-next-line no-control-regex
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\') || /[\u0000-\u001f]/.test(p))
    return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');
}
export type PatchErrors = Partial<Record<keyof PatchInput, MessageKey>>;
export const isSha256 = (v: string) => /^[0-9a-f]{64}$/.test(v);
/** The patch of the compose form, or its field errors. `modify`/`delete`/`rename` need the hash of the content the patch is written against. */
export type AppPatch = {
  op: 'add' | 'modify' | 'delete' | 'rename';
  path: string;
  content?: string;
  from?: string;
  expectedHash?: string;
};
export function buildPatch(
  i: PatchInput,
): { ok: true; patch: AppPatch } | { ok: false; errors: PatchErrors } {
  const errors: PatchErrors = {};
  if (!safeRelPath(i.path)) errors.path = 'm10.chg.err.path';
  if ((i.op === 'add' || i.op === 'modify') && i.content.length === 0)
    errors.content = 'm10.chg.err.content';
  if (i.content.length > 900_000) errors.content = 'm10.chg.err.contentSize';
  if (i.op === 'rename' && !safeRelPath(i.from)) errors.from = 'm10.chg.err.from';
  if (i.op !== 'add' && !isSha256(i.expectedHash.trim().toLowerCase()))
    errors.expectedHash = 'm10.chg.err.hash';
  if (Object.keys(errors).length) return { ok: false, errors };
  const patch: AppPatch = { op: i.op, path: i.path };
  if (i.op === 'add' || i.op === 'modify') patch.content = i.content;
  if (i.op === 'rename') patch.from = i.from;
  if (i.op !== 'add') patch.expectedHash = i.expectedHash.trim().toLowerCase();
  return { ok: true, patch };
}

/** sha256 (hex) of UTF-8 text, for the "use the hash of the file I am looking at" helper. null when the browser has no SubtleCrypto. */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DiffView {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
}
/** The `diff` of a change result without trusting its shape. */
export function diffOf(diff: unknown): DiffView {
  const d = (diff ?? {}) as Record<string, unknown>;
  const strs = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => safeText(x, 300))
      : [];
  return {
    added: strs(d.added),
    modified: strs(d.modified),
    deleted: strs(d.deleted),
    renamed: Array.isArray(d.renamed)
      ? d.renamed
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .map((x) => ({ from: safeText(x.from, 300), to: safeText(x.to, 300) }))
      : [],
  };
}

/* ------------------------------------------------------------------ test runs (UI-M10-08) */

export function testTone(status: string): Tone {
  if (status === 'passed') return 'success';
  if (status === 'failed' || status === 'errored') return 'danger';
  if (status === 'queued' || status === 'running' || status === 'cancelled') return 'warn';
  return undefined;
}
export const isLiveTest = (status: string) => status === 'queued' || status === 'running';

export interface CaseView {
  suite: string;
  name: string;
  status: string;
  failure?: string;
}
export interface SuiteView {
  suite: string;
  status: string;
  tests: number;
  failures: number;
  skipped: number;
  cases: CaseView[];
}
export interface TestSummaryView {
  totals: { suites: number; tests: number; failures: number; skipped: number };
  suites: SuiteView[];
  failed: CaseView[];
  note: string;
}
/** The structured result of a test run (junit-like) without trusting its shape. Failed cases come first; messages are masked. */
export function summaryOf(summary: unknown): TestSummaryView {
  const s = (summary ?? {}) as Record<string, unknown>;
  const tot = (s.totals ?? {}) as Record<string, unknown>;
  const suites: SuiteView[] = (Array.isArray(s.suites) ? s.suites : [])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      suite: safeText(x.suite, 40),
      status: safeText(x.status, 20),
      tests: num(x.tests),
      failures: num(x.failures),
      skipped: num(x.skipped),
      cases: (Array.isArray(x.cases) ? x.cases : [])
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          suite: safeText(c.suite ?? x.suite, 40),
          name: safeText(c.name, 200),
          status: safeText(c.status, 20),
          ...(typeof c.failure === 'string' ? { failure: safeText(c.failure, 400) } : {}),
        })),
    }));
  return {
    totals: {
      suites: num(tot.suites) || suites.length,
      tests: num(tot.tests),
      failures: num(tot.failures),
      skipped: num(tot.skipped),
    },
    suites,
    failed: suites.flatMap((x) => x.cases.filter((c) => c.status === 'failed')),
    note: safeText(s.note, 300),
  };
}
export const TEST_SUITES = ['all', 'unit', 'typecheck', 'build', 'e2e'] as const;

/* ------------------------------------------------------------------ deployments (UI-M10-09) */

export const deploymentTone = (state: string): Tone =>
  state === 'live'
    ? 'success'
    : state === 'failed'
      ? 'danger'
      : state === 'rolled_back' || state === 'superseded'
        ? 'warn'
        : undefined;
export const isLiveDeployment = (state: string) =>
  ['queued', 'building', 'deploying', 'verifying'].includes(state);
export const canRollback = (d: Pick<Deployment, 'state' | 'environment' | 'rollbackOf'>) =>
  (d.state as string) === 'live' && !d.rollbackOf;

export interface HealthView {
  attempts: number | null;
  autoRolledBack: boolean;
  restoredDeploymentId: string | null;
  checkedUrl: string;
}
/** The health-gate result stored on a deployment: attempts, and whether the previous release was restored. */
export function healthOf(h: unknown): HealthView | null {
  if (typeof h !== 'object' || h === null || Object.keys(h).length === 0) return null;
  const x = h as Record<string, unknown>;
  return {
    attempts: typeof x.attempts === 'number' ? x.attempts : null,
    autoRolledBack: x.autoRolledBack === true,
    restoredDeploymentId:
      typeof x.restoredDeploymentId === 'string' ? x.restoredDeploymentId : null,
    checkedUrl: safeText(x.url ?? x.checkedUrl, 200),
  };
}
export const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/* ------------------------------------------------------------------ exports (UI-M10-10) */

export const exportTone = (status: string): Tone =>
  status === 'ready'
    ? 'success'
    : status === 'blocked'
      ? 'danger'
      : status === 'building' || status === 'expired'
        ? 'warn'
        : undefined;
/** The signed URL may be offered only while it exists and has not expired (it is valid for 15 minutes at most; a new one is issued per read). */
export const downloadValid = (
  e: Pick<ExportRow, 'downloadUrl' | 'downloadUrlExpiresAt'>,
  now = Date.now(),
) =>
  typeof e.downloadUrl === 'string' &&
  e.downloadUrl.length > 0 &&
  typeof e.downloadUrlExpiresAt === 'string' &&
  Date.parse(e.downloadUrlExpiresAt) > now;
/** Only an http(s) URL is ever put in an `href`. */
export const safeHref = (u: string | null | undefined) =>
  u && /^https?:\/\//i.test(u) ? u : undefined;

/* ------------------------------------------------------------------ admin helper reused by tests */
export const shortId = (id: string) => id.slice(0, 8);
