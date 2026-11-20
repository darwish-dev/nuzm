// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { Run, RunEvent } from '../lib/builder';
import { APP_TABS, type AppTab } from '../lib/webapp-workspace';

const stream = {
  run: null as Run | null,
  events: [] as RunEvent[],
  status: 'streaming',
  changed: null as Run | null,
  setRun: vi.fn(),
  reconnect: vi.fn(),
};
vi.mock('../lib/builder-client', async (orig) => ({
  ...(await orig<typeof import('../lib/builder-client')>()),
  useRunStream: () => stream,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { WebAppRunCard } from './WebAppRun';
import { WebAppWorkspace } from './WebAppWorkspace';
import type { AppCan } from './WebAppPanels';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; body: unknown }[] = [];
const mockFetch = (h: (url: string, method: string) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: String(init.method ?? 'GET'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, String(init.method ?? 'GET'));
    }),
  );
};
beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  mockFetch(() => json(404, {}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  stream.run = null;
  stream.events = [];
  stream.changed = null;
  stream.setRun.mockClear();
  stream.reconnect.mockClear();
});

let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}): RunEvent => ({
  seq: ++n,
  type,
  data,
  at: '2026-11-19T10:00:00Z',
});
const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'r1',
    sessionId: 's1',
    projectId: 'p1',
    kind: 'webapp',
    state: 'running',
    step: null,
    budget: { maxTokens: 1000, maxCredits: 50 },
    usage: { spentCredits: '10', tokensIn: 100, tokensOut: 500 },
    error: null,
    pendingApproval: null,
    artifacts: [],
    ...over,
  }) as unknown as Run;
const ALL: AppCan = {
  ai: true,
  describe: true,
  approve: true,
  write: true,
  sandbox: true,
  test: true,
  run: true,
  export: true,
  deployWrite: true,
  sites: true,
};
const project = {
  id: 'p1',
  name: 'Clinic app',
  dataRegion: 'sa-central',
  headVersionId: 'v1',
  headSeq: 3,
  lastDeployment: null,
};
const ws = (over: Partial<Parameters<typeof WebAppWorkspace>[0]> = {}, can: Partial<AppCan> = {}) =>
  render(
    <WebAppWorkspace
      locale="en"
      initial={project}
      session={{
        id: 's1',
        title: 't',
        projectId: 'p1',
        state: 'open',
        dataRegion: 'sa',
        createdAt: '',
      }}
      messages={[]}
      initialRun={null}
      allowedTabs={[...APP_TABS]}
      mfaFactorId={null}
      {...over}
      can={{ ...ALL, ...can }}
    />,
  );
const top = (c: HTMLElement) => c.querySelector('.bws-top') as HTMLElement;
const label = (x: AppTab) => t('en', `mws.web.tab.${x}` as 'mws.web.tab.preview');

const SPEC = {
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
        { name: 'fullName', type: 'string', labels: { ar: 'الاسم', en: 'Name' }, required: true },
      ],
    },
  ],
  roles: [
    {
      name: 'doctor',
      labels: { ar: 'طبيب', en: 'Doctor' },
      scope: 'own',
      permissions: { Patient: ['read'] },
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
    csvImportExport: false,
    attachmentMaxBytes: 1,
    notifications: [],
  },
};
const built = (url: string) =>
  url.startsWith('/v1/ai/runs?')
    ? json(200, {
        items: [
          run({ state: 'succeeded', artifacts: [{ id: 'a1', type: 'app_spec', createdAt: '' }] }),
        ],
        nextCursor: null,
      })
    : url === '/v1/ai/runs/r1/artifacts/a1'
      ? json(200, { payload: SPEC })
      : null;

