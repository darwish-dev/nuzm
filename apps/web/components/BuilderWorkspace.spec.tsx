// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import type { ProjectDetail, SiteModel } from '../lib/builder';
import { Workspace } from './BuilderWorkspace';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(500, {})),
  );
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const detail = {
  id: 'p1',
  name: 'My clinic site',
  type: 'website',
  versionId: 'v1',
  versionSeq: 3,
  siteModel: model,
} as unknown as ProjectDetail;
const links = [
  { key: 'versions', href: '/en/builder/projects/p1/versions', label: 'Versions' },
  { key: 'seo', href: '/en/builder/projects/p1/seo', label: 'SEO' },
  { key: 'deployments', href: '/en/builder/projects/p1/deployments', label: 'Deployments' },
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
      {...over}
    />,
  );

describe('builder workspace shell', () => {
  it('has a slim top bar: project name and version, Preview / Code, screen size, site language, undo / redo', () => {
    ws();
    const top = screen.getByRole('banner');
    expect(within(top).getByText('My clinic site')).toBeTruthy();
    expect(within(top).getByText(t('en', 'bld.ws.version', { seq: 3 }))).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'bld.ws.preview') })).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'bld.ws.code') })).toBeTruthy();
    for (const d of ['desktop', 'tablet', 'mobile'] as const)
      expect(
        within(top).getByRole('button', {
          name: t('en', `bld.preview.${d}`, {
            width: { desktop: 1200, tablet: 768, mobile: 375 }[d],
          }),
        }),
      ).toBeTruthy();
    expect(within(top).getByRole('button', { name: t('en', 'bld.lang.ar') })).toBeTruthy();
    // nothing to undo yet
    expect(
      (within(top).getByRole('button', { name: t('en', 'bld.ws.undo') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(top).getByRole('button', { name: t('en', 'bld.ws.redo') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('the screen size and language are chosen in the top bar (one place), not in the preview', () => {
    ws();
    const mobile = screen.getByRole('button', {
      name: t('en', 'bld.preview.mobile', { width: 375 }),
    });
    expect(mobile.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(mobile);
    expect(mobile.getAttribute('aria-pressed')).toBe('true');
    // the preview pane's own toolbar is hidden (there is only one set of controls)
    expect(
      screen.getAllByRole('button', { name: t('en', 'bld.preview.mobile', { width: 375 }) }),
    ).toHaveLength(1);
  });
  it('Code replaces the canvas and hides the screen-size and language controls', () => {
    ws();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.ws.code') }));
    expect(
      screen.queryByRole('button', { name: t('en', 'bld.preview.tablet', { width: 768 }) }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: t('en', 'bld.ws.code') }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
  it('the properties panel can be hidden and shown again', () => {
    ws();
    const aside = () => screen.getByLabelText(t('en', 'bld.ws.inspector'), { selector: 'aside' });
    expect(aside().hasAttribute('hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.ws.hideProps') }));
    expect(aside().hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'bld.ws.showProps') }));
    expect(aside().hasAttribute('hidden')).toBe(false);
  });
  it('Publish goes to deployments; the other project screens sit under More', () => {
    const { container } = ws();
    expect(screen.getByRole('link', { name: t('en', 'bld.ws.publish') }).getAttribute('href')).toBe(
      '/en/builder/projects/p1/deployments',
    );
    const more = container.querySelector('.bws-more')!;
    expect(
      within(more as HTMLElement)
        .getAllByRole('link', { hidden: true })
        .map((a) => a.textContent),
    ).toEqual(['Versions', 'SEO']);
    expect(screen.getByRole('link', { name: t('en', 'bld.ws.back') }).getAttribute('href')).toBe(
      '/en/builder/projects',
    );
  });
  it('a viewer (no write permission) cannot undo or redo, and has no Publish when the link is not offered', () => {
    ws({ canWrite: false, canAi: false, links: [] });
    expect(screen.queryByRole('button', { name: t('en', 'bld.ws.undo') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('en', 'bld.ws.publish') })).toBeNull();
    expect(screen.getAllByText(t('en', 'bld.readonly')).length).toBeGreaterThan(0);
  });
});
