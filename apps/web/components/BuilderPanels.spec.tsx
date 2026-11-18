// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { Deployment, SiteModel } from '../lib/builder';
import { DeploymentsPanel } from './BuilderDeployments';
import { Inspector } from './BuilderInspector';
import { PreviewPane } from './BuilderPreview';
import { ProblemNote } from './BuilderBits';

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
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return h(url, init);
    }),
  );
};

beforeEach(() => {
  // jsdom has no modal dialogs: the native element is emulated by the `open` attribute
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const future = () => new Date(Date.now() + 30 * 60_000).toISOString();
const preview = (url: string) => ({
  id: 'pv1',
  projectId: 'p1',
  versionId: 'v1',
  viewport: 'desktop',
  url,
  expiresAt: future(),
});

describe('preview pane (the sandbox is the security boundary)', () => {
  it('frames the isolated preview origin with sandbox="allow-scripts" and NO allow-same-origin, and sends no referrer', async () => {
    mockFetch(() => json(201, preview('https://tok.preview.example/ar/')));
    render(
      <PreviewPane locale="en" projectId="p1" versionId="v1" siteLocales={['ar', 'en']} canWrite />,
    );
    const frame = await screen.findByTitle(t('en', 'bld.preview.frame'));
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toBe('https://tok.preview.example/ar/');
    // the unguessable URL is never shown as text
    expect(document.body.textContent).not.toContain('tok.preview.example');
  });
  it('switches the site language of the same preview and the viewport width', async () => {
    mockFetch(() => json(201, preview('https://tok.preview.example/ar/')));
    render(
      <PreviewPane locale="en" projectId="p1" versionId="v1" siteLocales={['ar', 'en']} canWrite />,
    );
    const frame = await screen.findByTitle(t('en', 'bld.preview.frame'));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.lang.en') }));
    await waitFor(() =>
      expect(screen.getByTitle(t('en', 'bld.preview.frame')).getAttribute('src')).toBe(
        'https://tok.preview.example/en/',
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: t('en', 'bld.preview.mobile', { width: 375 }) }),
    );
    expect((screen.getByTitle(t('en', 'bld.preview.frame')) as HTMLElement).style.inlineSize).toBe(
      '375px',
    );
    expect(frame).toBeTruthy();
  });
  it('never frames a URL that is not http(s)', async () => {
    mockFetch(() => json(201, preview('javascript:alert(1)')));
    render(<PreviewPane locale="en" projectId="p1" versionId="v1" siteLocales={['en']} canWrite />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByTitle(t('en', 'bld.preview.frame'))).toBeNull();
  });
  it('a viewer makes no preview call and is told why', () => {
    mockFetch(() => json(500, {}));
    render(
      <PreviewPane
        locale="ar"
        projectId="p1"
        versionId="v1"
        siteLocales={['ar']}
        canWrite={false}
      />,
    );
    expect(calls).toHaveLength(0);
    expect(screen.getAllByText(t('ar', 'bld.preview.needsWriter')).length).toBeGreaterThan(0);
  });
});

const model: SiteModel = {
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  brand: { name: { ar: 'م', en: 'S' } },
  seo: { siteTitle: { ar: 'م', en: 'S' }, description: { ar: 'و', en: 'D' } },
  forms: [],
  pages: [
    {
      id: 'home',
      slug: 'home',
      title: { ar: 'الرئيسية', en: 'Home' },
      sections: [
        { id: 'hero1', type: 'hero', props: { heading: { ar: 'مرحبا', en: 'Welcome' } } },
        { id: 'text1', type: 'text', props: { body: { ar: 'ن', en: 'T' } } },
      ],
    },
  ],
};
const inspector = (over: Partial<Parameters<typeof Inspector>[0]> = {}) => {
  const apply = vi.fn(async () => true);
  const props = {
    locale: 'en' as const,
    model,
    versionId: 'v1',
    selection: { pageId: 'home', sectionId: 'hero1' },
    onSelect: vi.fn(),
    canWrite: true,
    busy: false,
    apply,
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    last: null,
    problem: null,
    conflict: null,
    onReload: vi.fn(),
    onRebase: vi.fn(),
    ...over,
  };
  return { apply, ...render(<Inspector {...props} />) };
};

describe('inspector', () => {
  it('Apply sends one setText for the edited language only', () => {
    const { apply } = inspector();
    const label = `${t('en', 'bld.prop.heading')} (${t('en', 'bld.lang.en')})`;
    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.value).toBe('Welcome');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.insp.apply') }));
    expect(apply).toHaveBeenCalledWith([
      {
        op: 'setText',
        target: 'section',
        pageId: 'home',
        sectionId: 'hero1',
        prop: 'heading',
        locale: 'en',
        value: 'Hello',
      },
    ]);
  });
  it('Apply is disabled until something changed', () => {
    inspector();
    expect(
      (screen.getByRole('button', { name: t('en', 'bld.insp.apply') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('the outline lists every component as a button and selecting one reports it', () => {
    const { apply } = inspector();
    const nav = screen.getByRole('navigation', { name: t('en', 'bld.outline.label') });
    const buttons = nav.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(apply).not.toHaveBeenCalled();
  });
  it('a viewer sees the values but has no way to change anything', () => {
    inspector({ canWrite: false });
    expect(screen.getByText(t('en', 'bld.readonly'))).toBeTruthy();
    for (const k of [
      'bld.insp.apply',
      'bld.insp.moveUp',
      'bld.insp.delete',
      'bld.insp.undo',
    ] as const)
      expect(screen.queryByRole('button', { name: t('en', k) })).toBeNull();
    const label = `${t('en', 'bld.prop.heading')} (${t('en', 'bld.lang.en')})`;
    expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
  });
  it('a stale base offers reload and rebase; invalid ops list their issues', () => {
    inspector({ conflict: { headSeq: 9 } });
    expect(screen.getByText(t('en', 'bld.conflict.bodyAt', { seq: 9 }))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'bld.conflict.reload') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'bld.conflict.rebase') })).toBeTruthy();
    cleanup();
    render(
      <ProblemNote
        locale="en"
        problem={{
          status: 422,
          code: 'op_invalid',
          issues: [{ path: '$.pages[0].title.ar', message: 'missing ar text' }],
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('$.pages[0].title.ar');
  });
});

const dep = (over: Partial<Deployment> = {}): Deployment => ({
  id: 'd1',
  projectId: 'p1',
  versionId: 'v1',
  target: { kind: 'hosting_site', hostingSiteId: 's1' },
  environment: 'production',
  state: 'succeeded',
  operationId: null,
  artifactHash: null,
  previousDeploymentId: null,
  rollbackOf: null,
  url: null,
  smoke: null,
  error: null,
  createdAt: '2027-01-01T00:00:00.000Z',
  finishedAt: null,
  ...over,
});
const panel = () =>
  render(
    <DeploymentsPanel
      locale="en"
      projectId="p1"
      projectName="Oasis"
      headSeq={3}
      initial={[]}
      sites={[{ id: 's1', name: 'main-site', status: 'active', primaryDomain: null }]}
      canWrite
    />,
  );

describe('publishing: the two-step human approval', () => {
  it('the first call asks for the approval; only the confirmation repeats it with the approval id and a NEW idempotency key', async () => {
    let n = 0;
    mockFetch((url, init) => {
      if (init.method === 'POST' && url === '/v1/deployments')
        return n++ === 0
          ? json(403, { code: 'approval_required', approvalId: 'ap1', kind: 'publish' })
          : json(202, dep({ state: 'queued' }));
      return json(200, { items: [] });
    });
    panel();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.dep.publish') }));
    const confirm = await screen.findByRole('button', { name: t('en', 'bld.dep.confirm.go') });
    // nothing was published by the first call
    expect(calls.filter((c) => c.url === '/v1/deployments' && c.method === 'POST')).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ projectId: 'p1', target: 's1', environment: 'production' });
    // the cost disclosure and what is approved are shown before the confirmation
    expect(screen.getByText(t('en', 'bld.dep.cost.none'), { exact: false })).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/v1/deployments' && c.method === 'POST')).toHaveLength(
        2,
      ),
    );
    const [first, second] = calls.filter((c) => c.url === '/v1/deployments' && c.method === 'POST');
    expect(second!.body).toEqual({
      projectId: 'p1',
      target: 's1',
      environment: 'production',
      approvalId: 'ap1',
    });
    expect(first!.headers['idempotency-key']).toBeTruthy();
    expect(second!.headers['idempotency-key']).toBeTruthy();
    expect(second!.headers['idempotency-key']).not.toBe(first!.headers['idempotency-key']);
  });
  it('without a publish path the screen explains that live publishing is blocked, instead of a generic error', async () => {
    mockFetch(() => json(422, { code: 'unsupported_capability' }));
    panel();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.dep.publish') }));
    expect(await screen.findByText(t('en', 'bld.dep.noPath.title'))).toBeTruthy();
    expect(screen.getByText(/HG-06-01/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'bld.dep.confirm.go') })).toBeNull();
  });
  it('a viewer cannot publish and sees the read-only notice', () => {
    mockFetch(() => json(200, { items: [] }));
    render(
      <DeploymentsPanel
        locale="ar"
        projectId="p1"
        projectName="م"
        headSeq={1}
        initial={[]}
        sites={[]}
        canWrite={false}
      />,
    );
    expect(screen.queryByRole('button', { name: t('ar', 'bld.dep.publish') })).toBeNull();
    expect(screen.getByText(t('ar', 'bld.readonly'))).toBeTruthy();
  });
});
