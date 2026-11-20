// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { ProjectDetail, SiteModel } from '../lib/builder';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { Workspace } from './BuilderWorkspace';
import { StudioPanel } from './StudioPanels';
import { studioSection, STUDIO_SECTIONS } from '../lib/studio-sections';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
      sections: [{ id: 'hero1', type: 'hero', props: { heading: { ar: 'مرحبا', en: 'Welcome' } } }],
    },
  ],
};
const detail = {
  id: 'p1',
  name: 'My clinic site',
  type: 'website',
  versionId: 'v1',
  versionSeq: 3,
  siteModel: model,
  seo: { score: 80, checks: [] },
} as unknown as ProjectDetail;

const can = { write: true, deployWrite: true, sitesRead: false };
let calls: string[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : ((input as Request).url ?? String(input)),
        'http://x',
      );
      calls.push(url.pathname);
      if (url.pathname.endsWith('/versions')) return json(200, { items: [], nextCursor: null });
      if (url.pathname.endsWith('/cms-collections')) return json(200, { items: [] });
      if (url.pathname.endsWith('/forms')) return json(200, { items: [] });
      if (url.pathname.endsWith('/form-submissions'))
        return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/v1/deployments') return json(200, { items: [], nextCursor: null });
      if (url.pathname === '/v1/builder/projects/p1') return json(200, detail);
      return json(500, {});
    }),
  );
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('studioSection', () => {
  it('accepts only the five site sections', () => {
    for (const s of STUDIO_SECTIONS) expect(studioSection(s)).toBe(s);
    expect(studioSection('billing')).toBeNull();
    expect(studioSection(undefined)).toBeNull();
    expect(studioSection('')).toBeNull();
  });
});

describe('StudioPanel', () => {
  const panel = (section: (typeof STUDIO_SECTIONS)[number]) => {
    const onSelect = vi.fn();
    render(
      <StudioPanel
        locale="en"
        projectId="p1"
        section={section}
        sections={[...STUDIO_SECTIONS]}
        can={can}
        onSelect={onSelect}
      />,
    );
    return { onSelect };
  };

  it("offers the sections as tabs, marks the open one, and loads that site's data", async () => {
    panel('versions');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    expect(tabs.find((x) => x.getAttribute('aria-selected') === 'true')?.textContent).toBe(
      t('en', 'bld.tab.versions'),
    );
    await waitFor(() => expect(calls).toContain('/v1/builder/projects/p1/versions'));
  });

  it('switching a tab asks the parent to open that section', () => {
    const { onSelect } = panel('versions');
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'bld.tab.deployments') }));
    expect(onSelect).toHaveBeenCalledWith('deployments');
  });

  it('is part of the page (no dialog, no overlay)', () => {
    panel('seo');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed read shows the error state, not a raw message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, { message: 'secret db detail' })),
    );
    panel('cms');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('en', 'state.error.title'));
    expect(document.body.textContent).not.toContain('secret db detail');
  });

  it("Publishing loads the site's deployments, never another project's", async () => {
    panel('deployments');
    await waitFor(() => expect(calls).toContain('/v1/deployments'));
    expect(calls.every((c) => !c.includes('/p2'))).toBe(true);
  });
});

describe('Workspace + section', () => {
  const links = [
    { key: 'versions', href: '/en/builder/projects/p1?panel=versions', label: 'Versions' },
    { key: 'seo', href: '/en/builder/projects/p1?panel=seo', label: 'SEO' },
    { key: 'deployments', href: '/en/builder/projects/p1?panel=deployments', label: 'Publishing' },
  ];
  const ws = (over: Partial<Parameters<typeof Workspace>[0]> = {}) =>
    render(
      <Workspace
        locale="en"
        initial={detail}
        session={null}
        messages={[]}
        initialRun={null}
        canWrite
        canAi
        links={links}
        panelCan={can}
        {...over}
      />,
    );
  const selected = (root: HTMLElement) =>
    within(root)
      .getAllByRole('tab')
      .find((x) => x.getAttribute('aria-selected') === 'true')?.textContent;

  it('Publish opens the section in the main area (next to the chat, in place of the preview); only permitted sections are tabs', async () => {
    ws();
    expect(screen.queryByRole('tablist', { name: t('en', 'bld.ws.sections') })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: t('en', 'bld.ws.publish') }));
    const list = await screen.findByRole('tablist', { name: t('en', 'bld.ws.sections') });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((x) => x.textContent),
    ).toEqual([
      t('en', 'bld.tab.versions'),
      t('en', 'bld.tab.seo'),
      t('en', 'bld.tab.deployments'),
    ]);
    expect(selected(list)).toBe(t('en', 'bld.tab.deployments'));
    // it is inside the canvas section, the chat is still there, and there is no overlay
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: t('en', 'bld.ws.canvas') }).contains(list)).toBe(
      true,
    );
    expect(screen.getByRole('region', { name: t('en', 'bld.ws.chat') })).toBeTruthy();
  });

  it('Preview, Code and Data bring the canvas back', async () => {
    ws({ initialPanel: 'seo' });
    await screen.findByRole('tablist', { name: t('en', 'bld.ws.sections') });
    const top = screen.getByRole('banner');
    // while a section is open no canvas view is pressed
    expect(
      within(top)
        .getByRole('button', { name: t('en', 'bld.ws.preview') })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(within(top).getByRole('button', { name: t('en', 'bld.ws.data') }));
    await waitFor(() =>
      expect(screen.queryByRole('tablist', { name: t('en', 'bld.ws.sections') })).toBeNull(),
    );
    expect(
      within(top)
        .getByRole('button', { name: t('en', 'bld.ws.data') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('opens straight into a section from the address (?panel=)', async () => {
    ws({ initialPanel: 'seo' });
    const list = await screen.findByRole('tablist', { name: t('en', 'bld.ws.sections') });
    expect(selected(list)).toBe(t('en', 'bld.tab.seo'));
  });

  it('ignores a section this member may not open', () => {
    ws({ initialPanel: 'cms' });
    expect(screen.queryByRole('tablist', { name: t('en', 'bld.ws.sections') })).toBeNull();
  });
});
