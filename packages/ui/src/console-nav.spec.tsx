// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PrimaryRail, SectionTabs, StatTile } from './console-nav';
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

describe('rail tooltips', () => {
  it("hovering or focusing an icon sets the tooltip's vertical position (the tooltip itself is fixed, so the scrolling rail cannot clip it)", () => {
    render(rail);
    const link = screen.getByRole('link', { name: 'Domains' });
    link.getBoundingClientRect = () => ({ top: 100, height: 44 }) as DOMRect;
    expect(link.style.getPropertyValue('--nzc-tip-y')).toBe('');
    fireEvent.pointerOver(link);
    expect(link.style.getPropertyValue('--nzc-tip-y')).toBe('122px');
    link.getBoundingClientRect = () => ({ top: 200, height: 44 }) as DOMRect;
    fireEvent.focusIn(link);
    expect(link.style.getPropertyValue('--nzc-tip-y')).toBe('222px');
  });
});

describe('section tabs', () => {
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
  it('renders the pages as tabs, marks the current one and its menu, and keeps menus closed', async () => {
    const { container } = render(<SectionTabs label="Section" groups={groups} />);
    expect(screen.getByRole('navigation', { name: 'Section' })).toBeTruthy();
    // the group with several pages is a menu, closed by default but marked as holding the current page
    const menus = container.querySelectorAll('details');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.open).toBe(false);
    expect(menus[0]!.querySelector('summary')!.getAttribute('data-current')).toBe('true');
    expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe('Invoices');
    // a group of one page is a plain tab
    expect(screen.getByRole('link', { name: 'Payments' }).closest('details')).toBeNull();
    expect(await check(container)).toEqual([]);
  });

  it('renders nothing when the category has fewer than two pages', () => {
    const { container, rerender } = render(
      <SectionTabs label="Section" groups={[{ id: 'g', items: [] }]} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(
      <SectionTabs
        label="Section"
        groups={[
          { id: 'g', items: [{ id: 'p', href: '/account', label: 'Profile', current: true }] },
        ]}
      />,
    );
    expect(container.innerHTML).toBe('');
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
