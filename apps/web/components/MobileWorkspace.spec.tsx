// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { Run, RunEvent } from '../lib/builder';
import { previewSpec } from '../lib/mobile';

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
import { MobileCode } from './MobileCode';
import { PhonePreview } from './MobilePhone';
import { MobileRunCard } from './MobileRun';
import { MobileWorkspace, type MobileCan } from './MobileWorkspace';

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
  vi.useRealTimers();
});

const SPEC = {
  schemaVersion: 1,
  app: { name: { ar: 'مهام الميدان', en: 'Field Tasks' }, packageId: 'sa.nuzm.field_tasks' },
  theme: { primary: '#0B6E4F', dark: false },
  defaultLocale: 'en',
  auth: { enabled: true },
  screens: [
    {
      id: 'home',
      kind: 'home',
      title: { ar: 'الرئيسية', en: 'Home' },
      body: { ar: 'مرحبًا', en: 'Welcome' },
    },
    {
      id: 'tasks',
      kind: 'list',
      title: { ar: 'المهام', en: 'Tasks' },
      items: [
        { title: { ar: 'زيارة', en: 'Visit the site' }, subtitle: { ar: 'غدًا', en: 'Tomorrow' } },
      ],
    },
    {
      id: 'new_task',
      kind: 'form',
      title: { ar: 'مهمة جديدة', en: 'New task' },
      fields: [
        { id: 'title', label: { ar: 'العنوان', en: 'Title' }, type: 'text', required: true },
        { id: 'urgent', label: { ar: 'عاجلة', en: 'Urgent' }, type: 'switch' },
      ],
    },
    { id: 'settings', kind: 'settings', title: { ar: 'الإعدادات', en: 'Settings' } },
  ],
  navigation: { initial: 'home', tabs: ['home', 'tasks', 'new_task', 'settings'] },
  permissions: [],
};
const manifest = {
  kind: 'mobile',
  fileCount: 22,
  generator: { flutter: '3.35.7', dart: '3.9.2' },
  spec: SPEC,
};
const empty = { kind: 'mobile', fileCount: 0, spec: null };
const usage = { spentCredits: '26', tokensIn: 100, tokensOut: 500 };
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
    kind: 'mobile',
    state: 'running',
    step: null,
    usage,
    error: null,
    pendingApproval: null,
    artifacts: [],
    ...over,
  }) as unknown as Run;
const ALL: MobileCan = { ai: true, describe: true, build: true, signing: true, release: true };

const ws = (
  over: Partial<Parameters<typeof MobileWorkspace>[0]> = {},
  can: Partial<MobileCan> = {},
) =>
  render(
    <MobileWorkspace
      locale="en"
      initial={{ id: 'p1', name: 'My field app', versionId: 'v1', versionSeq: 2, manifest }}
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
      userId="u1"
      {...over}
      can={{ ...ALL, ...can }}
    />,
  );

