import { describe, expect, it } from 'vitest';
import {
  AGENT_NODES,
  applyFilter,
  approvalsOfRun,
  appCanRollback,
  appDeployTone,
  budgetWarns,
  bytesText,
  deployBody,
  filterOf,
  isAppDeployActive,
  latestBuiltRun,
  latestWebappRun,
  nodeTone,
  nodeViews,
  pick,
  progressPct,
  rbacMatrix,
  readApi,
  readSchema,
  readSpec,
  runBudgetMeters,
} from './appworkspace';
import type { RunEvent } from './builder';

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): RunEvent => ({
  seq,
  type,
  data,
  at: '2026-11-19T10:00:00Z',
});

describe('project filter', () => {
  it('knows website, webapp and all; anything else is all', () => {
    expect(filterOf('webapp')).toBe('webapp');
    expect(filterOf('website')).toBe('website');
    expect(filterOf('mobile')).toBe('all');
    expect(filterOf(undefined)).toBe('all');
  });
  it('filters by type', () => {
    const items = [{ type: 'website' }, { type: 'webapp' }, { type: 'webapp' }];
    expect(applyFilter(items, 'webapp')).toHaveLength(2);
    expect(applyFilter(items, 'all')).toHaveLength(3);
  });
});

describe('agent progress from run events', () => {
  it('lists the seven agents in graph order with their artifact', () => {
    expect(AGENT_NODES.map((n) => n.id)).toEqual([
      'requirements',
      'architecture',
      'database',
      'backend',
      'frontend',
      'qa',
      'devops',
    ]);
  });
  it('maps started / succeeded / failed events per node, counting tokens and attempts', () => {
    const nodes = nodeViews(
      [
        ev(1, 'node_started', { node: 'requirements', attempt: 1 }),
        ev(2, 'node_succeeded', { node: 'requirements', tokensIn: 100, tokensOut: 50 }),
        ev(3, 'node_started', { node: 'architecture', attempt: 2 }),
        ev(4, 'node_failed', { node: 'database' }),
        ev(5, 'node_started', { agent: 'backend' }),
      ],
      [],
      'running',
    );
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.requirements).toMatchObject({ status: 'done', tokens: 150 });
    expect(by.architecture).toMatchObject({ status: 'running', attempt: 2 });
    expect(by.database?.status).toBe('failed');
    expect(by.backend?.status).toBe('running'); // `agent` is accepted when `node` is absent
    expect(by.qa?.status).toBe('pending');
  });
  it('an artifact the run already saved means its agent finished, even when an event was missed', () => {
    const nodes = nodeViews([], [{ id: 'a1', type: 'app_spec' }], 'running');
    expect(nodes.find((n) => n.id === 'architecture')).toMatchObject({
      status: 'done',
      artifactId: 'a1',
    });
  });
  it('a node left "running" when the run ended is failed (run failed/budget) or pending (cancelled), never running forever', () => {
    const events = [ev(1, 'node_started', { node: 'frontend' })];
    expect(nodeViews(events, [], 'failed').find((n) => n.id === 'frontend')?.status).toBe('failed');
    expect(nodeViews(events, [], 'budget_exceeded').find((n) => n.id === 'frontend')?.status).toBe(
      'failed',
    );
    expect(nodeViews(events, [], 'cancelled').find((n) => n.id === 'frontend')?.status).toBe(
      'pending',
    );
  });
  it('an approval request marks the node as waiting while the run waits', () => {
    const nodes = nodeViews(
      [
        ev(1, 'node_started', { node: 'database' }),
        ev(2, 'approval_requested', { node: 'database' }),
      ],
      [],
      'waiting_approval',
    );
    expect(nodes.find((n) => n.id === 'database')?.status).toBe('waiting');
  });
  it('progress is done agents over all agents', () => {
    const nodes = nodeViews(
      [],
      [
        { id: '1', type: 'requirements' },
        { id: '2', type: 'app_spec' },
      ],
      'running',
    );
    expect(progressPct(nodes)).toBe(Math.round((2 / 7) * 100));
  });
  it('tone: done is success, failed is danger, waiting is warn', () => {
    expect(nodeTone('done')).toBe('success');
    expect(nodeTone('failed')).toBe('danger');
    expect(nodeTone('waiting')).toBe('warn');
    expect(nodeTone('running')).toBeUndefined();
  });
});

