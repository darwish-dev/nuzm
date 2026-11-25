// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { readApi, readSchema, readSpec } from '../lib/appworkspace';
import type { Run } from '../lib/builder';
import { AppDeployments, type AppDeployment } from './AppDeployments';
import {
  AccessPanel,
  ApiPanel,
  AppSpecPanel,
  AppVersions,
  DataModelPanel,
  NoBuildYet,
  NotAnApp,
} from './AppBlueprint';
import { AppRunProgress } from './AppProgress';
import { BuilderStart, startTypes } from './BuilderStart';
import { ProjectCards, ProjectFilterTabs } from './BuilderProjects';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
const mockFetch = (h: Handler) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method ?? 'GET'),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, init);
    }),
  );
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const sse = (...events: { seq: number; type: string; data?: object }[]) =>
  new Response(
    events
      .map(
        (e) =>
          `id: ${e.seq}\ndata: ${JSON.stringify({ ...e, data: e.data ?? {}, at: '2026-11-19T10:00:00Z' })}\n\n`,
      )
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run-1',
  sessionId: 's1',
  projectId: 'p1',
  kind: 'webapp',
  state: 'running',
  operationId: null,
  step: null,
  budget: { maxTokens: 1000, maxCredits: 100 },
  usage: { tokensIn: 100, tokensOut: 50, spentCredits: '10', reservedCredits: '0', modelRef: null },
  dataRegion: 'sa-central',
  result: null,
  error: null,
  pendingApproval: null,
  artifacts: [],
  createdAt: '2026-11-19T10:00:00Z',
  finishedAt: null,
  ...over,
});

