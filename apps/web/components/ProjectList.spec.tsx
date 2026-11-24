// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { FilterableProjects } from './ProjectList';

const p = (id: string, type: string) =>
  ({
    id,
    type,
    name: `n-${id}`,
    locales: ['ar'],
    lastDeployment: null,
    updatedAt: '2026-11-19T10:00:00Z',
  }) as never;
const items = [p('s1', 'website'), p('a1', 'webapp'), p('a2', 'webapp'), p('m1', 'mobile')];
const view = (initial: 'all' | 'webapp' = 'all') =>
  render(
    <FilterableProjects
      locale="en"
      items={items}
      nextCursor={null}
      canCreate
      canDelete={false}
      mfaFactorId={null}
      appsEnabled
      mobileEnabled
      initial={initial}
    />,
  );
const tab = (f: string) =>
  screen.getByRole('link', { name: t('en', `m10a.proj.filter.${f}` as never) });
const names = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

beforeEach(() => window.history.replaceState(null, '', '/builder/projects'));
afterEach(cleanup);

describe('project list filter', () => {
  it('switches the list in place: no navigation, the address follows, the chosen tab is current', () => {
    const before = window.history.length;
    view();
    expect(names()).toEqual(['n-s1', 'n-a1', 'n-a2', 'n-m1']);
    fireEvent.click(tab('webapp'));
    expect(names()).toEqual(['n-a1', 'n-a2']);
    expect(tab('webapp').getAttribute('aria-current')).toBe('page');
    expect(tab('all').getAttribute('aria-current')).toBeNull();
    expect(window.location.pathname + window.location.search).toBe(
      '/builder/projects?type=webapp',
    );
    fireEvent.click(tab('mobile'));
    expect(names()).toEqual(['n-m1']);
    fireEvent.click(tab('all'));
    expect(names()).toHaveLength(4);
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(before); // replaced, never pushed
  });

  it('starts on the filter of the address, and a type with no project says so', () => {
    render(
      <FilterableProjects
        locale="en"
        items={[p('s1', 'website')]}
        nextCursor={null}
        canCreate
        canDelete={false}
        mfaFactorId={null}
        appsEnabled
        mobileEnabled={false}
        initial="webapp"
      />,
    );
    expect(tab('webapp').getAttribute('aria-current')).toBe('page');
    expect(screen.getByText(t('en', 'm10a.proj.filtered.title'))).toBeTruthy();
    fireEvent.click(tab('website'));
    expect(names()).toEqual(['n-s1']);
  });

  it('a modified click (new tab) is left to the browser: no in-place switch', () => {
    view();
    fireEvent.click(tab('webapp'), { ctrlKey: true });
    expect(names()).toHaveLength(4);
    expect(tab('webapp').getAttribute('href')).toBe('/builder/projects?type=webapp');
  });
});
