// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type {
  KnowledgeDetail,
  KnowledgePage,
  KnowledgeResource as Resource,
} from '../lib/knowledge';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
import { KnowledgeLibrary } from './KnowledgeLibrary';
import { KnowledgeResource } from './KnowledgeResource';
import { KnowledgeUpload } from './KnowledgeUpload';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}
let seen: Seen[] = [];
type Handler = (s: Seen) => Response | Promise<Response> | undefined;
const RealRequest = globalThis.Request;
const mockFetch = (h: Handler) => {
  seen = [];
  // browsers resolve a relative URL against the page; Node's Request needs an absolute one
  vi.stubGlobal(
    'Request',
    class extends RealRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input,
          init,
        );
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : null;
      const entry: Seen = {
        method: (req?.method ?? init.method ?? 'GET').toUpperCase(),
        url: req ? new URL(req.url).pathname : String(input),
        headers: new Headers(req?.headers ?? (init.headers as HeadersInit | undefined)),
        body: req
          ? await req
              .clone()
              .text()
              .catch(() => '')
          : init.body,
      };
      seen.push(entry);
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return (await h(entry)) ?? json(404, {});
    }),
  );
};
beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
  // jsdom's Blob has no arrayBuffer(): the upload engine reads file slices through it
  if (!Blob.prototype.arrayBuffer)
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as ArrayBuffer);
        r.onerror = () => rej(r.error);
        r.readAsArrayBuffer(this);
      });
    };
  document.cookie = 'nuzm_admin_csrf=csrf-123';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const resource = (over: Partial<Resource> = {}): Resource => ({
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Modern SaaS',
  slug: 'modern-saas',
  description: 'A dashboard theme',
  resourceType: 'THEME',
  platform: 'WEB',
  frameworks: ['nextjs'],
  languages: ['typescript'],
  category: 'dashboard',
  tags: ['saas'],
  visibility: 'PLATFORM_PRIVATE',
  sourceKind: 'upload',
  status: 'QUARANTINED',
  currentVersionId: 'v1',
  defaultEligible: false,
  dataRegion: 'sa-central',
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-20T11:00:00Z',
  version: 2,
  ...over,
});
const detail = (over: Partial<KnowledgeDetail> = {}): KnowledgeDetail => ({
  ...resource(),
  permissions: {
    reuseScope: 'NONE',
    aiProcessing: false,
    componentReuse: false,
    starterEligible: false,
    architectureReference: false,
    licenseSpdx: 'MIT',
    licenseVerdict: 'UNKNOWN',
  },
  currentVersion: {
    id: 'v1',
    seq: 1,
    state: 'QUARANTINED',
    licenseVerdict: 'UNKNOWN',
    bytes: 1048576,
    checksumSha256: 'a'.repeat(64),
  },
  manifest: null,
  quality: [],
  componentCount: 0,
  jobs: [],
  ...over,
});
const versions = [
  {
    id: 'v1',
    seq: 1,
    semver: null,
    state: 'QUARANTINED',
    checksumSha256: 'a'.repeat(64),
    bytes: 1048576,
    sourceCommit: null,
    licenseVerdict: 'UNKNOWN',
    createdAt: '2026-11-20T10:00:00Z',
    activatedAt: null,
  },
];

