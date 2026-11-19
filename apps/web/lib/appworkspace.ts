/**
 * Pure helpers of the web-app workspace (UI-M10-02/03/06/09): agent progress from run events, the app spec, the generated schema, API and access views, the
 * budget meters of a run and the deployment/approval helpers. No I/O: unit-tested in `appworkspace.spec.ts`. Every payload is read defensively (a model-made or
 * stale artifact never breaks a screen) and every string that reaches the screen goes through `safeText`.
 */
import type { Locale } from '@nuzm/i18n';
import { meterLevel, percentUsed, safeText, type ApprovalRef, type MeterLevel } from './appbuilder';
import { isRunFinished, num, str, type Run, type RunEvent } from './builder';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ------------------------------------------------------------------ project type */

export const isWebapp = (p: { type?: string } | null | undefined): boolean => p?.type === 'webapp';
export const PROJECT_FILTERS = ['all', 'website', 'webapp'] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];
/** The `type` query of the project list: anything unknown is "all". */
export const filterOf = (v: string | undefined): ProjectFilter =>
  v === 'website' || v === 'webapp' ? v : 'all';
export const applyFilter = <T extends { type: string }>(items: T[], f: ProjectFilter): T[] =>
  f === 'all' ? items : items.filter((p) => p.type === f);

/* ------------------------------------------------------------------ agent progress (UI-M10-06) */

/** The seven agents of the web-app graph in execution order, with the artifact each one produces (graph/dag.ts WEBAPP_GRAPH). */
export const AGENT_NODES = [
  { id: 'requirements', artifact: 'requirements' },
  { id: 'architecture', artifact: 'app_spec' },
  { id: 'database', artifact: 'db_schema' },
  { id: 'backend', artifact: 'api_contract' },
  { id: 'frontend', artifact: 'frontend_bundle' },
  { id: 'qa', artifact: 'test_plan' },
  { id: 'devops', artifact: 'deploy_plan' },
] as const;
export type AgentNodeId = (typeof AGENT_NODES)[number]['id'];

export type NodeStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';
export interface NodeView {
  id: AgentNodeId;
  artifactType: string;
  status: NodeStatus;
  attempt: number;
  tokens: number;
  artifactId: string | null;
}
export const nodeTone = (s: NodeStatus): 'success' | 'warn' | 'danger' | undefined =>
  s === 'done' ? 'success' : s === 'failed' ? 'danger' : s === 'waiting' ? 'warn' : undefined;

/** The node an event is about: `node`, else `agent` (the engine writes both). */
const nodeOf = (e: RunEvent): string => str(e.data.node) ?? str(e.data.agent) ?? '';

/**
 * Per-agent status from the persisted run events, backed by the artifacts the run already saved (an artifact means its node finished even when an event was
 * missed). A node still "running" after the run ended is shown as failed (run failed/budget) or pending (cancelled) — never as running forever.
 */
export function nodeViews(
  events: readonly RunEvent[],
  artifacts: readonly { id: string; type: string }[],
  runState: string,
): NodeView[] {
  const finished = isRunFinished(runState);
  return AGENT_NODES.map(({ id, artifact }) => {
    let status: NodeStatus = 'pending';
    let attempt = 0;
    let tokens = 0;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (nodeOf(e) !== id) continue;
      if (e.type === 'node_started') {
        status = 'running';
        attempt = Math.max(attempt, num(e.data.attempt, 1));
      } else if (e.type === 'node_succeeded') {
        status = 'done';
        tokens = num(e.data.tokensIn) + num(e.data.tokensOut);
      } else if (e.type === 'node_failed') {
        status = 'failed';
      } else if (e.type === 'approval_requested') {
        status = 'waiting';
      }
    }
    const art = artifacts.find((a) => a.type === artifact) ?? null;
    if (art && status !== 'failed') status = 'done';
    if (status === 'running' && finished) status = runState === 'cancelled' ? 'pending' : 'failed';
    if (status === 'waiting' && finished) status = 'pending';
    return { id, artifactType: artifact, status, attempt, tokens, artifactId: art?.id ?? null };
  });
}

/** done agents / all agents, whole percent. */
export const progressPct = (nodes: readonly NodeView[]): number =>
  Math.round((nodes.filter((n) => n.status === 'done').length / Math.max(1, nodes.length)) * 100);