describe('web-app mode of the builder workspace (same shell as the website and mobile modes)', () => {
  it('has the shell: logo, All projects, name, the eight panels, Deploy, close; the chat on the left', () => {
    const { container } = ws();
    const bar = within(top(container));
    expect(bar.getByText('Clinic app')).toBeTruthy();
    for (const x of APP_TABS) expect(bar.getByRole('button', { name: label(x) })).toBeTruthy();
    expect(bar.getByRole('button', { name: t('en', 'mws.web.deploy') })).toBeTruthy();
    expect(bar.getByRole('link', { name: t('en', 'bld.ws.back') }).getAttribute('href')).toBe(
      '/en/builder/projects?type=webapp',
    );
    expect(bar.getByRole('link', { name: t('en', 'bld.ws.exit') })).toBeTruthy();
    expect(container.querySelector('.bws')!.getAttribute('data-mode')).toBe('webapp');
    expect(screen.getByRole('heading', { name: t('en', 'mws.web.chat.title') })).toBeTruthy();
  });

  it('lists only the panels the member may open (the same permissions the former pages checked)', () => {
    const { container } = ws({ allowedTabs: ['preview', 'spec', 'design', 'tests', 'versions'] });
    const bar = within(top(container));
    for (const x of ['code', 'deployments', 'exports'] as const)
      expect(bar.queryByRole('button', { name: label(x) })).toBeNull();
    expect(bar.queryByRole('button', { name: t('en', 'mws.web.deploy') })).toBeNull();
  });

  it('a link to a panel the member may not open shows the forbidden state and calls nothing', () => {
    ws({ initialTab: 'exports', allowedTabs: ['preview'] });
    expect(screen.getByText(t('en', 'state.forbidden.title'))).toBeTruthy();
    // only the chat's list of earlier runs is read: the panel itself calls nothing
    expect(calls.filter((c) => !c.url.startsWith('/v1/ai/runs?'))).toHaveLength(0);
  });

  it('the Preview starts the app by itself in an isolated frame, and lists what the agents built', async () => {
    const url = `http://${'a'.repeat(32)}.preview.localhost:4000/#/autologin=s3ss10n`;
    mockFetch((u, method) =>
      u === '/v1/builder/projects/p1/live-preview' && method === 'POST'
        ? json(201, {
            url,
            expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            specVersion: 2,
          })
        : (built(u) ?? json(404, {})),
    );
    ws();
    // no button to press: opening the tab starts it, once
    const frame = (await screen.findByTitle(t('en', 'mws.web.live.frame'))) as HTMLIFrameElement;
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/live-preview')),
    ).toHaveLength(1);
    expect(frame.getAttribute('src')).toBe(url);
    // its own (isolated) origin, never the console's: storage and same-origin calls work inside it, nothing of the console is reachable
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads',
    );
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.queryByText(/autologin/)).toBeNull(); // the address is only the frame src
    await waitFor(() => expect(screen.getByText('Patients')).toBeTruthy());
  });

  it('the Preview says so when live preview is not enabled for the organization', async () => {
    mockFetch((u, method) =>
      u.endsWith('/live-preview') && method === 'POST'
        ? json(403, { status: 403, code: 'feature_disabled' })
        : (built(u) ?? json(404, {})),
    );
    ws();
    expect(await screen.findByText(t('en', 'mws.web.live.disabled'))).toBeTruthy();
  });

  it('a member who cannot edit the project does not start a preview', async () => {
    mockFetch((u) => built(u) ?? json(404, {}));
    ws({}, { write: false });
    expect(await screen.findByText(t('en', 'mws.web.live.needsWriter'))).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/live-preview'))).toBe(false);
  });

  it('a project with no build yet says so in the Preview and Spec panels', async () => {
    mockFetch((url) =>
      url.startsWith('/v1/ai/runs?') ? json(200, { items: [], nextCursor: null }) : json(404, {}),
    );
    ws();
    await waitFor(() => expect(screen.getByText(t('en', 'm10a.bp.none.title'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: label('spec') }));
    await waitFor(() => expect(screen.getByText(t('en', 'm10a.bp.none.title'))).toBeTruthy());
  });

  it('Spec and Data show what the agents generated, read from the run artifacts', async () => {
    mockFetch((url) => built(url) ?? json(404, {}));
    ws({ initialTab: 'spec' });
    await waitFor(() => expect(screen.getByRole('heading', { name: /Patient/ })).toBeTruthy());
    expect(screen.getByRole('table', { name: t('en', 'm10a.spec.roles') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: label('design') }));
    // the Data panel: its views, with the access matrix of the agreed roles
    fireEvent.click(await screen.findByRole('tab', { name: t('en', 'wsp.data.view.access') }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: t('en', 'm10a.access.title') })).toBeTruthy(),
    );
  });

  it('Versions, Tests, Exports and Deployments load their lists from the API; a 404 is the "not enabled" state', async () => {
    mockFetch((url) =>
      url.startsWith('/v1/builder/projects/p1/versions')
        ? json(200, { items: [], nextCursor: null })
        : url.startsWith('/v1/builder/projects/p1/test-runs')
          ? json(200, { items: [] })
          : url.startsWith('/v1/deployments')
            ? json(404, {})
            : url.startsWith('/v1/hosting/sites')
              ? json(200, { items: [] })
              : json(200, { items: [] }),
    );
    ws({ initialTab: 'versions' });
    await waitFor(() => expect(screen.getByText(t('en', 'm10a.ver.empty.title'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: label('tests') }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: t('en', 'm10.tst.title') })).toBeTruthy(),
    );
    expect(calls.some((c) => c.url.startsWith('/v1/builder/projects/p1/test-runs'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.web.deploy') }));
    await waitFor(() => expect(screen.getByText(t('en', 'm10.notEnabled.title'))).toBeTruthy());
    expect(location.search).toContain('tab=deployments');
  });

  it('a failed list can be retried', async () => {
    let tries = 0;
    mockFetch((url) => {
      if (!url.startsWith('/v1/builder/projects/p1/versions')) return json(404, {});
      tries += 1;
      return tries === 1 ? json(500, {}) : json(200, { items: [], nextCursor: null });
    });
    ws({ initialTab: 'versions' });
    await waitFor(() => expect(screen.getByText(t('en', 'mws.panel.loadError'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.retry') }));
    await waitFor(() => expect(screen.getByText(t('en', 'm10a.ver.empty.title'))).toBeTruthy());
  });

  it('the composer starts a `webapp` build with the brief as data, and the card of the run appears', async () => {
    mockFetch((url, method) =>
      url === '/v1/ai/sessions/s1/messages' && method === 'POST'
        ? json(201, {
            id: 'm1',
            sessionId: 's1',
            runId: null,
            role: 'user',
            content: 'x',
            createdAt: '2026-11-19T10:00:00Z',
          })
        : url === '/v1/ai/runs' && method === 'POST'
          ? json(202, run({ state: 'queued' }))
          : json(404, {}),
    );
    stream.run = run({ state: 'queued' });
    ws();
    fireEvent.change(screen.getByLabelText(t('en', 'bld.chat.input')), {
      target: { value: 'A clinic app with patients and visits' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.chat.send') }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/ai/runs')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/ai/runs')!.body).toMatchObject({
      sessionId: 's1',
      kind: 'webapp',
      projectId: 'p1',
      input: { brief: { prompt: 'A clinic app with patients and visits' } },
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: t('en', 'mws.web.run.label') })).toBeTruthy(),
    );
    expect((screen.getByLabelText(t('en', 'bld.chat.input')) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it('a member who cannot write sees a read-only notice instead of the composer', () => {
    ws({}, { describe: false });
    expect(screen.queryByLabelText(t('en', 'bld.chat.input'))).toBeNull();
    expect(screen.getAllByText(t('en', 'bld.readonly')).length).toBeGreaterThan(0);
  });

  it('speaks Arabic', () => {
    const { container } = ws({ locale: 'ar' });
    expect(
      within(top(container)).getByRole('button', { name: t('ar', 'mws.web.tab.code') }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('ar', 'mws.web.chat.title') })).toBeTruthy();
  });
});

describe('the live card of a web-app build', () => {
  const card = (props: Partial<Parameters<typeof WebAppRunCard>[0]> = {}) =>
    render(
      <WebAppRunCard locale="en" runId="r1" canWrite canApprove mfaFactorId={null} {...props} />,
    );
  const head = (txt: string) =>
    within(document.querySelector('.bld-run-head') as HTMLElement).getByText(txt);

  it('shows the seven agents with the status the events give, the budget, the cost and Cancel', () => {
    stream.run = run();
    stream.events = [
      ev('node_started', { node: 'requirements', attempt: 1 }),
      ev('node_succeeded', { node: 'requirements', tokensIn: 60, tokensOut: 40 }),
      ev('node_started', { node: 'architecture', attempt: 1 }),
    ];
    const { container } = card();
    expect(head(t('en', 'mws.web.run.title.working'))).toBeTruthy();
    const list = screen.getByRole('list', { name: t('en', 'm10a.run.agents') });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((l) => l.getAttribute('data-node')),
    ).toEqual(['requirements', 'architecture', 'database', 'backend', 'frontend', 'qa', 'devops']);
    expect(list.querySelector('[data-node="requirements"]')!.getAttribute('data-status')).toBe(
      'done',
    );
    expect(list.querySelector('[data-node="architecture"]')!.getAttribute('data-status')).toBe(
      'running',
    );
    expect(list.querySelector('[data-node="qa"]')!.getAttribute('data-status')).toBe('pending');
    expect(within(list).getByText(t('en', 'm10a.agent.architecture'))).toBeTruthy();
    expect(container.querySelector('.bld-orbit')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('14');
    expect(screen.getByText('600 / 1,000')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'bld.run.cancel') })).toBeTruthy();
  });

  it("waiting: this run's pending approvals are decided right here, bound to the exact action", async () => {
    stream.run = run({ state: 'waiting_approval' });
    stream.events = [ev('approval_requested', { node: 'devops' })];
    mockFetch((url) =>
      url.startsWith('/v1/ai/approvals?')
        ? json(200, {
            items: [
              {
                id: 'ap1',
                type: 'deploy_production',
                runId: 'r1',
                status: 'pending',
                scopeHash: 'h1',
                expiresAt: '2026-11-20T10:00:00Z',
              },
              {
                id: 'ap2',
                type: 'spend',
                runId: 'other',
                status: 'pending',
                scopeHash: 'h2',
                expiresAt: '2026-11-20T10:00:00Z',
              },
            ],
          })
        : json(404, {}),
    );
    card();
    expect(head(t('en', 'mws.web.run.title.approval'))).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /approve|review|reject/i }).length,
      ).toBeGreaterThan(0),
    );
    // only the approval of THIS run is listed
    expect(screen.getAllByText('h1', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText('h2', { exact: false })).toBeNull();
  });

  it('a member who cannot approve is told so', async () => {
    stream.run = run({ state: 'waiting_approval' });
    mockFetch((url) =>
      url.startsWith('/v1/ai/approvals?') ? json(200, { items: [] }) : json(404, {}),
    );
    card({ canApprove: false });
    expect(screen.getByText(t('en', 'm10a.run.needsApprover'))).toBeTruthy();
  });

  it('failed: says why, with the reasons the service recorded, and that nothing was published', () => {
    stream.run = run({
      state: 'failed',
      error: {
        code: 'budget_exceeded',
        message: 'the agent output was invalid',
        details: ['entity Patient has no fields', 'role doctor is unknown'],
      },
    });
    stream.events = [
      ev('node_started', { node: 'database', attempt: 1 }),
      ev('node_failed', { node: 'database' }),
    ];
    card();
    expect(head(t('en', 'mws.web.run.title.failed'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm10a.run.failed', { code: 'budget_exceeded' }))).toBeTruthy();
    const reasons = screen.getByText(t('en', 'mws.run.reasons')).parentElement!;
    expect(within(reasons).getByText('entity Patient has no fields')).toBeTruthy();
    expect(
      screen
        .getByRole('list', { name: t('en', 'm10a.run.agents') })
        .querySelector('[data-node="database"]')!
        .getAttribute('data-status'),
    ).toBe('failed');
  });

  it('done, cancelled and over-budget runs say so', () => {
    stream.run = run({ state: 'succeeded' });
    card();
    expect(head(t('en', 'mws.web.run.title.done'))).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    cleanup();
    stream.run = run({ state: 'cancelled' });
    card();
    expect(screen.getByText(t('en', 'bld.run.cancelledNote'))).toBeTruthy();
    cleanup();
    stream.run = run({ state: 'budget_exceeded' });
    card();
    expect(screen.getByText(t('en', 'bld.run.budgetExceeded'))).toBeTruthy();
  });

  it('the run row is re-read every few seconds so the card never stays on "working"', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stream.run = run({ state: 'running' });
    const seen: string[] = [];
    mockFetch(() => json(200, run({ state: 'succeeded' })));
    card({ onRun: (r) => seen.push(r.state) });
    const { act } = await import('@testing-library/react');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    vi.useRealTimers();
    expect(calls.some((c) => c.url === '/v1/ai/runs/r1')).toBe(true);
    expect(seen).toContain('succeeded');
  });
});
