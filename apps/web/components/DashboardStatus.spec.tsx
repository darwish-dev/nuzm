// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import { DashboardStatus } from './DashboardStatus';

afterEach(cleanup);

const row = (id: string, name: string, detail: string, tone: 'ok' | 'bad' = 'ok') => ({
  id,
  name,
  detail,
  tone,
  href: `/x/${id}`,
});
const props = {
  locale: 'en' as const,
  base: '',
  attention: [],
  servers: null,
  domains: null,
  sites: null,
};

describe('dashboard status column', () => {
  it('says nothing needs attention when the list is empty, and draws only the cards the member has', () => {
    const { container } = render(<DashboardStatus {...props} />);
    expect(screen.getByText(t('en', 'ds.attention.none'))).toBeTruthy();
    expect(container.querySelectorAll('.nzc-status-card')).toHaveLength(1); // no module cards
  });
  it('draws no empty resources box or heading when every resource module is hidden (row layout)', () => {
    const { container } = render(<DashboardStatus {...props} layout="row" />);
    expect(container.querySelector('.nzc-status-group')).toBeNull();
    expect(container.querySelector('.nzc-status-title')).toBeNull();
  });
  it('keeps the resources heading and group when at least one module is shown (row layout)', () => {
    const { container } = render(
      <DashboardStatus {...props} layout="row" domains={{ count: 0, rows: [] }} />,
    );
    expect(container.querySelector('.nzc-status-group')).not.toBeNull();
    expect(container.querySelector('.nzc-status-title')?.textContent).toBe(t('en', 'ds.title'));
    expect(screen.getByText(t('en', 'ds.empty.domains'))).toBeTruthy();
  });
  it('lists what needs attention with a link each, and counts it', () => {
    render(
      <DashboardStatus
        {...props}
        attention={[
          {
            id: 'servers',
            tone: 'bad',
            text: 'Servers that failed: 1',
            href: '/compute/instances',
          },
          {
            id: 'unread',
            tone: 'warn',
            text: 'Unread notifications: 3',
            href: '/notifications',
          },
        ]}
      />,
    );
    const card = screen.getByRole('region', { name: t('en', 'ds.attention') });
    expect(within(card).getAllByRole('link')).toHaveLength(2);
    expect(
      within(card)
        .getByRole('link', { name: /Servers that failed: 1/ })
        .getAttribute('href'),
    ).toBe('/compute/instances');
    expect(card.querySelector('.nzc-status-count')?.textContent).toBe('2');
  });
  it('shows servers, domains and websites with their rows, "view all", and "+N more" past four', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => row(n, `srv-${n}`, 'Running'));
    render(
      <DashboardStatus
        {...props}
        servers={{ count: 6, rows: many }}
        domains={{ count: 1, rows: [row('d1', 'nuzm.sa', 'Expires 1 Jan 2027')] }}
        sites={{ count: 0, rows: [] }}
      />,
    );
    const servers = screen.getByRole('region', { name: t('en', 'ds.servers') });
    expect(
      within(servers)
        .getAllByRole('link')
        .filter((l) => l.closest('li')),
    ).toHaveLength(4);
    expect(
      within(servers)
        .getByRole('link', { name: t('en', 'ds.more', { n: 2 }) })
        .getAttribute('href'),
    ).toBe('/compute/instances');
    const domains = screen.getByRole('region', { name: t('en', 'ds.domains') });
    expect(
      within(domains)
        .getByRole('link', { name: /nuzm\.sa/ })
        .getAttribute('href'),
    ).toBe('/x/d1');
    expect(
      within(domains)
        .getByRole('link', { name: t('en', 'ds.viewAll') })
        .getAttribute('href'),
    ).toBe('/domains');
    expect(screen.getByText(t('en', 'ds.empty.sites'))).toBeTruthy();
  });
  it('marks a count as a lower bound when more exist than were loaded', () => {
    render(<DashboardStatus {...props} servers={{ count: 50, capped: true, rows: [] }} />);
    expect(
      screen.getByRole('region', { name: t('en', 'ds.servers') }).querySelector('.nzc-status-count')
        ?.textContent,
    ).toBe('50+');
  });
  it('speaks Arabic', () => {
    render(<DashboardStatus {...props} locale="ar" domains={{ count: 0, rows: [] }} />);
    expect(screen.getByText(t('ar', 'ds.attention.none'))).toBeTruthy();
    expect(screen.getByText(t('ar', 'ds.empty.domains'))).toBeTruthy();
  });
});