describe('agent run progress (UI-M10-06)', () => {
  it('empty state with the start-build form when there is no run, and a build starts a webapp run on the project session', async () => {
    mockFetch((url) =>
      url === '/v1/ai/runs'
        ? json(202, run({ state: 'queued' }))
        : url === '/v1/ai/sessions'
          ? json(201, { id: 's9' })
          : json(404, {}),
    );
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={null}
        sessionId={null}
        canRun
        canApprove
      />,
    );
    expect(screen.getByText(t('en', 'm10a.run.none.title'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('en', 'm10a.build.brief')), {
      target: { value: 'A clinic app' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.build.start') }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/ai/runs')).toBe(true));
    const post = calls.find((c) => c.url === '/v1/ai/runs')!;
    expect(post.method).toBe('POST');
    expect(post.body).toMatchObject({
      sessionId: 's9',
      kind: 'webapp',
      projectId: 'p1',
      input: { brief: { prompt: 'A clinic app' } },
    });
    expect(post.headers['Idempotency-Key'] ?? post.headers['idempotency-key']).toBeTruthy();
  });
  it('refuses an empty brief in the browser and says so', () => {
    mockFetch(() => json(200, {}));
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={null}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.build.start') }));
    expect(screen.getByText(t('en', 'm10a.build.briefErr', { max: 30000 }))).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it('a member who cannot run sees the honest message and no form', () => {
    mockFetch(() => json(200, {}));
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={null}
        sessionId={null}
        canRun={false}
        canApprove={false}
      />,
    );
    expect(screen.getByText(t('en', 'm10a.run.none.noPermission'))).toBeTruthy();
    expect(screen.queryByLabelText(t('en', 'm10a.build.brief'))).toBeNull();
  });
  it('shows the seven agents with the status the run events give, the budget meters, and a live announcement', async () => {
    mockFetch((url) =>
      url.endsWith('/events')
        ? sse(
            { seq: 1, type: 'node_started', data: { node: 'requirements', attempt: 1 } },
            {
              seq: 2,
              type: 'node_succeeded',
              data: { node: 'requirements', tokensIn: 60, tokensOut: 40 },
            },
            { seq: 3, type: 'node_started', data: { node: 'architecture', attempt: 1 } },
          )
        : json(200, run()),
    );
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={run()}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    const list = await screen.findByRole('list', { name: t('en', 'm10a.run.agents') });
    await waitFor(() =>
      expect(
        within(list)
          .getByText(t('en', 'm10a.agent.requirements'))
          .closest('li')
          ?.getAttribute('data-status'),
      ).toBe('done'),
    );
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(list.querySelector('[data-node="architecture"]')?.getAttribute('data-status')).toBe(
      'running',
    );
    expect(list.querySelector('[data-node="qa"]')?.getAttribute('data-status')).toBe('pending');
    expect(screen.getAllByRole('meter').length).toBeGreaterThanOrEqual(2);
    await waitFor(() =>
      expect(document.querySelector('p.nz-sr[role="status"]')?.textContent).toBe(
        t('en', 'm10a.ev.node_started', { agent: t('en', 'm10a.agent.architecture') }),
      ),
    );
  });
  it('waiting for approval: lists the pending approvals of THIS run only and links to the inbox', async () => {
    const waiting = run({ state: 'waiting_approval' });
    mockFetch((url) =>
      url.startsWith('/v1/ai/approvals')
        ? json(200, {
            items: [
              {
                id: 'a1',
                runId: 'run-1',
                type: 'destructive_migration',
                status: 'pending',
                scopeHash: 'f'.repeat(64),
                expiresAt: '2099-01-01T00:00:00Z',
              },
              {
                id: 'a2',
                runId: 'other',
                type: 'production_deploy',
                status: 'pending',
                scopeHash: 'e'.repeat(64),
                expiresAt: '2099-01-01T00:00:00Z',
              },
            ],
          })
        : url.endsWith('/events')
          ? sse()
          : json(200, waiting),
    );
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={waiting}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    expect(await screen.findByText(t('en', 'm10.apr.type.destructive_migration'))).toBeTruthy();
    expect(screen.queryByText(t('en', 'm10.apr.type.production_deploy'))).toBeNull();
    const link = screen.getByRole('link', { name: t('en', 'm10a.run.decide') });
    expect(link.getAttribute('href')).toBe('/approvals');
  });
  it('a member who cannot approve is told to ask an owner or admin', async () => {
    const waiting = run({ state: 'waiting_approval' });
    mockFetch((url) =>
      url.startsWith('/v1/ai/approvals')
        ? json(200, { items: [] })
        : url.endsWith('/events')
          ? sse()
          : json(200, waiting),
    );
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={waiting}
        sessionId="s1"
        canRun
        canApprove={false}
      />,
    );
    expect(await screen.findByText(t('en', 'm10a.run.needsApprover'))).toBeTruthy();
  });
  it('failed and budget-exceeded runs say so plainly, with the error code but never raw model text', async () => {
    const failed = run({
      state: 'failed',
      finishedAt: '2026-11-19T10:05:00Z',
      error: { code: 'agent_output_invalid', message: 'secret sk_live_ABCDEFGHIJKLMNOPQRSTUVWX' },
    });
    mockFetch((url) => (url.endsWith('/events') ? sse() : json(200, failed)));
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={failed}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    expect(
      await screen.findByText(t('en', 'm10a.run.failed', { code: 'agent_output_invalid' })),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk_live_');
    // a finished run offers to build again
    expect(screen.getByText(t('en', 'm10a.build.again'))).toBeTruthy();
  });
  it('from 80 % of a cap every meter says so and the warning banner shows', async () => {
    const hot = run({
      usage: {
        tokensIn: 900,
        tokensOut: 0,
        spentCredits: '10',
        reservedCredits: '0',
        modelRef: null,
      },
    });
    mockFetch((url) => (url.endsWith('/events') ? sse() : json(200, hot)));
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={hot}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    expect(await screen.findByText(t('en', 'm10.run.budgetWarn'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.run.warn80'))).toBeTruthy();
  });
  it('cancel posts the cancellation while the run is live', async () => {
    mockFetch((url) =>
      url.endsWith('/cancellation')
        ? json(202, { state: 'cancelling' })
        : url.endsWith('/events')
          ? sse()
          : json(200, run()),
    );
    render(
      <AppRunProgress
        locale="en"
        projectId="p1"
        initialRun={run()}
        sessionId="s1"
        canRun
        canApprove
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('en', 'bld.run.cancel') }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/v1/ai/runs/run-1/cancellation' && c.method === 'POST'),
      ).toBe(true),
    );
  });
});

const SPEC = readSpec({
  name: 'Clinic',
  slug: 'clinic',
  description: 'Patients and visits',
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  entities: [
    {
      name: 'Patient',
      plural: 'patients',
      labels: { ar: 'مريض', en: 'Patient' },
      ownership: 'owner',
      audit: true,
      fields: [
        {
          name: 'fullName',
          type: 'string',
          labels: { ar: 'الاسم', en: 'Name' },
          required: true,
          pii: true,
        },
      ],
    },
  ],
  roles: [
    {
      name: 'doctor',
      labels: { ar: 'طبيب', en: 'Doctor' },
      scope: 'own',
      permissions: { Patient: ['read', 'update'] },
    },
    { name: 'viewer', labels: { ar: 'مشاهد', en: 'Viewer' }, scope: 'all', permissions: {} },
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
    attachmentMaxBytes: 1048576,
    notifications: [],
  },
})!;

describe('app spec, data, API and access views (UI-M10-02)', () => {
  it('renders the spec in the page language: entities with field rules, roles, pages, API settings', () => {
    render(<AppSpecPanel locale="ar" spec={SPEC} />);
    expect(screen.getByRole('heading', { name: /Patient/ })).toBeTruthy();
    expect(screen.getByText(t('ar', 'm10a.spec.pii'))).toBeTruthy();
    expect(screen.getByRole('table', { name: t('ar', 'm10a.spec.roles') })).toBeTruthy();
    expect(screen.getByText('/patients')).toBeTruthy();
    expect(screen.getByText('/api/v1')).toBeTruthy();
  });
  it('the access matrix has a caption, column and row headers, and says "no access" for an empty cell', () => {
    render(<AccessPanel locale="en" roles={SPEC.roles} entities={['Patient']} />);
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('Patient');
    expect(within(table).getByRole('rowheader', { name: 'doctor' })).toBeTruthy();
    expect(within(table).getByText(t('en', 'm10a.crud.update'))).toBeTruthy();
    expect(within(table).getByText(t('en', 'm10a.access.noAccess'))).toBeTruthy(); // viewer has no entry
  });
  it('the data model flags destructive migrations and shows the SQL on demand', () => {
    const schema = readSchema({
      tables: ['patients'],
      migrations: [
        {
          version: 1,
          name: 'init',
          up: 'CREATE TABLE patients ();',
          down: 'DROP TABLE patients;',
          destructive: [],
        },
        {
          version: 2,
          name: 'drop_x',
          up: 'ALTER TABLE patients DROP COLUMN x;',
          down: '',
          destructive: ['DROP COLUMN x'],
        },
      ],
    })!;
    render(<DataModelPanel locale="en" schema={schema} spec={SPEC} />);
    expect(screen.getByText(t('en', 'm10a.data.destructiveNote'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10a.data.destructive', { count: 1 }))).toBeTruthy();
    expect(screen.getByText('0002_drop_x')).toBeTruthy();
    expect(
      screen.getByText(t('en', 'm10a.data.columns', { count: 1 }), { exact: false }),
    ).toBeTruthy();
  });
  it('the API panel lists endpoints and the dependency verdict', () => {
    const api = readApi({
      openapi: { paths: { '/patients': { get: { summary: 'List patients' } } } },
      rbac: { roles: [] },
      dependencies: { manifest: { dependencies: { a: '1' } }, policy: { ok: true, findings: [] } },
    })!;
    render(<ApiPanel locale="en" api={api} />);
    expect(screen.getByText('List patients')).toBeTruthy();
    expect(screen.getByText(t('en', 'm10a.api.depsOk'))).toBeTruthy();
  });
  it('empty, not-an-app and versions states', () => {
    const { rerender } = render(<NoBuildYet locale="en" />);
    expect(screen.getByText(t('en', 'm10a.bp.none.title'))).toBeTruthy();
    rerender(<NotAnApp locale="en" projectId="p1" />);
    expect(
      screen.getByRole('link', { name: t('en', 'm10a.notApp.back') }).getAttribute('href'),
    ).toBe('/builder/projects/p1');
    rerender(<AppVersions locale="en" projectId="p1" versions={[]} />);
    expect(screen.getByText(t('en', 'm10a.ver.empty.title'))).toBeTruthy();
    rerender(
      <AppVersions
        locale="en"
        projectId="p1"
        versions={[
          {
            id: 'v1',
            seq: 2,
            parentId: null,
            label: null,
            named: false,
            source: 'ai',
            runId: 'abcdef123456',
            restoredFrom: null,
            createdBy: null,
            createdAt: '2026-11-19T10:00:00Z',
            modelHash: 'x',
            isHead: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(t('en', 'm10a.ver.head'))).toBeTruthy();
  });
});

const dep = (over: Partial<AppDeployment> = {}): AppDeployment => ({
  id: 'd1',
  projectId: 'p1',
  versionId: 'v1',
  environment: 'staging',
  state: 'live',
  target: { type: 'site', id: '11111111-1111-4111-8111-111111111111' },
  createdAt: '2026-11-19T10:00:00Z',
  ...over,
});
const sites = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Main site', status: 'active' }];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('app deployments (UI-M10-09)', () => {
  it('without a target says so, and the person can still type a target id (checked as a UUID before anything is sent)', async () => {
    mockFetch(() => json(200, { items: [] }));
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={1}
        initial={[]}
        sites={[]}
        canWrite
      />,
    );
    expect(screen.getByText(t('en', 'm10a.dep.noSites'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('en', 'm10a.dep.targetId')), {
      target: { value: 'not-a-uuid' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.create') }));
    expect(await screen.findByText(t('en', 'm10a.dep.targetIdErr'))).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it('deploys with {type,id} target, version and env; the 202 deployment appears in the list', async () => {
    mockFetch((url, init) =>
      init.method === 'POST' && url === '/v1/deployments'
        ? json(202, dep({ state: 'building' }))
        : url.endsWith('/logs')
          ? json(200, { items: [] })
          : json(200, { items: [] }),
    );
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[]}
        sites={sites}
        canWrite
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.create') }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/v1/deployments' && c.method === 'POST')).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      projectId: 'p1',
      versionId: 'v1',
      target: { type: 'site', id: sites[0]!.id },
      env: 'staging',
    });
    expect(await screen.findByRole('table', { name: t('en', 'bld.dep.list') })).toBeTruthy();
  });
  it('a production deploy answers 403 approval_required: nothing is started, the approvals are listed with a link to the inbox, and "try again" repeats the request with a new key', async () => {
    let n = 0;
    mockFetch((url, init) => {
      if (init.method === 'POST' && url === '/v1/deployments') {
        n += 1;
        return n === 1
          ? json(403, {
              code: 'approval_required',
              approvals: [{ id: 'a1', type: 'production_deploy', scopeHash: 'c'.repeat(64) }],
            })
          : json(202, dep({ environment: 'production', state: 'queued' }));
      }
      return json(200, { items: [] });
    });
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[]}
        sites={sites}
        canWrite
      />,
    );
    fireEvent.change(screen.getByLabelText(t('en', 'bld.dep.environment')), {
      target: { value: 'production' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.create') }));
    expect(await screen.findByText(t('en', 'm10a.dep.approvalNeeded'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.apr.type.production_deploy'))).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'm10a.dep.openApprovals') }).getAttribute('href'),
    ).toBe('/approvals');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.retryAfter') }));
    await waitFor(() => expect(n).toBe(2));
    await waitFor(() => expect(screen.queryByText(t('en', 'm10a.dep.approvalNeeded'))).toBeNull());
    const keys = calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.headers['Idempotency-Key'] ?? c.headers['idempotency-key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('a failed health gate is shown as such and the restored release is explained', async () => {
    mockFetch((url) =>
      url.endsWith('/logs')
        ? json(200, {
            items: [
              {
                seq: 1,
                level: 'error',
                message: 'health check failed',
                at: '2026-11-19T10:00:05Z',
              },
            ],
          })
        : json(200, { items: [] }),
    );
    const d = dep({
      state: 'rolled_back',
      failureCode: 'health_gate_failed',
      healthCheck: { attempts: 3, autoRolledBack: true },
    });
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[d]}
        sites={sites}
        canWrite
      />,
    );
    expect(await screen.findByText(t('en', 'm10a.dep.autoRolledBack'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10a.dep.healthFailed'))).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText(t('en', 'bld.dep.logs')).textContent).toContain(
        'health check failed',
      ),
    );
  });
  it('rollback needs a confirmation, then posts to the rollback route with its own key; a production rollback that needs approval is reported', async () => {
    mockFetch((url, init) =>
      init.method === 'POST' && url === '/v1/deployments/d1/rollback'
        ? json(403, {
            code: 'approval_required',
            approvals: [{ id: 'a9', type: 'production_rollback', scopeHash: 'd'.repeat(64) }],
          })
        : json(200, { items: [] }),
    );
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[dep({ environment: 'production' })]}
        sites={sites}
        canWrite
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('en', 'bld.dep.rollback') }));
    expect(screen.getByText(t('en', 'm10a.dep.rollbackApproval'))).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // nothing before the confirmation
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.rollbackConfirm') }));
    expect(await screen.findByText(t('en', 'm10a.dep.approvalNeeded'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.apr.type.production_rollback'))).toBeTruthy();
    await flush();
  });
  it('a read-only member sees no deploy form and no rollback button', async () => {
    mockFetch(() => json(200, { items: [] }));
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[dep()]}
        sites={sites}
        canWrite={false}
      />,
    );
    expect(screen.getByText(t('en', 'm10a.dep.noPermission'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'bld.dep.rollback') })).toBeNull();
  });
  it('refusals are plain sentences by error code (dependency policy, residency), never the server text', async () => {
    mockFetch((url, init) =>
      init.method === 'POST'
        ? json(422, { code: 'dependency_blocked', detail: 'left-pad@1 has advisory GHSA-xxxx' })
        : json(200, { items: [] }),
    );
    render(
      <AppDeployments
        locale="en"
        projectId="p1"
        versionId="v1"
        headSeq={3}
        initial={[]}
        sites={sites}
        canWrite
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm10a.dep.create') }));
    expect(await screen.findByText(t('en', 'm10.err.dependencyBlocked'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('GHSA');
  });
});

describe('start a web app (UI-M10-01)', () => {
  const wallet = { availableCredits: '100', lowCredit: false } as never;
  it('the web-app tile is startable only while the org flag is on; mobile never is', () => {
    expect(startTypes(false).find((x) => x.id === 'webapp')?.available).toBe(false);
    expect(startTypes(true).find((x) => x.id === 'webapp')?.available).toBe(true);
    expect(startTypes(true).find((x) => x.id === 'mobile')?.available).toBe(false);
  });
  it('flag off: the web-app tile says "coming soon" and starts nothing', () => {
    mockFetch(() => json(200, {}));
    render(<BuilderStart locale="en" credits={wallet} canRun />);
    fireEvent.click(
      screen.getByRole('radio', { name: new RegExp(t('en', 'bld.start.type.webapp')) }),
    );
    expect(
      screen.getByText(t('en', 'bld.start.soonNote', { type: t('en', 'bld.start.type.webapp') })),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: new RegExp(t('en', 'bld.start.go')),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('flag on: project(type webapp) → session → run kind webapp with the prompt as brief data and the cap as budget, then the app workspace opens', async () => {
    mockFetch((url) =>
      url === '/v1/builder/template-recommendations'
        ? json(200, { selected: null, ranked: [], decision: { strategy: 'GENERATE_FROM_SCRATCH' } })
        : url === '/v1/builder/projects'
          ? json(201, { id: 'p1' })
          : url === '/v1/ai/sessions'
            ? json(201, { id: 's1' })
            : json(202, { id: 'r1' }),
    );
    render(<BuilderStart locale="en" credits={wallet} canRun appsEnabled initialType="webapp" />);
    fireEvent.change(screen.getByLabelText(t('en', 'bld.start.promptLabel')), {
      target: { value: 'A CRM for my sales team' },
    });
    fireEvent.change(screen.getByLabelText(new RegExp(t('en', 'bld.wiz.budget').slice(0, 12))), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p1'));
    // the Knowledge Library is asked first with the whole description; it selected nothing, so the project is generated from scratch
    expect(calls.map((c) => c.url)).toEqual([
      '/v1/builder/template-recommendations',
      '/v1/builder/projects',
      '/v1/ai/sessions',
      '/v1/ai/runs',
    ]);
    expect(calls[0]!.body).toMatchObject({ text: 'A CRM for my sales team', platform: 'WEB' });
    expect(calls[1]!.body).toMatchObject({ type: 'webapp', locale: ['ar', 'en'] });
    expect(calls[1]!.body).not.toHaveProperty('templateId');
    expect(calls[3]!.body).toMatchObject({
      kind: 'webapp',
      projectId: 'p1',
      sessionId: 's1',
      input: { brief: { prompt: 'A CRM for my sales team' } },
      budget: { maxCredits: 500 },
    });
  });
  it('after a refused run (no credits) the retry continues where it stopped and never creates a second project', async () => {
    let runs = 0;
    mockFetch((url) => {
      if (url === '/v1/builder/template-recommendations') return json(404, { code: 'not_found' }); // the library is off: generate from scratch
      if (url === '/v1/builder/projects') return json(201, { id: 'p1' });
      if (url === '/v1/ai/sessions') return json(201, { id: 's1' });
      runs += 1;
      return runs === 1 ? json(402, { code: 'insufficient_credits' }) : json(202, { id: 'r1' });
    });
    render(<BuilderStart locale="en" credits={wallet} canRun appsEnabled initialType="webapp" />);
    fireEvent.change(screen.getByLabelText(t('en', 'bld.start.promptLabel')), {
      target: { value: 'An inventory app' },
    });
    const go = () =>
      fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    go();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
    go();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p1'));
    expect(calls.filter((c) => c.url === '/v1/builder/projects')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/v1/builder/template-recommendations')).toHaveLength(1); // asked once per request
  });
  it('a fitting template from the Knowledge Library: the project starts from it and the AI adapts it to the WHOLE description', async () => {
    const long = `A website for a cafe. ${'Menu and opening hours. '.repeat(1200)}END`;
    mockFetch((url) =>
      url === '/v1/builder/template-recommendations'
        ? json(200, {
            selected: { resourceId: 'tpl1', versionId: 'v1' },
            decision: { strategy: 'AUTO_SELECT' },
          })
        : url === '/v1/builder/projects/from-template'
          ? json(201, { project: { id: 'p9' } })
          : url === '/v1/builder/generation-plans'
            ? json(201, { id: 'plan1' })
            : json(202, { id: 'plan1' }),
    );
    render(<BuilderStart locale="en" credits={wallet} canRun appsEnabled />);
    fireEvent.change(screen.getByLabelText(t('en', 'bld.start.promptLabel')), {
      target: { value: long },
    });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'bld.start.go')) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p9'));
    expect(calls.map((c) => c.url)).toEqual([
      '/v1/builder/template-recommendations',
      '/v1/builder/projects/from-template',
      '/v1/builder/generation-plans',
      '/v1/builder/generation-plans/plan1/runs',
    ]);
    expect(calls[1]!.body).toMatchObject({
      resourceId: 'tpl1',
      versionId: 'v1',
      adaptationMode: 'ADAPTIVE',
    });
    expect((calls[2]!.body as { text: string }).text).toBe(long); // never cut
    expect(long.length).toBeGreaterThan(20_000);
  });
});

describe('project list by type', () => {
  const p = (id: string, type: string) =>
    ({
      id,
      type,
      name: `n-${id}`,
      locales: ['ar'],
      lastDeployment: null,
      updatedAt: '2026-11-19T10:00:00Z',
    }) as never;
  it('shows the type of every project and links to the workspace', () => {
    render(
      <ProjectCards
        locale="en"
        items={[p('a', 'webapp'), p('b', 'website')]}
        nextCursor={null}
        canCreate
      />,
    );
    expect(screen.getByText(t('en', 'm10.proj.type.webapp'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10.proj.type.website'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'n-a' }).getAttribute('href')).toBe(
      '/builder/projects/a',
    );
  });
  it('a mobile app opens in the same workspace as every other project (its mobile mode), not on a separate page', () => {
    render(<ProjectCards locale="ar" items={[p('m', 'mobile')]} nextCursor={null} canCreate />);
    expect(screen.getByRole('link', { name: 'n-m' }).getAttribute('href')).toBe(
      '/builder/projects/m',
    );
  });
  it('a filter with no match says "none of this type"; the type filter is offered only while the app builder is on', () => {
    const { rerender, container } = render(
      <ProjectCards locale="en" items={[]} nextCursor={null} canCreate filtered />,
    );
    expect(screen.getByText(t('en', 'm10a.proj.filtered.title'))).toBeTruthy();
    rerender(<ProjectFilterTabs locale="en" current="all" appsEnabled={false} />);
    expect(container.querySelector('nav')).toBeNull();
    rerender(<ProjectFilterTabs locale="en" current="webapp" appsEnabled />);
    const cur = screen.getByRole('link', { name: t('en', 'm10a.proj.filter.webapp') });
    expect(cur.getAttribute('aria-current')).toBe('page');
    expect(cur.getAttribute('href')).toBe('/builder/projects?type=webapp');
    // the mobile tab shows only while the mobile builder is on, with or without the app builder
    expect(screen.queryByRole('link', { name: t('en', 'm10a.proj.filter.mobile') })).toBeNull();
    rerender(<ProjectFilterTabs locale="en" current="mobile" appsEnabled={false} mobileEnabled />);
    const mob = screen.getByRole('link', { name: t('en', 'm10a.proj.filter.mobile') });
    expect(mob.getAttribute('aria-current')).toBe('page');
    expect(mob.getAttribute('href')).toBe('/builder/projects?type=mobile');
    expect(screen.queryByRole('link', { name: t('en', 'm10a.proj.filter.webapp') })).toBeNull();
  });
});
