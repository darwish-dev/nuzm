// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { BuilderStart } from './BuilderStart';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; method: string; body: unknown }[] = [];
const mockFetch = (h: (url: string, method: string) => Response) => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return h(url, method);
    }),
  );
};
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const wallet = { availableCredits: '100', lowCredit: false } as never;
const start = (p: { appsEnabled?: boolean; githubEnabled?: boolean } = {}) =>
  render(
    <BuilderStart
      locale="en"
      credits={wallet}
      canRun
      appsEnabled={p.appsEnabled ?? true}
      githubEnabled={p.githubEnabled ?? false}
    />,
  );
const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.src.add') }));
  return screen.getByRole('menu', { name: t('en', 'bld.src.menu') });
};
const file = (path: string, body: string) => {
  const f = new File([body], path.split('/').pop()!, { type: 'text/plain' });
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  // jsdom's File may lack text(): give it one that reads the body
  Object.defineProperty(f, 'text', { value: async () => body });
  return f;
};
const pickFolder = (files: File[]) => {
  const input = document.querySelector('input[webkitdirectory]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};

describe('builder start: start from a source', () => {
  it('offers the device and GitHub, and says why an option is off', () => {
    start({ appsEnabled: true, githubEnabled: false });
    const menu = openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.querySelector('b')?.textContent)).toEqual([
      t('en', 'bld.src.folder'),
      t('en', 'bld.src.files'),
      t('en', 'bld.src.github'),
    ]);
    const gh = items[2] as HTMLButtonElement;
    expect(gh.disabled).toBe(true);
    expect(gh.textContent).toContain(t('en', 'bld.src.github.off'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the device options off while the web-app builder is off', () => {
    start({ appsEnabled: false });
    const items = within(openMenu()).getAllByRole('menuitem') as HTMLButtonElement[];
    expect(items[0]!.disabled).toBe(true);
    expect(items[1]!.disabled).toBe(true);
  });

  it('imports a folder as a web app through the safe-diff change path, leaving secrets and dependencies out', async () => {
    mockFetch((url) =>
      url.endsWith('/v1/builder/projects')
        ? json(201, { id: 'p1', headVersionId: null })
        : url.endsWith('/v1/builder/projects/p1/changes')
          ? json(200, { versionId: 'v1' })
          : json(500, {}),
    );
    start();
    pickFolder([
      file('shop/package.json', '{"name":"shop"}'),
      file('shop/src/app.ts', 'export {}'),
      file('shop/.env', 'KEY=1'),
      file('shop/node_modules/x/i.js', 'x'),
    ]);
    const chip = await screen.findByText('shop');
    expect(chip.closest('.bl-chip-src')!.textContent).toContain('2 files');
    expect(chip.closest('.bl-chip-src')!.textContent).toContain('2 left out');
    // no words: the project only opens, no AI run
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.src.open') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p1'));
    expect((calls[0]!.body as { type: string; name: string }).type).toBe('webapp');
    expect((calls[0]!.body as { name: string }).name).toBe('shop');
    const change = calls[1]!.body as { baseVersion: unknown; patches: { path: string }[] };
    expect(change.baseVersion).toBeNull();
    expect(change.patches.map((p) => p.path)).toEqual(['package.json', 'src/app.ts']);
    expect(calls.some((c) => c.url.includes('/v1/ai/'))).toBe(false);
  });

  it('links and pulls a GitHub repository the organization connected', async () => {
    mockFetch((url, method) => {
      if (url.endsWith('/v1/builder/github'))
        return json(200, {
          available: true,
          adapter: 'github-app',
          connection: { accountLogin: 'acme', state: 'active' },
          installUrl: null,
        });
      if (url.endsWith('/v1/builder/github/repositories'))
        return json(200, {
          items: [
            { fullName: 'acme/shop', private: true },
            { fullName: 'acme/blog', private: false },
          ],
        });
      if (url.endsWith('/v1/builder/projects') && method === 'POST')
        return json(201, { id: 'p2', headVersionId: null });
      if (url.endsWith('/github/link')) return json(200, {});
      if (url.endsWith('/github/pull')) return json(200, {});
      return json(500, {});
    });
    start({ githubEnabled: true });
    const items = within(openMenu()).getAllByRole('menuitem');
    fireEvent.click(items[2]!);
    const dialog = await screen.findByRole('dialog', { name: t('en', 'bld.gh.title') });
    fireEvent.change(await within(dialog).findByPlaceholderText(t('en', 'bld.gh.search')), {
      target: { value: 'shop' },
    });
    expect(within(dialog).queryByText('acme/blog')).toBeNull();
    fireEvent.click(within(dialog).getByText('acme/shop'));
    expect(await screen.findByText('acme/shop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.src.open') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/builder/projects/p2'));
    const link = calls.find((c) => c.url.endsWith('/v1/builder/projects/p2/github/link'))!;
    expect(link.body).toEqual({ fullName: 'acme/shop' });
    expect(calls.some((c) => c.url.endsWith('/v1/builder/projects/p2/github/pull'))).toBe(true);
  });

  it('offers to connect GitHub when it is not connected yet', async () => {
    mockFetch((url) =>
      url.endsWith('/v1/builder/github')
        ? json(200, {
            available: true,
            adapter: 'github-app',
            connection: null,
            installUrl: 'https://github.com/apps/nuzm/installations/new?state=s',
          })
        : json(500, {}),
    );
    start({ githubEnabled: true });
    fireEvent.click(within(openMenu()).getAllByRole('menuitem')[2]!);
    const connect = await screen.findByRole('link', { name: t('en', 'bld.gh.connect') });
    expect(connect.getAttribute('href')).toBe(
      'https://github.com/apps/nuzm/installations/new?state=s',
    );
  });
});