describe('mobile workspace: the same full-screen workspace as the website builder', () => {
  it('has the website top bar with mobile controls: Preview | Code | Spec | Builds | Signing | Releases, device, language, theme, Build, close', () => {
    const { container } = ws();
    const top = container.querySelector('.bws-top') as HTMLElement;
    expect(within(top).getByText('My field app')).toBeTruthy();
    for (const k of ['preview', 'code', 'spec', 'builds', 'signing', 'releases'])
      expect(
        within(top).getByRole('button', { name: t('en', `mws.tab.${k}` as 'mws.tab.preview') }),
      ).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'mws.device.phone') })).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'mws.device.tablet') })).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'bld.lang.ar') })).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'mws.theme.dark') })).toBeTruthy();
    // a Build button instead of Publish, and no website-only controls
    expect(within(top).getByRole('button', { name: t('en', 'mws.build') })).toBeTruthy();
    expect(within(top).queryByRole('link', { name: t('en', 'bld.ws.publish') })).toBeNull();
    expect(within(top).queryByRole('button', { name: t('en', 'bld.ws.undo') })).toBeNull();
    expect(
      within(top)
        .getByRole('link', { name: t('en', 'bld.ws.back') })
        .getAttribute('href'),
    ).toBe('/builder/projects?type=mobile');
    expect(within(top).getByRole('link', { name: t('en', 'bld.ws.exit') })).toBeTruthy();
  });

  it('lists only the panels the member may open (no signing without mobile:signing, no builds without mobile:build)', () => {
    const { container } = ws({}, { signing: false, build: false });
    const top = container.querySelector('.bws-top') as HTMLElement;
    expect(within(top).queryByRole('button', { name: t('en', 'mws.tab.signing') })).toBeNull();
    expect(within(top).queryByRole('button', { name: t('en', 'mws.tab.builds') })).toBeNull();
    expect(within(top).queryByRole('button', { name: t('en', 'mws.build') })).toBeNull();
    expect(within(top).getByRole('button', { name: t('en', 'mws.tab.releases') })).toBeTruthy();
  });

  it('a link to a panel the member may not open (?tab=signing) shows the forbidden state, and never calls the API', () => {
    ws({ initialTab: 'signing' }, { signing: false });
    expect(screen.getByText(t('en', 'state.forbidden.title'))).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('opens on the preview: the honest notice, the phone frame of the approved design and its bottom navigation', () => {
    ws();
    expect(screen.getByText(t('en', 'mobile.preview.notice'))).toBeTruthy();
    const frame = screen.getByRole('group', {
      name: t('en', 'mws.preview.frameOf', { name: 'Field Tasks' }),
    });
    expect(within(frame).getAllByText('Welcome').length).toBe(1);
    const nav = within(frame).getByRole('navigation', { name: t('en', 'mws.preview.tabs') });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Home', 'Tasks', 'New task', 'Settings']);
    // no iframe, no script: plain HTML drawn from the spec
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('a bottom tab switches the screen; Arabic flips the frame to right-to-left; dark and tablet change the frame', () => {
    const { container } = ws();
    const frame = () => container.querySelector('.mws-device') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(within(frame()).getByText('Visit the site')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(within(frame()).getByText('Title *')).toBeTruthy();
    expect(within(frame()).getByText('Submit')).toBeTruthy();
    const screenEl = () => container.querySelector('.mws-screen') as HTMLElement;
    expect(screenEl().getAttribute('dir')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.lang.ar') }));
    expect(screenEl().getAttribute('dir')).toBe('rtl');
    expect(screenEl().getAttribute('lang')).toBe('ar');
    expect(within(frame()).getByText('العنوان *')).toBeTruthy();
    expect(screenEl().getAttribute('data-dark')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.theme.dark') }));
    expect(screenEl().getAttribute('data-dark')).toBe('true');
    expect(frame().getAttribute('data-device')).toBe('phone');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.device.tablet') }));
    expect(frame().getAttribute('data-device')).toBe('tablet');
  });

  it('the theme primary colour reaches the frame', () => {
    const { container } = ws();
    expect(
      (container.querySelector('.mws-screen') as HTMLElement).style.getPropertyValue('--m-primary'),
    ).toBe('#0B6E4F');
  });

  it('a project with no design yet says so, in the preview and in the spec and code panels', async () => {
    mockFetch((url) => (url.includes('/files') ? json(200, { items: [] }) : json(404, {})));
    ws({ initial: { id: 'p1', name: 'x', versionId: 'v0', versionSeq: 1, manifest: empty } });
    expect(screen.getByText(t('en', 'mws.preview.emptyTitle'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.tab.spec') }));
    expect(screen.getByText(t('en', 'mobile.preview.empty.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.tab.code') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mws.code.none'))).toBeTruthy());
  });

  it('the Spec panel lists the app id, theme, sign-in and screens; Build opens the Builds panel and lists builds from the API', async () => {
    mockFetch((url) =>
      url.startsWith('/v1/mobile/builds') ? json(200, { items: [] }) : json(404, {}),
    );
    ws();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.tab.spec') }));
    expect(screen.getByText('sa.nuzm.field_tasks')).toBeTruthy();
    expect(screen.getByText(t('en', 'mws.spec.authOn'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.build') }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: t('en', 'mobile.builds.request') })).toBeTruthy(),
    );
    expect(calls.some((c) => c.url.startsWith('/v1/mobile/builds') && c.method === 'GET')).toBe(
      true,
    );
    // the honest labels stay: iOS is blocked, a debug build is unsigned
    fireEvent.change(screen.getByLabelText(t('en', 'mobile.builds.platform')), {
      target: { value: 'ios' },
    });
    expect(screen.getByText(t('en', 'mobile.builds.iosNotice'))).toBeTruthy();
  });

  it('the tab is kept in the address (?tab=) without a navigation, so a reload or a shared link opens the same panel', () => {
    ws();
    const replace = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mws.tab.builds') }));
    expect(String(replace.mock.calls.at(-1)?.[2])).toContain('tab=builds');
    replace.mockRestore();
  });

  it('Signing takes references only: no password, file or key field; a failed load says so and can be retried', async () => {
    let tries = 0;
    mockFetch((url) => {
      if (!url.startsWith('/v1/mobile/signing-credentials')) return json(404, {});
      tries += 1;
      return tries === 1 ? json(500, {}) : json(200, { items: [] });
    });
    ws({ initialTab: 'signing' });
    await waitFor(() => expect(screen.getByText(t('en', 'mws.panel.loadError'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.retry') }));
    await waitFor(() =>
      expect(screen.getByLabelText(t('en', 'mobile.signing.vaultRef'))).toBeTruthy(),
    );
    expect(
      document.querySelectorAll('input[type=password], input[type=file], textarea.nz-input'),
    ).toHaveLength(0);
  });

  it('Releases: the wizard opens in place (also from the old /releases/new link), shows the account-owner approval note and offers no store submission', async () => {
    const okBuild = {
      id: '018f0000-0000-7000-8000-0000000000b1',
      projectId: 'p1',
      versionId: 'v1',
      platform: 'android',
      profile: 'release',
      status: 'succeeded',
      runner: 'x',
      isolation: 'none',
      signed: true,
      minutesBilled: 1,
      toolchain: {},
      notices: [],
      createdAt: '2026-11-19T10:00:00.000Z',
    };
    mockFetch((url) =>
      url.startsWith('/v1/mobile/releases')
        ? json(200, { items: [] })
        : url.startsWith('/v1/mobile/builds')
          ? json(200, { items: [okBuild] })
          : json(404, {}),
    );
    ws({ initialTab: 'releases' });
    await waitFor(() =>
      expect(screen.getByText(t('en', 'mobile.releases.empty.title'))).toBeTruthy(),
    );
    expect(screen.getByText(t('en', 'mobile.releases.noSubmit'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'mobile.releases.new') }));
    await waitFor(() => expect(screen.getByText(t('en', 'mobile.wizard.ownerNote'))).toBeTruthy());
    expect(screen.getByRole('button', { name: t('en', 'mobile.wizard.saveDraft') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /submit|publish/i })).toBeNull();
    cleanup();
    mockFetch(() => json(200, { items: [] }));
    ws({ initialTab: 'releases', startRelease: true });
    expect(screen.getByRole('heading', { name: t('en', 'mobile.title.releaseNew') })).toBeTruthy();
  });

  it('the composer starts a `mobile` run with the description (a new design), stores it as a chat message, and the run card appears', async () => {
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
    const box = screen.getByLabelText(t('en', 'bld.chat.input'));
    expect(screen.getByRole('heading', { name: t('en', 'mws.chat.title') })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'A booking app for padel courts' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.chat.send') }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/ai/runs')).toBe(true));
    const post = calls.find((c) => c.url === '/v1/ai/runs')!;
    expect(post.body).toMatchObject({
      sessionId: 's1',
      kind: 'mobile',
      projectId: 'p1',
      input: { description: 'A booking app for padel courts' },
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: t('en', 'mws.run.label') })).toBeTruthy(),
    );
    // one active run per session: the composer waits
    expect((screen.getByLabelText(t('en', 'bld.chat.input')) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it('a request shorter than 3 characters is not sent', () => {
    ws();
    fireEvent.change(screen.getByLabelText(t('en', 'bld.chat.input')), { target: { value: 'ab' } });
    expect(
      (screen.getByRole('button', { name: t('en', 'bld.chat.send') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('a member who cannot write sees the conversation and a read-only notice, not the composer', () => {
    ws({}, { describe: false, ai: false });
    expect(screen.queryByLabelText(t('en', 'bld.chat.input'))).toBeNull();
    expect(screen.getAllByText(t('en', 'bld.readonly')).length).toBeGreaterThan(0);
  });

  it('while the design waits for approval the preview draws the PROPOSED design, labelled as not approved', async () => {
    const id = '018f0000-0000-7000-8000-0000000000aa';
    mockFetch((url) =>
      url === `/v1/ai/runs/r1/artifacts/${id}` ? json(200, { payload: SPEC }) : json(404, {}),
    );
    const waiting = run({
      state: 'waiting_approval',
      pendingApproval: {
        id: 'a1',
        kind: 'plan',
        expiresAt: '2026-11-20T10:00:00Z',
        summary: {
          appName: SPEC.app.name,
          artifactId: id,
          screens: [],
          tabs: [],
          permissions: ['internet'],
        },
      },
    });
    stream.run = waiting;
    stream.changed = waiting;
    ws({
      initial: { id: 'p1', name: 'x', versionId: 'v0', versionSeq: 1, manifest: empty },
      initialRun: waiting,
    });
    await waitFor(() => expect(screen.getByText(t('en', 'mws.preview.proposed'))).toBeTruthy());
    expect(screen.getAllByText('Welcome').length).toBeGreaterThan(0);
  });
});

describe('phone preview of the generated screens', () => {
  const spec = previewSpec(SPEC)!;
  const draw = (lang: 'ar' | 'en', dark: boolean, device: 'phone' | 'tablet' = 'phone') =>
    render(<PhonePreview locale="en" spec={spec} device={device} lang={lang} dark={dark} />);
  it('draws every screen kind the design can have (home, list, form, detail, settings) and the bottom navigation from navigation.tabs', () => {
    draw('en', false);
    expect(screen.getByText('Welcome')).toBeTruthy(); // home
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByText('Tomorrow')).toBeTruthy(); // list: title and subtitle
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByText('Urgent')).toBeTruthy(); // form: a switch field
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Sign out')).toBeTruthy(); // settings with sign-in on
    expect(screen.getByText('Appearance')).toBeTruthy();
  });
  it('detail screens show their text; a list with no items says there is nothing yet; no sign-out without sign-in', () => {
    const detail = previewSpec({
      ...SPEC,
      auth: { enabled: false },
      screens: [
        {
          id: 'about',
          kind: 'detail',
          title: { ar: 'عن', en: 'About' },
          body: { ar: 'نص', en: 'About text' },
        },
        { id: 'items', kind: 'list', title: { ar: 'ق', en: 'Items' } },
        { id: 'settings', kind: 'settings', title: { ar: 'ض', en: 'Settings' } },
      ],
      navigation: { initial: 'about', tabs: ['about', 'items', 'settings'] },
    })!;
    render(<PhonePreview locale="en" spec={detail} device="phone" lang="en" dark />);
    expect(screen.getByText('About text')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Items' }));
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.queryByText('Sign out')).toBeNull();
  });
  it('Arabic uses the Arabic text of the design and the Arabic text of the app chrome, right to left', () => {
    const { container } = draw('ar', true);
    expect(container.querySelector('.mws-screen')!.getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('button', { name: 'المهام' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }));
    expect(screen.getByText('تسجيل الخروج')).toBeTruthy();
  });
  it('a one-tab app has no bottom navigation', () => {
    const one = previewSpec({ ...SPEC, navigation: { initial: 'home', tabs: ['home'] } })!;
    render(<PhonePreview locale="en" spec={one} device="phone" lang="en" dark={false} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('draws design text as text, never as markup', () => {
    const evil = previewSpec({
      ...SPEC,
      screens: [
        {
          id: 'home',
          kind: 'home',
          title: { ar: 'a', en: '<img src=x onerror=alert(1)>' },
          body: { ar: 'a', en: '<script>1</script>' },
        },
      ],
      navigation: { initial: 'home', tabs: ['home'] },
    })!;
    const { container } = render(
      <PhonePreview locale="en" spec={evil} device="phone" lang="en" dark={false} />,
    );
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('<script>1</script>')).toBeTruthy();
  });
});

describe('the run card of a mobile run (live)', () => {
  const head = (txt: string) =>
    within(document.querySelector('.bld-run-head') as HTMLElement).getByText(txt);
  const card = (canWrite = true, onRun?: (r: Run) => void) =>
    render(<MobileRunCard locale="en" runId="r1" canWrite={canWrite} onRun={onRun} />);
  it('queued, designing: a loader, a progress bar, the four steps, the cost and Cancel', () => {
    stream.run = run({ state: 'queued' });
    const { container } = card();
    expect(head(t('en', 'mws.run.title.queued'))).toBeTruthy();
    stream.run = run({ state: 'running' });
    stream.events = [ev('step_started', { task: 'mobile_design' })];
    cleanup();
    const r = card();
    expect(head(t('en', 'mws.run.title.designing'))).toBeTruthy();
    expect(r.container.querySelector('.bld-orbit')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: t('en', 'bld.run.events') }));
    expect(steps.getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      t('en', 'mws.stage.design'),
      t('en', 'mws.stage.approval'),
      t('en', 'mws.stage.generate'),
      t('en', 'mws.stage.analysis'),
    ]);
    expect(screen.getByRole('button', { name: t('en', 'bld.run.cancel') })).toBeTruthy();
    expect(container).toBeTruthy();
  });
  it('design ready: the design to approve or decline inline, and nothing is generated before the decision', async () => {
    stream.run = run({
      state: 'waiting_approval',
      pendingApproval: {
        id: 'a1',
        kind: 'plan',
        expiresAt: '2026-11-20T10:00:00Z',
        summary: {
          appName: { ar: 'م', en: 'Field Tasks' },
          applicationId: 'sa.nuzm.field_tasks',
          screens: [
            { id: 'home', kind: 'home', title: { ar: 'ر', en: 'Home' } },
            { id: 'tasks', kind: 'list', title: { ar: 'م', en: 'Tasks' } },
          ],
          tabs: ['home'],
          permissions: ['internet', 'camera'],
        },
      },
    });
    stream.events = [ev('approval_requested')];
    mockFetch(() => json(200, run({ state: 'running' })));
    card();
    expect(head(t('en', 'mws.run.title.approval'))).toBeTruthy();
    expect(screen.getByText('sa.nuzm.field_tasks')).toBeTruthy();
    expect(screen.getByText(t('en', 'mws.approval.note'))).toBeTruthy();
    const list = within(screen.getByRole('list', { name: t('en', 'mws.approval.screens') }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.approval.approve') }));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/ai/runs/r1/approvals')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/ai/runs/r1/approvals')!.body).toEqual({
      approvalId: 'a1',
      decision: 'approve',
    });
    await waitFor(() => expect(stream.reconnect).toHaveBeenCalled());
  });
  it('declining sends deny; a member who cannot write is told so and gets no buttons', async () => {
    const waiting = run({
      state: 'waiting_approval',
      pendingApproval: { id: 'a1', kind: 'plan', expiresAt: '2026-11-20T10:00:00Z', summary: {} },
    });
    stream.run = waiting;
    mockFetch(() => json(200, run({ state: 'failed' })));
    card();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.approval.deny') }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ approvalId: 'a1', decision: 'deny' }));
    cleanup();
    card(false);
    expect(screen.queryByRole('button', { name: t('en', 'bld.approval.approve') })).toBeNull();
    expect(screen.getByText(t('en', 'bld.approval.needsWriter'))).toBeTruthy();
  });
  it('generating, then done', () => {
    stream.run = run({ state: 'running' });
    stream.events = [ev('approval_requested'), ev('approval_approved')];
    card();
    expect(head(t('en', 'mws.run.title.generating'))).toBeTruthy();
    cleanup();
    stream.run = run({ state: 'succeeded' });
    card();
    expect(head(t('en', 'mws.run.title.done'))).toBeTruthy();
    expect(screen.getByText(t('en', 'mws.run.doneNote'))).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
  it('failed: says why, with the reasons the service recorded, and that nothing was changed', () => {
    stream.run = run({
      state: 'failed',
      error: {
        code: 'validation_failed',
        message: 'the design is not a valid mobile spec',
        details: ['screen id login is reserved', 'navigation.tabs must be 1 to 5 screens'],
      },
    });
    stream.events = [ev('step_started', { task: 'mobile_design' })];
    card();
    expect(
      screen.getByText(t('en', 'mws.run.failedNote', { code: 'validation_failed' })),
    ).toBeTruthy();
    const reasons = screen.getByText(t('en', 'mws.run.reasons')).parentElement!;
    expect(within(reasons).getByText('screen id login is reserved')).toBeTruthy();
    expect(within(reasons).getByText('navigation.tabs must be 1 to 5 screens')).toBeTruthy();
    expect(screen.getByText(t('en', 'mws.run.retryHint'))).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('a failure with only a message shows that message; cancelled and over-budget runs say so', () => {
    stream.run = run({
      state: 'failed',
      error: { code: 'internal_error', message: 'something broke' },
    });
    card();
    expect(screen.getByText('something broke')).toBeTruthy();
    cleanup();
    stream.run = run({ state: 'cancelled' });
    card();
    expect(screen.getByText(t('en', 'mws.run.cancelledNote'))).toBeTruthy();
    cleanup();
    stream.run = run({ state: 'budget_exceeded' });
    card();
    expect(screen.getByText(t('en', 'bld.run.budgetExceeded'))).toBeTruthy();
  });
  it('never stays on "Running": besides the stream the run row is re-read every few seconds and the new state is reported', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stream.run = run({ state: 'running' });
    const seen: string[] = [];
    mockFetch(() => json(200, run({ state: 'succeeded' })));
    card(true, (r) => seen.push(r.state));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(calls.some((c) => c.url === '/v1/ai/runs/r1')).toBe(true);
    expect(stream.setRun).toHaveBeenCalled();
    expect(seen).toContain('succeeded');
  });
});

describe('Arabic and right-to-left', () => {
  it('the workspace speaks Arabic: tabs, chat title, the honest notice and the start of the run card', () => {
    stream.run = run({ state: 'running' });
    ws({ locale: 'ar' });
    expect(screen.getByRole('button', { name: t('ar', 'mws.tab.preview') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('ar', 'mws.chat.title') })).toBeTruthy();
    expect(screen.getByText(t('ar', 'mobile.preview.notice'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('ar', 'mws.build') })).toBeTruthy();
  });
});

describe('Code: the generated Flutter files', () => {
  const files = [
    { path: 'pubspec.yaml', size: 400, mime: 'text/plain', contentHash: '' },
    { path: 'lib/main.dart', size: 120, mime: 'text/plain', contentHash: '' },
  ];
  it("shows the file tree and opens a file read-only; the files API is the website code tab's", async () => {
    mockFetch((url) =>
      url.startsWith('/v1/builder/projects/p1/files/content')
        ? json(200, {
            path: 'lib/main.dart',
            mime: 'text/plain',
            size: 120,
            encoding: 'utf8',
            content: 'void main() {\n  runApp(App());\n}\n',
          })
        : url.startsWith('/v1/builder/projects/p1/files')
          ? json(200, { items: files })
          : json(404, {}),
    );
    render(<MobileCode locale="en" projectId="p1" versionId="v1" />);
    await waitFor(() => expect(screen.getByText('pubspec.yaml')).toBeTruthy());
    expect(screen.getByText(t('en', 'mws.code.count', { n: 2, size: '520 B' }))).toBeTruthy();
    fireEvent.click(screen.getByText('lib'));
    fireEvent.click(screen.getByRole('button', { name: 'main.dart' }));
    await waitFor(() => expect(screen.getByText('runApp(App());')).toBeTruthy());
    expect(screen.getByText(t('en', 'bld.cx.readonly'))).toBeTruthy();
    expect(document.querySelector('textarea, [contenteditable]')).toBeNull();
    expect(calls[0]!.url).toContain('versionId=v1');
  });
  it('a failed list shows the error, an unreadable file is not executed', async () => {
    mockFetch(() => json(500, {}));
    render(<MobileCode locale="en" projectId="p1" versionId={null} />);
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });
});