/** The run's budget meters: tokens against `budget.maxTokens`, credits against `budget.maxCredits` (a missing cap = no meter, the figure is still shown). */
export interface RunMeterView {
  key: 'tokens' | 'credits';
  used: number;
  max: number | null;
  pct: number;
  level: MeterLevel;
}
export function runBudgetMeters(run: Pick<Run, 'budget' | 'usage'>): RunMeterView[] {
  const b = isObj(run.budget) ? run.budget : {};
  const u = run.usage ?? { tokensIn: 0, tokensOut: 0, spentCredits: '0' };
  const spent = Number(u.spentCredits);
  const rows: [RunMeterView['key'], number, number | null][] = [
    ['tokens', num(u.tokensIn) + num(u.tokensOut), num(b.maxTokens) || null],
    ['credits', Number.isFinite(spent) ? spent : 0, num(b.maxCredits) || null],
  ];
  return rows.map(([key, used, max]) => {
    const pct = max ? percentUsed(used, max) : 0;
    return { key, used, max, pct, level: max ? meterLevel(pct) : 'ok' };
  });
}
/** The run is over the warning line on a meter, or the engine said so with a `budget_warn` event. */
export const budgetWarns = (meters: readonly RunMeterView[], events: readonly RunEvent[]) =>
  meters.some((m) => m.level !== 'ok') || events.some((e) => e.type === 'budget_warn');

/** The newest web-app run of a project (list is newest first); `test-fix` runs are not the build. */
export const latestWebappRun = <T extends { kind: string }>(runs: readonly T[]): T | null =>
  runs.find((r) => r.kind === 'webapp') ?? null;
/** A run that holds at least one spec artifact — the one whose spec/schema/API/access the views show. */
export const latestBuiltRun = <T extends { kind: string; artifacts: { type: string }[] }>(
  runs: readonly T[],
): T | null =>
  runs.find((r) => r.kind === 'webapp' && r.artifacts.some((a) => a.type === 'app_spec')) ?? null;

/** The pending approvals that belong to a run (the inbox lists the whole organization). */
export const approvalsOfRun = <T extends { runId?: string | null; status: string }>(
  list: readonly T[],
  runId: string,
): T[] => list.filter((a) => a.runId === runId && a.status === 'pending');

/* ------------------------------------------------------------------ app spec (UI-M10-02 spec view) */

export type Bi = { ar: string; en: string };
const bi = (v: unknown): Bi => {
  const o = isObj(v) ? v : {};
  return { ar: safeText(o.ar, 120), en: safeText(o.en, 120) };
};
/** A bilingual label in the page language, falling back to the other language, then to `fallback`. */
export const pick = (b: Bi, locale: Locale, fallback = ''): string =>
  (locale === 'ar' ? b.ar || b.en : b.en || b.ar) || fallback;

export interface FieldView {
  name: string;
  type: string;
  label: Bi;
  required: boolean;
  unique: boolean;
  pii: boolean;
  references: string | null;
  enumValues: string[];
}
export interface EntityView {
  name: string;
  plural: string;
  label: Bi;
  ownership: string;
  audit: boolean;
  stageField: string | null;
  fields: FieldView[];
}
export interface RoleView {
  name: string;
  label: Bi;
  scope: string;
  admin: boolean;
  permissions: Record<string, string[]>;
}
export interface PageView {
  path: string;
  kind: string;
  title: Bi;
  entity: string | null;
  roles: string[];
}
export interface SpecView {
  name: string;
  slug: string;
  description: string;
  locales: string[];
  defaultLocale: string;
  entities: EntityView[];
  roles: RoleView[];
  pages: PageView[];
  api: { basePath: string; defaultLimit: number; maxLimit: number };
  nonFunctional: {
    rtl: boolean;
    accessibility: string;
    dataRegion: string;
    csvImportExport: boolean;
    attachmentMaxBytes: number;
    notifications: { event: string; channel: string }[];
  };
}

const strs = (v: unknown, max = 80): string[] =>
  arr(v)
    .filter((x): x is string => typeof x === 'string')
    .map((x) => safeText(x, max));

