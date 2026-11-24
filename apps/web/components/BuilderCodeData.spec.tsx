// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { SiteModel } from '../lib/builder';
import { CodePane } from './BuilderCode';
import { DataPane } from './BuilderData';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: string[] = [];
const route = (h: (url: string) => Response | undefined) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return h(url) ?? json(404, {});
    }),
  );
};
beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HTML = '<h1 class="big">Hello</h1>\n<p>Welcome</p>';
const files = [
  { path: 'ar/index.html', size: 40, mime: 'text/html; charset=utf-8', contentHash: 'h1' },
  { path: 'assets/styles.css', size: 20, mime: 'text/css; charset=utf-8', contentHash: 'h2' },
];
const content = (path: string) =>
  path === 'ar/index.html'
    ? { path, mime: 'text/html', size: 40, encoding: 'utf8', content: HTML }
    : { path, mime: 'text/css', size: 20, encoding: 'utf8', content: 'a { color: #fff; }' };
const codeRoutes = (extra: (url: string) => Response | undefined = () => undefined) =>
  route((url) => {
    if (url.includes('/files/content')) {
      const path = new URL(url, 'http://x').searchParams.get('path')!;
      return json(200, content(path));
    }
    if (url.includes('/files')) return json(200, { items: files });
    if (url.includes('/versions')) return json(200, { items: [], nextCursor: null });
    return extra(url);
  });

