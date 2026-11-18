// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextSidebar, PrimaryRail, StatTile } from './console-nav';
import { ICON_NAMES } from './icons';

afterEach(cleanup);
const check = async (c: HTMLElement) =>
  (await axe.run(c, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
    (v) => `${v.id}: ${v.nodes[0]?.html}`,
  );

const rail = (
  <PrimaryRail
    label="Main"
    items={[
      { id: 'a', href: '/a', label: 'Cloud', icon: 'cloud', current: true },
      { id: 'b', href: '/b', label: 'Domains', icon: 'domains', current: false },
    ]}
    utilities={[
      { id: 'n', href: '/n', label: 'Notifications', icon: 'bell', current: false, badge: 3 },
    ]}
  />
);

describe('primary rail', () => {
  it('every icon link has an accessible name and a tooltip, and marks the current one', async () => {
    const { container } = render(rail);
    const cloud = screen.getByRole('link', { name: 'Cloud' });
    expect(cloud.getAttribute('aria-current')).toBe('page');
    expect(cloud.getAttribute('data-tip')).toBe('Cloud');
    expect(screen.getByRole('link', { name: 'Domains' }).getAttribute('aria-current')).toBeNull();
    // the unread count is part of the name, not only a visual dot
    expect(screen.getByRole('link', { name: 'Notifications (3)' })).toBeTruthy();
    expect(await check(container)).toEqual([]);
  });
});

describe('contextual sidebar', () => {
  const groups = [
    {
      id: 'g',
      title: 'Billing',
      items: [
        { id: 'o', href: '/billing', label: 'Overview', current: false },
        {
          id: 'inv',
          label: 'Invoices',
          children: [
            { id: 'i', href: '/billing/invoices', label: 'Invoices', current: true },
            { id: 'c', href: '/billing/credit-notes', label: 'Credit notes', current: false },
          ],
        },
        {
          id: 'pay',
          label: 'Payments',
          children: [{ id: 'p', href: '/billing/payments', label: 'Payments', current: false }],
        },
      ],
    },
  ];
  it('opens the group that holds the current page and keeps the others closed', async () => {
    const { container } = render(
      <ContextSidebar title="Finance" label="Section" groups={groups} />,
    );
    const details = container.querySelectorAll('details');
    expect(details[0]!.open).toBe(true);
    expect(details[1]!.open).toBe(false);
    expect(screen.getByRole('heading', { name: 'Finance' })).toBeTruthy();
    expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe('Invoices');
    expect(await check(container)).toEqual([]);
  });
});

describe('stat tile', () => {
  it('is a link only when it has a destination', () => {
    const { rerender } = render(<StatTile label="Wallet" value="SAR 10.00" />);
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<StatTile label="Wallet" value="SAR 10.00" href="/w" sub="since" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/w');
  });
});

describe('icons', () => {
  it('every icon is decorative (hidden from assistive technology)', () => {
    for (const name of ICON_NAMES) expect(name.length).toBeGreaterThan(0);
    const { container } = render(rail);
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
    }
  });
});