describe('run budget meters', () => {
  const run = (usage: object, budget: object) =>
    ({ usage, budget }) as Parameters<typeof runBudgetMeters>[0];
  it('computes percentages against the caps and warns from 80 %', () => {
    const m = runBudgetMeters(
      run(
        { tokensIn: 700, tokensOut: 100, spentCredits: '30' },
        { maxTokens: 1000, maxCredits: 100 },
      ),
    );
    expect(m[0]).toMatchObject({ key: 'tokens', used: 800, max: 1000, pct: 80, level: 'warn' });
    expect(m[1]).toMatchObject({ key: 'credits', used: 30, max: 100, pct: 30, level: 'ok' });
    expect(budgetWarns(m, [])).toBe(true);
  });
  it('100 % is exceeded; no cap means no meter and no warning, the figure is still there', () => {
    const m = runBudgetMeters(
      run({ tokensIn: 10, tokensOut: 0, spentCredits: '5' }, { maxTokens: 10 }),
    );
    expect(m[0]?.level).toBe('exceeded');
    expect(m[1]).toMatchObject({ used: 5, max: null, pct: 0, level: 'ok' });
  });
  it('a budget_warn event warns even before a meter does', () => {
    const m = runBudgetMeters(run({ tokensIn: 0, tokensOut: 0, spentCredits: '0' }, {}));
    expect(budgetWarns(m, [])).toBe(false);
    expect(budgetWarns(m, [ev(1, 'budget_warn')])).toBe(true);
  });
  it('survives a malformed budget and spend', () => {
    const m = runBudgetMeters(run({ spentCredits: 'x' }, 'nonsense' as unknown as object));
    expect(m.every((x) => Number.isFinite(x.used))).toBe(true);
  });
});

describe('run selection', () => {
  const runs = [
    { kind: 'test-fix', artifacts: [{ type: 'test_report' }] },
    { kind: 'webapp', artifacts: [{ type: 'requirements' }] },
    { kind: 'webapp', artifacts: [{ type: 'app_spec' }] },
  ];
  it('the latest web-app run skips test-fix runs; the latest built run is the first with a spec', () => {
    expect(latestWebappRun(runs)).toBe(runs[1]);
    expect(latestBuiltRun(runs)).toBe(runs[2]);
    expect(latestBuiltRun([runs[0]!])).toBeNull();
  });
  it('keeps only the pending approvals of this run', () => {
    const list = [
      { runId: 'r1', status: 'pending' },
      { runId: 'r2', status: 'pending' },
      { runId: 'r1', status: 'approved' },
    ];
    expect(approvalsOfRun(list, 'r1')).toEqual([list[0]]);
  });
});

const SPEC = {
  name: 'Clinic',
  slug: 'clinic',
  description: 'Patients <b>and</b> visits',
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  entities: [
    {
      name: 'Patient',
      plural: 'patients',
      labels: { ar: 'مريض', en: 'Patient' },
      ownership: 'owner',
      audit: true,
      stageField: 'status',
      fields: [
        {
          name: 'fullName',
          type: 'string',
          labels: { ar: 'الاسم', en: 'Name' },
          required: true,
          pii: true,
        },
        {
          name: 'status',
          type: 'enum',
          labels: { ar: 'الحالة', en: 'Status' },
          enumValues: ['new', 'seen'],
        },
        {
          name: 'doctor',
          type: 'reference',
          references: 'Doctor',
          labels: { ar: 'طبيب', en: 'Doctor' },
        },
      ],
    },
  ],
  roles: [
    {
      name: 'doctor',
      labels: { ar: 'طبيب', en: 'Doctor' },
      scope: 'own',
      permissions: { Patient: ['update', 'read', 'create'] },
    },
    {
      name: 'admin',
      labels: { ar: 'مدير', en: 'Admin' },
      scope: 'all',
      admin: true,
      permissions: { Patient: ['read', 'delete'], Visit: ['read'] },
    },
  ],
  pages: [
    { path: '/patients', kind: 'list', title: { ar: 'المرضى', en: 'Patients' }, entity: 'Patient' },
  ],
  api: { basePath: '/api/v1', defaultLimit: 25, maxLimit: 100 },
  nonFunctional: {
    rtl: true,
    accessibility: 'WCAG2.1-AA',
    dataRegion: 'sa-central',
    csvImportExport: true,
    attachmentMaxBytes: 10 * 1024 * 1024,
    notifications: [{ event: 'assigned', channel: 'email', template: 'x' }],
  },
};

describe('app spec reader', () => {
  const v = readSpec(SPEC)!;
  it('reads entities, fields, roles, pages, API and non-functional settings', () => {
    expect(v.entities[0]).toMatchObject({ name: 'Patient', audit: true, stageField: 'status' });
    expect(v.entities[0]?.fields[0]).toMatchObject({ name: 'fullName', required: true, pii: true });
    expect(v.entities[0]?.fields[1]?.enumValues).toEqual(['new', 'seen']);
    expect(v.entities[0]?.fields[2]?.references).toBe('Doctor');
    expect(v.roles).toHaveLength(2);
    expect(v.pages[0]).toMatchObject({ path: '/patients', entity: 'Patient' });
    expect(v.api).toEqual({ basePath: '/api/v1', defaultLimit: 25, maxLimit: 100 });
    expect(v.nonFunctional).toMatchObject({
      rtl: true,
      csvImportExport: true,
      dataRegion: 'sa-central',
    });
  });
  it('picks the label in the page language and falls back to the other one, then to the name', () => {
    expect(pick(v.entities[0]!.label, 'ar')).toBe('مريض');
    expect(pick(v.entities[0]!.label, 'en')).toBe('Patient');
    expect(pick({ ar: '', en: 'Only' }, 'ar')).toBe('Only');
    expect(pick({ ar: '', en: '' }, 'en', 'Fallback')).toBe('Fallback');
  });
  it('masks token-like runs in model-made text (nothing secret-looking reaches the screen)', () => {
    const w = readSpec({
      ...SPEC,
      description: 'key sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 here',
    })!;
    expect(w.description).toContain('[REDACTED]');
  });
  it('is null for a payload that is not a spec, and tolerant of missing parts', () => {
    expect(readSpec(null)).toBeNull();
    expect(readSpec({ entities: 'x' })).toBeNull();
    const min = readSpec({ entities: [] })!;
    expect(min.roles).toEqual([]);
    expect(min.api.maxLimit).toBe(0);
  });
  it('shows sizes as short figures', () => {
    expect(bytesText(512)).toBe('512 B');
    expect(bytesText(2048)).toBe('2 KB');
    expect(bytesText(10 * 1024 * 1024)).toBe('10 MB');
  });
});