/** The `app_spec` artifact payload as a view, or null when it is not an object with entities. */
export function readSpec(payload: unknown): SpecView | null {
  if (!isObj(payload) || !Array.isArray(payload.entities)) return null;
  const nf = isObj(payload.nonFunctional) ? payload.nonFunctional : {};
  const api = isObj(payload.api) ? payload.api : {};
  return {
    name: safeText(payload.name, 80),
    slug: safeText(payload.slug, 60),
    description: safeText(payload.description, 2000),
    locales: strs(payload.locales, 4),
    defaultLocale: safeText(payload.defaultLocale, 4),
    entities: arr(payload.entities)
      .filter(isObj)
      .map((e) => ({
        name: safeText(e.name, 60),
        plural: safeText(e.plural, 60),
        label: bi(e.labels),
        ownership: safeText(e.ownership, 20),
        audit: e.audit === true,
        stageField: str(e.stageField) ? safeText(e.stageField, 60) : null,
        fields: arr(e.fields)
          .filter(isObj)
          .map((f) => ({
            name: safeText(f.name, 60),
            type: safeText(f.type, 20),
            label: bi(f.labels),
            required: f.required === true,
            unique: f.unique === true,
            pii: f.pii === true,
            references: str(f.references) ? safeText(f.references, 60) : null,
            enumValues: strs(f.enumValues, 60),
          })),
      })),
    roles: arr(payload.roles)
      .filter(isObj)
      .map((r) => roleOf(r)),
    pages: arr(payload.pages)
      .filter(isObj)
      .map((p) => ({
        path: safeText(p.path, 120),
        kind: safeText(p.kind, 20),
        title: bi(p.title),
        entity: str(p.entity) ? safeText(p.entity, 60) : null,
        roles: strs(p.roles, 60),
      })),
    api: {
      basePath: safeText(api.basePath, 60),
      defaultLimit: num(api.defaultLimit),
      maxLimit: num(api.maxLimit),
    },
    nonFunctional: {
      rtl: nf.rtl === true,
      accessibility: safeText(nf.accessibility, 20),
      dataRegion: safeText(nf.dataRegion, 40),
      csvImportExport: nf.csvImportExport === true,
      attachmentMaxBytes: num(nf.attachmentMaxBytes),
      notifications: arr(nf.notifications)
        .filter(isObj)
        .map((n) => ({ event: safeText(n.event, 60), channel: safeText(n.channel, 20) })),
    },
  };
}

function roleOf(r: Record<string, unknown>): RoleView {
  const perms = isObj(r.permissions) ? r.permissions : {};
  return {
    name: safeText(r.name, 60),
    label: bi(r.labels),
    scope: safeText(r.scope, 20),
    admin: r.admin === true,
    permissions: Object.fromEntries(
      Object.entries(perms)
        .slice(0, 60)
        .map(([entity, actions]) => [safeText(entity, 60), strs(actions, 20)]),
    ),
  };
}

/** Bytes as a short human figure (binary units), integer arithmetic for the KB/MB boundary. */
export function bytesText(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/* ------------------------------------------------------------------ generated schema / API / access (UI-M10-02) */

export interface MigrationView {
  version: number;
  name: string;
  up: string;
  down: string;
  destructive: string[];
}
export interface SchemaView {
  tables: string[];
  migrations: MigrationView[];
}
/** The `db_schema` artifact: tables and versioned migrations (destructive statements are flagged — they need an approval to deploy). */
export function readSchema(payload: unknown): SchemaView | null {
  if (!isObj(payload) || !Array.isArray(payload.migrations)) return null;
  return {
    tables: strs(payload.tables, 60),
    migrations: arr(payload.migrations)
      .filter(isObj)
      .map((m) => ({
        version: num(m.version),
        name: safeText(m.name, 60),
        up: typeof m.up === 'string' ? m.up.slice(0, 20_000) : '',
        down: typeof m.down === 'string' ? m.down.slice(0, 20_000) : '',
        destructive: strs(m.destructive, 300),
      }))
      .sort((a, b) => a.version - b.version),
  };
}

export interface EndpointView {
  method: string;
  path: string;
  summary: string;
}
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export interface ApiView {
  endpoints: EndpointView[];
  dependencies: { count: number; ok: boolean; findings: { level: string; message: string }[] };
  rbac: RoleView[];
}
/** The `api_contract` artifact: the endpoints of the generated OpenAPI, the dependency-policy verdict and the RBAC roles. */
export function readApi(payload: unknown): ApiView | null {
  if (!isObj(payload) || !isObj(payload.openapi)) return null;
  const paths = isObj(payload.openapi.paths) ? payload.openapi.paths : {};
  const endpoints: EndpointView[] = [];
  for (const [path, item] of Object.entries(paths).slice(0, 400)) {
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (isObj(op))
        endpoints.push({
          method: m.toUpperCase(),
          path: safeText(path, 200),
          summary: safeText(op.summary ?? op.operationId, 160),
        });
    }
  }
  const dep = isObj(payload.dependencies) ? payload.dependencies : {};
  const manifest = isObj(dep.manifest) ? dep.manifest : {};
  const policy = isObj(dep.policy) ? dep.policy : {};
  const rbac = isObj(payload.rbac) ? payload.rbac : {};
  return {
    endpoints,
    dependencies: {
      count:
        Object.keys(isObj(manifest.dependencies) ? manifest.dependencies : {}).length +
        Object.keys(isObj(manifest.devDependencies) ? manifest.devDependencies : {}).length,
      ok: policy.ok === true,
      findings: arr(policy.findings)
        .filter(isObj)
        .slice(0, 20)
        .map((f) => ({ level: safeText(f.level, 10), message: safeText(f.message, 240) })),
    },
    rbac: arr(rbac.roles)
      .filter(isObj)
      .map((r) => roleOf(r)),
  };
}