describe('Knowledge library list', () => {
  const page: KnowledgePage = {
    items: [
      resource(),
      resource({
        id: '00000000-0000-7000-8000-000000000002',
        name: 'مكتبة مكوّنات',
        resourceType: 'COMPONENT_LIBRARY',
        status: 'ACTIVE',
        frameworks: [],
      }),
    ],
    nextCursor: 'CURSOR',
  };
  it('lists resources with localized status and type, each linking to its page', () => {
    render(<KnowledgeLibrary locale="en" page={page} filters={{}} canManage />);
    expect(screen.getByText('Modern SaaS')).toBeTruthy();
    expect(
      screen.getByText(t('en', 'kn.status.QUARANTINED'), { selector: '.nz-badge' }),
    ).toBeTruthy();
    expect(screen.getByText(t('en', 'kn.status.ACTIVE'), { selector: '.nz-badge' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /manage/i })[0]!.getAttribute('href')).toBe(
      '/en/ai-intelligence/library/00000000-0000-7000-8000-000000000001',
    );
  });
  it('renders Arabic labels', () => {
    render(<KnowledgeLibrary locale="ar" page={page} filters={{}} canManage />);
    expect(
      screen.getByText(t('ar', 'kn.status.QUARANTINED'), { selector: '.nz-badge' }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(t('ar', 'kn.type.COMPONENT_LIBRARY'), { selector: 'td, td *' }).length,
    ).toBeGreaterThan(0);
  });
  it('keeps the filters in a GET form, offers reset only when filtered, and "show more" carries the cursor and the filters', () => {
    const { container, rerender } = render(
      <KnowledgeLibrary
        locale="en"
        page={page}
        filters={{ type: 'THEME', q: 'saas' }}
        canManage={false}
      />,
    );
    const form = container.querySelector('form[role="search"]') as HTMLFormElement;
    expect(form.getAttribute('method')).toBe('get');
    expect((screen.getByLabelText(t('en', 'kn.filter.type')) as HTMLSelectElement).value).toBe(
      'THEME',
    );
    expect((screen.getByLabelText(t('en', 'kn.filter.search')) as HTMLInputElement).value).toBe(
      'saas',
    );
    expect(
      screen.getByRole('link', { name: t('en', 'kn.filter.reset') }).getAttribute('href'),
    ).toBe('?');
    expect(screen.getByRole('link', { name: t('en', 'kn.more') }).getAttribute('href')).toBe(
      '?type=THEME&q=saas&cursor=CURSOR',
    );
    rerender(
      <KnowledgeLibrary
        locale="en"
        page={{ items: page.items, nextCursor: null }}
        filters={{}}
        canManage={false}
      />,
    );
    expect(screen.queryByRole('link', { name: t('en', 'kn.filter.reset') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('en', 'kn.more') })).toBeNull();
  });
  it('shows the empty state, and a different one when filters hide everything', () => {
    const { rerender } = render(
      <KnowledgeLibrary
        locale="en"
        page={{ items: [], nextCursor: null }}
        filters={{}}
        canManage
      />,
    );
    expect(screen.getByText(t('en', 'kn.empty.title'))).toBeTruthy();
    rerender(
      <KnowledgeLibrary
        locale="en"
        page={{ items: [], nextCursor: null }}
        filters={{ status: 'FAILED' }}
        canManage
      />,
    );
    expect(screen.getByText(t('en', 'kn.empty.filtered.title'))).toBeTruthy();
  });
  it('offers upload only to staff who may manage', () => {
    const { rerender } = render(
      <KnowledgeLibrary locale="en" page={page} filters={{}} canManage={false} />,
    );
    expect(screen.queryByRole('button', { name: t('en', 'kn.up.button') })).toBeNull();
    rerender(<KnowledgeLibrary locale="en" page={page} filters={{}} canManage />);
    expect(screen.getByRole('button', { name: t('en', 'kn.up.button') })).toBeTruthy();
  });
});

describe('Upload panel', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.button') }));
  const choose = (name: string, bytes = 'hello package') => {
    const input = screen.getByLabelText(t('en', 'kn.up.file')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([bytes], name, { lastModified: 1 })] } });
  };
  const uploadApi: Handler = (s) =>
    s.method === 'POST' && s.url.endsWith('/uploads')
      ? json(201, { id: 'up-1', state: 'OPEN', partSize: 8388608, partsReceived: [] })
      : s.method === 'PUT'
        ? json(200, { id: 'up-1', state: 'OPEN', partSize: 8388608, partsReceived: [1] })
        : s.method === 'POST' && s.url.endsWith('/completion')
          ? json(202, { id: 'res-9' })
          : undefined;

  it('refuses an executable at once and asks for a name before anything is sent', async () => {
    mockFetch(uploadApi);
    render(<KnowledgeUpload locale="en" />);
    open();
    choose('tool.exe');
    expect(await screen.findByText(t('en', 'kn.up.err.type'))).toBeTruthy();
    choose('theme.zip');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    expect(await screen.findByText(t('en', 'kn.up.err.name'))).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('uploads a package: session, part with its checksum, completion with the typed metadata, then a link to the resource', async () => {
    mockFetch(uploadApi);
    render(<KnowledgeUpload locale="en" />);
    open();
    choose('theme.zip');
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.name')), {
      target: { value: 'Modern SaaS' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.frameworks')), {
      target: { value: 'nextjs, react ,nextjs' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.tags')), {
      target: { value: 'saas, admin' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.license')), { target: { value: 'MIT' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    expect(await screen.findByText(t('en', 'kn.up.done'), { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'kn.up.open') }).getAttribute('href')).toBe(
      '/en/ai-intelligence/library/res-9',
    );
    const open1 = seen.find((s) => s.method === 'POST' && s.url.endsWith('/uploads'))!;
    expect(JSON.parse(open1.body as string)).toMatchObject({
      name: 'Modern SaaS',
      resourceType: 'THEME',
      filename: 'theme.zip',
      declaredBytes: 13,
    });
    expect(open1.headers.get('x-csrf-token')).toBe('csrf-123');
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('/v1/admin/knowledge/uploads/up-1/parts/1');
    expect(put.headers.get('x-part-sha256')).toMatch(/^[0-9a-f]{64}$/);
    const done = JSON.parse(seen.at(-1)!.body as string);
    expect(done.metadata).toMatchObject({
      name: 'Modern SaaS',
      frameworks: ['nextjs', 'react'],
      tags: ['saas', 'admin'],
      license: 'MIT',
      languages: [],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows actionable errors: forbidden, and an interruption that says how to resume', async () => {
    mockFetch((s) =>
      s.method === 'POST' && s.url.endsWith('/uploads') ? json(403, {}) : undefined,
    );
    const { unmount } = render(<KnowledgeUpload locale="en" />);
    open();
    choose('theme.zip');
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.name')), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    expect(await screen.findByText(t('en', 'kn.up.err.forbidden'))).toBeTruthy();
    unmount();
    mockFetch((s) => {
      if (s.method === 'POST' && s.url.endsWith('/uploads'))
        return json(201, { id: 'up-2', state: 'OPEN', partSize: 8388608, partsReceived: [] });
      throw new TypeError('offline');
    });
    render(<KnowledgeUpload locale="en" />);
    open();
    choose('theme.zip');
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.name')), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    expect(
      await screen.findByText(t('en', 'kn.up.err.network'), {}, { timeout: 10_000 }),
    ).toBeTruthy();
  }, 20_000);

  it('Cancel stops the upload, asks the server to discard the session and says so', async () => {
    mockFetch((s) => {
      if (s.method === 'POST' && s.url.endsWith('/uploads'))
        return json(201, { id: 'up-3', state: 'OPEN', partSize: 8388608, partsReceived: [] });
      if (s.method === 'PUT') return new Promise<Response>(() => undefined); // never answers: the part is "in flight"
      if (s.method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    render(<KnowledgeUpload locale="en" />);
    open();
    choose('theme.zip');
    fireEvent.change(screen.getByLabelText(t('en', 'kn.up.name')), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    const cancel = await screen.findByRole('button', { name: t('en', 'kn.up.cancel') });
    await waitFor(() => expect(seen.some((s) => s.method === 'PUT')).toBe(true));
    fireEvent.click(cancel);
    expect(await screen.findByText(t('en', 'kn.up.cancelled'))).toBeTruthy();
    expect(seen.at(-1)).toMatchObject({
      method: 'DELETE',
      url: '/v1/admin/knowledge/uploads/up-3',
    });
  });

  it('a new version upload needs no name or type and sends the resource id', async () => {
    mockFetch(uploadApi);
    render(
      <KnowledgeUpload
        locale="en"
        resource={{ id: 'res-1', name: 'Modern SaaS', resourceType: 'THEME' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.versionTitle') }));
    expect(screen.queryByLabelText(t('en', 'kn.up.name'))).toBeNull();
    choose('v2.zip');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.up.start') }));
    await screen.findByText(t('en', 'kn.up.done'), { exact: false });
    expect(
      JSON.parse(
        seen.find((s) => s.url.endsWith('/uploads') && s.method === 'POST')!.body as string,
      ),
    ).toMatchObject({ resourceId: 'res-1', name: 'Modern SaaS' });
    expect(screen.queryByRole('link', { name: t('en', 'kn.up.open') })).toBeNull();
  });
});

describe('Resource page', () => {
  it('shows facts, "not measured" quality, no manifest yet, and the licence verdict as decided at review', () => {
    render(
      <KnowledgeResource locale="en" detail={detail()} versions={versions} canManage canPublish />,
    );
    expect(screen.getByRole('heading', { name: 'Modern SaaS' })).toBeTruthy();
    expect(screen.getAllByText(t('en', 'kn.status.QUARANTINED')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(t('en', 'kn.lic.UNKNOWN'), { selector: '.nz-badge' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(t('en', 'kn.d.manifest.none'))).toBeTruthy();
    expect(screen.getByText(t('en', 'kn.d.quality.none'))).toBeTruthy();
    expect(screen.getByText(t('en', 'kn.d.jobs.none'))).toBeTruthy();
    expect(screen.getByText(t('en', 'kn.d.licenseNote'))).toBeTruthy();
  });

  it('sends only the changed fields with If-Match, then shows the saved resource', async () => {
    mockFetch((s) =>
      s.method === 'PATCH'
        ? json(200, detail({ category: 'crm', version: 3, tags: ['crm'] }))
        : undefined,
    );
    render(
      <KnowledgeResource locale="en" detail={detail()} versions={versions} canManage canPublish />,
    );
    fireEvent.change(screen.getByLabelText(t('en', 'kn.d.category')), { target: { value: 'crm' } });
    fireEvent.change(screen.getByLabelText(t('en', 'kn.d.tags')), { target: { value: 'crm' } });
    fireEvent.click(screen.getByLabelText(t('en', 'kn.d.componentReuse')));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.save') }));
    expect(await screen.findByText(t('en', 'kn.d.saved'))).toBeTruthy();
    const req = seen.find((s) => s.method === 'PATCH')!;
    expect(req.url).toBe('/v1/admin/knowledge/resources/00000000-0000-7000-8000-000000000001');
    expect(req.headers.get('if-match')).toBe('"2"');
    expect(JSON.parse(req.body as string)).toEqual({
      category: 'crm',
      tags: ['crm'],
      permissions: { componentReuse: true },
    });
  });
  it('says nothing changed instead of sending an empty request', () => {
    mockFetch(() => undefined);
    render(
      <KnowledgeResource locale="en" detail={detail()} versions={versions} canManage canPublish />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.save') }));
    expect(screen.getByText(t('en', 'kn.d.noChange'))).toBeTruthy();
    expect(seen).toHaveLength(0);
  });
  it('explains a conflict (stale version) and a refusal', async () => {
    mockFetch(() => json(409, { code: 'conflict' }));
    render(
      <KnowledgeResource locale="en" detail={detail()} versions={versions} canManage canPublish />,
    );
    fireEvent.change(screen.getByLabelText(t('en', 'kn.d.category')), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.save') }));
    expect(await screen.findByText(t('en', 'kn.err.conflict'))).toBeTruthy();
  });
  it('without the publish permission the publish-only controls are disabled and explained', () => {
    render(
      <KnowledgeResource
        locale="en"
        detail={detail()}
        versions={versions}
        canManage
        canPublish={false}
      />,
    );
    expect((screen.getByLabelText(t('en', 'kn.d.visibility')) as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByLabelText(new RegExp(t('en', 'kn.d.aiProcessing'))) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText(new RegExp(t('en', 'kn.d.defaultEligible'))) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText(new RegExp(t('en', 'kn.d.componentReuse'))) as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });
  it('read-only staff see no edit form, upload or lifecycle actions', () => {
    render(
      <KnowledgeResource
        locale="en"
        detail={detail()}
        versions={versions}
        canManage={false}
        canPublish={false}
      />,
    );
    expect(screen.queryByRole('button', { name: t('en', 'kn.d.save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('en', 'kn.d.disable') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('en', 'kn.up.versionTitle') })).toBeNull();
  });
  it('disable asks for a reason, then calls the API with an idempotency key and shows the new state', async () => {
    mockFetch((s) =>
      s.url.endsWith('/deactivation') ? json(200, resource({ status: 'DISABLED' })) : undefined,
    );
    render(
      <KnowledgeResource locale="en" detail={detail()} versions={versions} canManage canPublish />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.disable') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.confirm') }));
    expect(await screen.findByText(t('en', 'kn.d.reasonRequired'))).toBeTruthy();
    // the processing and review sections (S-K2a) read on mount; nothing may be WRITTEN before the reason is given
    expect(seen.filter((s) => s.method !== 'GET')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(t('en', 'kn.d.reason')), {
      target: { value: 'licence under review' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'kn.d.confirm') }));
    expect(await screen.findByText(t('en', 'kn.d.disabled'))).toBeTruthy();
    const req = seen.find((s) => s.url.endsWith('/deactivation'))!;
    expect(JSON.parse(req.body as string)).toEqual({ reason: 'licence under review' });
    expect(req.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      within(
        screen.getByRole('heading', { name: 'Modern SaaS' }).closest('.knd-head') as HTMLElement,
      ).getByText(t('en', 'kn.status.DISABLED')),
    ).toBeTruthy();
  });
  it('archive returns to the library list', async () => {
    mockFetch((s) =>
      s.url.endsWith('/archival') ? json(200, resource({ status: 'ARCHIVED' })) : undefined,
    );
    render(
      <KnowledgeResource locale="ar" detail={detail()} versions={versions} canManage canPublish />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'kn.d.archive') }));
    fireEvent.change(screen.getByLabelText(t('ar', 'kn.d.reason')), {
      target: { value: 'obsolete' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'kn.d.confirm') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/ar/ai-intelligence/library'));
  });
});