describe('Code view', () => {
  it('shows the files as a tree, and a clicked file as numbered, tinted, read-only text', async () => {
    codeRoutes();
    const { container } = render(<CodePane locale="en" projectId="p1" versionId="v1" />);
    const tree = await screen.findByText('index.html');
    expect(screen.getByText('styles.css')).toBeTruthy();
    expect(screen.getByText(t('en', 'bld.cx.empty.title'))).toBeTruthy();
    fireEvent.click(tree);
    await waitFor(() => expect(container.querySelectorAll('.bwc-line')).toHaveLength(2));
    expect(container.querySelector('.bwc-line[data-line="1"] .bwc-ln')?.textContent).toBe('1');
    expect(container.querySelector('.tok-tag')?.textContent).toBe('<h1');
    expect(screen.getByText(t('en', 'bld.cx.readonly'))).toBeTruthy();
    // the text is shown as text: the markup of the file is not rendered
    expect(container.querySelector('.bwc-code h1')).toBeNull();
  });
  it('searches names and contents and opens the match at its line', async () => {
    codeRoutes();
    const { container } = render(<CodePane locale="en" projectId="p1" versionId="v1" />);
    await screen.findByText('index.html');
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.cx.tab.search') }));
    const input = screen.getByLabelText(t('en', 'bld.cx.search.ph'));
    fireEvent.change(input, { target: { value: 'welcome' } });
    const hit = await screen.findByText('ar/index.html:2');
    fireEvent.click(hit);
    await waitFor(() => expect(container.querySelector('.bwc-line[data-hit="true"]')).toBeTruthy());
    expect(container.querySelector('.bwc-line[data-hit="true"]')?.getAttribute('data-line')).toBe(
      '2',
    );
    fireEvent.change(input, { target: { value: 'zzz-nothing' } });
    expect(await screen.findByText(t('en', 'bld.cx.search.none'))).toBeTruthy();
  });
  it('the bottom panel opens on a tab, says nothing was published, and closes again', async () => {
    codeRoutes((url) =>
      url.includes('/v1/deployments') ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    const { container } = render(<CodePane locale="en" projectId="p1" versionId="v1" />);
    await screen.findByText('index.html');
    // it opens on the status tab, like a terminal that is already running
    expect(container.querySelector('.bwc-term')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.cx.panel.publish') }));
    expect(await screen.findByText(t('en', 'bld.cx.pub.none'), { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.cx.panel.publish') }));
    expect(container.querySelector('.bwc-bbody')).toBeNull();
  });
  it('shows the site source as files beside the generated ones, opens them as JSON, and finds them in search', async () => {
    codeRoutes();
    const m = {
      locales: ['ar', 'en'],
      defaultLocale: 'ar',
      brand: { name: { ar: 'م', en: 'Acme' } },
      seo: { siteTitle: { ar: 'م', en: 'Acme' }, description: { ar: 'و', en: 'D' } },
      forms: [],
      pages: [{ id: 'home', slug: 'home', title: { ar: 'ر', en: 'Home' }, sections: [] }],
      tokens: { radius: 'md' },
    } as unknown as SiteModel;
    const { container } = render(<CodePane locale="en" projectId="p1" versionId="v1" model={m} />);
    await screen.findByText('index.html');
    expect(screen.getByText('project.json')).toBeTruthy();
    expect(screen.getByText('tokens.json')).toBeTruthy();
    expect(screen.getByText('home.json')).toBeTruthy();
    fireEvent.click(screen.getByText('tokens.json'));
    await waitFor(() => expect(container.querySelector('.bwc-line')).toBeTruthy());
    expect(container.querySelector('.tok-prop')?.textContent).toBe('"radius"');
    expect(
      screen.getByText(`${t('en', 'bld.cx.source')} · ${t('en', 'bld.cx.readonly')}`),
    ).toBeTruthy();
    // no request was made for a source file: it is derived from the model
    expect(calls.some((u) => u.includes('tokens.json'))).toBe(false);
  });
  it('without deploy access the publish panel says so instead of failing', async () => {
    codeRoutes((url) =>
      url.includes('/v1/deployments') ? json(403, { code: 'forbidden' }) : undefined,
    );
    render(<CodePane locale="en" projectId="p1" versionId="v1" />);
    await screen.findByText('index.html');
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.cx.panel.publish') }));
    expect(await screen.findByText(t('en', 'bld.cx.pub.noaccess'))).toBeTruthy();
  });
});

const model = {
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  brand: { name: { ar: 'م', en: 'M' } },
  seo: { siteTitle: { ar: 'م', en: 'M' }, description: { ar: 'و', en: 'D' } },
  forms: [],
  pages: [],
  assets: [
    {
      id: 'a1',
      kind: 'image',
      source: 'placeholder',
      alt: { ar: 'صورة', en: 'Team photo' },
      label: 'Team',
      width: 800,
      height: 600,
    },
  ],
} as unknown as SiteModel;
const dataRoutes = (over: { forms?: unknown[]; cms?: unknown[] } = {}) =>
  route((url) => {
    if (url.includes('/form-submissions'))
      return json(200, {
        items: [
          {
            id: 's1',
            formId: 'f1',
            formKey: 'contact',
            fields: { name: 'Sara', email: 's@x.test' },
            masked: true,
            createdAt: '2026-11-19T10:00:00Z',
            expiresAt: '2027-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
      });
    if (url.includes('/forms'))
      return json(200, {
        items: over.forms ?? [
          {
            id: 'f1',
            formKey: 'contact',
            name: 'Contact form',
            fields: [
              { name: 'name', type: 'text' },
              { name: 'email', type: 'email' },
            ],
            submissions: 1,
          },
        ],
      });
    if (url.includes('/cms-collections'))
      return json(200, {
        items: over.cms ?? [
          {
            id: 'c1',
            collectionKey: 'news',
            name: 'News',
            fields: [{ name: 'title', type: 'text' }],
            items: [
              {
                id: 'i1',
                data: { title: 'Opening' },
                state: 'published',
                version: 1,
                updatedAt: '2026-11-19T10:00:00Z',
              },
              {
                id: 'i2',
                data: { title: 'Sale' },
                state: 'draft',
                version: 1,
                updatedAt: '2026-11-19T10:00:00Z',
              },
            ],
          },
        ],
      });
    if (url.includes('/versions'))
      return json(200, {
        items: [
          { id: 'v2', seq: 2, label: 'Edited', isHead: true, createdAt: '2026-11-19T11:00:00Z' },
          { id: 'v1', seq: 1, label: null, isHead: false, createdAt: '2026-11-19T10:00:00Z' },
        ],
        nextCursor: null,
      });
    return undefined;
  });

describe('Data view', () => {
  it('lists the forms and content collections with their counts, and shows the rows of the selected one', async () => {
    dataRoutes();
    render(<DataPane locale="en" projectId="p1" model={model} siteLocale="en" />);
    expect((await screen.findAllByText('Contact form')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('en', 'bld.dx.rows', { n: 1 }))).toBeTruthy();
    expect(screen.getByText('News')).toBeTruthy();
    expect(screen.getByText(t('en', 'bld.dx.items', { n: 2 }))).toBeTruthy();
    // the first table is open: its columns and row, with the masked-values note
    expect(await screen.findByText('Sara')).toBeTruthy();
    expect(screen.getByText(t('en', 'bld.dx.masked'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /News/ }));
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('Opening')).toBeTruthy();
    expect(table.getByText('draft')).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'bld.dx.manage') }).getAttribute('href')).toBe(
      '/builder/projects/p1/cms',
    );
  });
  it('says so when there is nothing yet, and points to the forms and content screens', async () => {
    dataRoutes({ forms: [], cms: [] });
    render(<DataPane locale="en" projectId="p1" model={model} siteLocale="en" />);
    expect(await screen.findByText(t('en', 'bld.dx.empty.title'))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'bld.tab.forms') }).getAttribute('href')).toBe(
      '/builder/projects/p1/forms',
    );
  });
  it('Files shows the images of the site in the chosen language; History lists the versions with the current one marked', async () => {
    dataRoutes();
    render(<DataPane locale="en" projectId="p1" model={model} siteLocale="en" />);
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.dx.tab.files') }));
    expect(screen.getByText('Team photo')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.dx.tab.history') }));
    expect(await screen.findByText(t('en', 'bld.ws.version', { seq: 2 }))).toBeTruthy();
    expect(screen.getByText(t('en', 'bld.dx.history.current'))).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'bld.dx.history.manage') }).getAttribute('href'),
    ).toBe('/builder/projects/p1/versions');
  });
});
