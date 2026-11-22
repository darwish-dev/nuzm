// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

let path = '/console';
vi.mock('next/navigation', () => ({ usePathname: () => path }));
import { FloatingBuilder } from './FloatingBuilder';

afterEach(cleanup);

describe('floating AI builder', () => {
  it('is a wide card on console pages that opens the builder start page', () => {
    path = '/domains';
    render(<FloatingBuilder locale="en" />);
    const a = screen.getByRole('link', { name: new RegExp(t('en', 'bld.fab.title')) });
    expect(a.getAttribute('href')).toBe('/builder/projects');
    expect(screen.getByText(t('en', 'bld.fab.sub'))).toBeTruthy();
  });
  it('carries the Nuzm logo mark as its icon', () => {
    path = '/domains';
    const { container } = render(<FloatingBuilder locale="en" />);
    expect(container.querySelector('.bfab-icon img.nzc-logo')?.getAttribute('src')).toMatch(
      /^\/brand\/nuzm-mark\.png(\?v=[a-z0-9]+)?$/,
    );
  });
  it('speaks the page language and keeps the locale in the link', () => {
    path = '/console';
    render(<FloatingBuilder locale="ar" />);
    expect(
      screen.getByRole('link', { name: new RegExp(t('ar', 'bld.fab.title')) }).getAttribute('href'),
    ).toBe('/builder/projects');
  });
  it.each(['/builder/projects', '/builder/projects/abc', '/builder', '/mobile/new'])(
    'is hidden inside the builder itself (%s)',
    (p) => {
      path = p;
      const { container } = render(<FloatingBuilder locale="en" />);
      expect(container.querySelector('.bfab')).toBeNull();
    },
  );
  it('is not hidden on a page whose path only starts like the builder', () => {
    path = '/builders-guide';
    const { container } = render(<FloatingBuilder locale="en" />);
    expect(container.querySelector('.bfab')).not.toBeNull();
  });
});