describe('generated schema, API and access', () => {
  it('reads migrations in version order and keeps the destructive statements', () => {
    const s = readSchema({
      tables: ['patients'],
      migrations: [
        {
          version: 2,
          name: 'drop_col',
          up: 'ALTER TABLE t DROP COLUMN c;',
          down: '',
          destructive: ['DROP COLUMN c'],
        },
        {
          version: 1,
          name: 'init',
          up: 'CREATE TABLE t();',
          down: 'DROP TABLE t;',
          destructive: [],
        },
      ],
    })!;
    expect(s.migrations.map((m) => m.version)).toEqual([1, 2]);
    expect(s.migrations[1]?.destructive).toEqual(['DROP COLUMN c']);
    expect(s.tables).toEqual(['patients']);
    expect(readSchema({})).toBeNull();
  });
  it('lists endpoints (method + path), the dependency verdict and the rbac roles', () => {
    const a = readApi({
      openapi: {
        paths: {
          '/patients': {
            get: { summary: 'List' },
            post: { operationId: 'create' },
            parameters: [],
          },
          '/patients/{id}': { delete: { summary: 'Remove' } },
        },
      },
      rbac: { roles: [{ name: 'doctor', scope: 'own', permissions: { Patient: ['read'] } }] },
      dependencies: {
        manifest: { dependencies: { a: '1', b: '2' }, devDependencies: { c: '3' } },
        policy: { ok: false, findings: [{ level: 'warn', message: 'install script' }] },
      },
      files: [],
    })!;
    expect(a.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /patients',
      'POST /patients',
      'DELETE /patients/{id}',
    ]);
    expect(a.endpoints[1]?.summary).toBe('create');
    expect(a.dependencies).toMatchObject({ count: 3, ok: false });
    expect(a.rbac[0]?.name).toBe('doctor');
    expect(readApi({ openapi: 'x' })).toBeNull();
  });
  it('builds the roles × entities matrix: CRUD order, no entry = no access, entities only a role mentions are added', () => {
    const v = readSpec(SPEC)!;
    const m = rbacMatrix(
      v.roles,
      v.entities.map((e) => e.name),
    );
    expect(m.entities).toEqual(['Patient', 'Visit']);
    const doctor = m.rows.find((r) => r.role === 'doctor')!;
    expect(doctor.cells[0]?.actions).toEqual(['create', 'read', 'update']);
    expect(doctor.cells[1]?.actions).toEqual([]);
    expect(m.rows.find((r) => r.role === 'admin')?.cells[1]?.actions).toEqual(['read']);
    expect(rbacMatrix([], ['Patient']).rows).toEqual([]);
  });
});

describe('deployments', () => {
  it('sends the web-app target as {type,id} with the version and the environment', () => {
    expect(
      deployBody({
        projectId: 'p',
        versionId: 'v',
        kind: 'site',
        targetId: 't',
        env: 'production',
      }),
    ).toEqual({
      projectId: 'p',
      versionId: 'v',
      target: { type: 'site', id: 't' },
      env: 'production',
    });
    expect(
      deployBody({
        projectId: 'p',
        versionId: null,
        kind: 'instance',
        targetId: 't',
        env: 'staging',
      }),
    ).not.toHaveProperty('versionId');
  });
  it('tones and activity of app deployment states', () => {
    expect(appDeployTone('live')).toBe('success');
    expect(appDeployTone('failed')).toBe('danger');
    expect(appDeployTone('rolled_back')).toBe('warn');
    expect(appDeployTone('building')).toBeUndefined();
    expect(['queued', 'building', 'deploying', 'verifying'].every(isAppDeployActive)).toBe(true);
    expect(isAppDeployActive('live')).toBe(false);
  });
  it('only a live deployment that is not itself a rollback can be rolled back', () => {
    expect(appCanRollback({ state: 'live' })).toBe(true);
    expect(appCanRollback({ state: 'live', rollbackOf: 'x' })).toBe(false);
    expect(appCanRollback({ state: 'failed' })).toBe(false);
  });
});