export const CRUD_ORDER = ['create', 'read', 'update', 'delete', 'import', 'export'] as const;
export interface MatrixRow {
  role: string;
  scope: string;
  cells: { entity: string; actions: string[] }[];
}
/** Roles × entities: the actions each role may do on each entity, in a fixed order (an entity a role has no entry for is an empty cell, i.e. no access). */
export function rbacMatrix(
  roles: readonly RoleView[],
  entities: readonly string[],
): { entities: string[]; rows: MatrixRow[] } {
  const known = [...entities];
  for (const r of roles)
    for (const e of Object.keys(r.permissions)) if (!known.includes(e)) known.push(e);
  return {
    entities: known,
    rows: roles.map((r) => ({
      role: r.name,
      scope: r.scope,
      cells: known.map((entity) => ({
        entity,
        actions: [...(r.permissions[entity] ?? [])].sort(
          (a, b) =>
            (CRUD_ORDER as readonly string[]).indexOf(a) -
            (CRUD_ORDER as readonly string[]).indexOf(b),
        ),
      })),
    })),
  };
}

/* ------------------------------------------------------------------ deployments (UI-M10-09, web apps) */

export const DEPLOY_ENVS = ['staging', 'production'] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];
export type TargetKind = 'site' | 'instance';
/** Body of `POST /v1/deployments` for a web-app project. `target` is `{type, id}` here (M10 §6); a website sends the bare site id (M09). */
export function deployBody(i: {
  projectId: string;
  versionId: string | null;
  kind: TargetKind;
  targetId: string;
  env: DeployEnv;
}) {
  return {
    projectId: i.projectId,
    ...(i.versionId ? { versionId: i.versionId } : {}),
    target: { type: i.kind, id: i.targetId },
    env: i.env,
  };
}
/** States of an app deployment (`deploy.app_deployments`): in flight until one of live / failed / rolled_back / superseded. */
export const APP_DEPLOY_ACTIVE = ['queued', 'building', 'deploying', 'verifying'] as const;
export const isAppDeployActive = (s: string) =>
  (APP_DEPLOY_ACTIVE as readonly string[]).includes(s);
export const appDeployTone = (s: string): 'success' | 'warn' | 'danger' | undefined =>
  s === 'live'
    ? 'success'
    : s === 'failed'
      ? 'danger'
      : s === 'rolled_back' || s === 'superseded'
        ? 'warn'
        : undefined;
/** Only the live deployment that is not itself a rollback can be rolled back. */
export const appCanRollback = (d: { state: string; rollbackOf?: string | null }) =>
  d.state === 'live' && !d.rollbackOf;

/** Outcome of a refused deploy/rollback call that needs humans: the approvals to decide (403 `approval_required`). */
export interface NeedsApproval {
  approvals: ApprovalRef[];
}

/** An approval's type word for the "deploy needs approval" list, restricted to the types that can come from a deployment. */
export const DEPLOY_APPROVAL_TYPES = [
  'production_deploy',
  'production_rollback',
  'data_migration_rollback',
  'destructive_migration',
  'paid_resource',
  'egress_or_dependency',
] as const;
