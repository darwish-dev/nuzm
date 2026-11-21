// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import type { CatalogPlan } from '../lib/hosting-catalog';
import { HostingMethods } from './HostingMethods';
import { HostingShop } from './HostingShop';

afterEach(cleanup);

const plan = (
  key: string,
  en: string,
  diskGb: number,
  over: Partial<CatalogPlan> = {},
): CatalogPlan => ({
  id: `id-${key}`,
  key,
  name: { ar: en, en },
  quotas: {
    diskMb: diskGb * 1024,
    inodes: 2_000_000,
    bandwidthGb: 100,
    dbCount: 5,
    sitesCount: 10,
  },
  runtimes: ['php:8.3', 'static'],
  price: null,
  ...over,
});
const plans = [
  plan('web-business', 'Business', 50),
  plan('web-start', 'Start', 20, {
    quotas: {
      diskMb: 20480,
      inodes: 400_000,
      bandwidthGb: 200,
      dbCount: 5,
      sitesCount: 1,
      maxProcesses: 30,
    },
  }),
  plan('cloud-pro', 'Cloud Pro', 200, {
    runtimes: ['php:8.3', 'nodejs:20', 'python:3.12', 'static'],
  }),
];
const prices = { 'id-web-start': null, 'id-web-business': 'SAR 50.00', 'id-cloud-pro': null };

describe('hosting shop', () => {
  it('shows the hosting types as tabs, the plans of the first type smallest first, and a button per plan that adds it to the basket', () => {
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    const tabs = screen.getAllByRole('tab').map((x) => x.textContent);
    expect(tabs).toEqual(['Web Hosting', 'Cloud Hosting']); // only types that have plans
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names.slice(0, 2)).toEqual(['Start', 'Business']);
    expect(screen.getAllByRole('button', { name: t('en', 'host.shop.choose') })).toHaveLength(2);
  });
  it('choosing a plan puts one website of that plan in the basket (once per click), and says so', () => {
    window.localStorage.clear();
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    const [start, business] = screen.getAllByRole('button', { name: t('en', 'host.shop.choose') });
    fireEvent.click(start!);
    fireEvent.click(business!);
    fireEvent.click(business!); // the same plan twice is two websites
    const stored = JSON.parse(window.localStorage.getItem('nuzm_cart:org-1')!) as {
      planId: string;
      kind: string;
    }[];
    expect(stored.map((l) => l.planId)).toEqual([
      'id-web-start',
      'id-web-business',
      'id-web-business',
    ]);
    expect(stored.every((l) => l.kind === 'hosting')).toBe(true);
    expect(screen.getAllByText(t('en', 'host.shop.added')).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('nuzm_cart:org-2')).toBeNull(); // another organization's basket is separate
  });
  it('a price with no approved amount says it is shown at checkout; an approved one is shown', () => {
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    expect(screen.getByText(t('en', 'host.shop.priceLater'))).toBeTruthy();
    expect(screen.getByText('SAR 50.00')).toBeTruthy();
  });
  it("switching type shows that type's plans and runtimes only; the keyboard moves between tabs", () => {
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cloud Hosting' }));
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toContain(
      'Cloud Pro',
    );
    expect(screen.queryByText('Business')).toBeNull();
    expect(screen.getByText('Node.js')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Cloud Hosting' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Web Hosting' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
  it('the comparison opens on demand and reads every row from the plans; a limit a plan does not state is a dash, not a guess', () => {
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.shop.compare') }));
    const table = screen.getByRole('table');
    const row = (label: string) =>
      within(within(table).getByRole('rowheader', { name: label }).closest('tr')!)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(row('Storage')).toEqual(['20 GB', '50 GB']);
    expect(row('Websites')).toEqual(['1', '10']);
    expect(row('Processes')).toEqual(['30', `—${t('en', 'host.shop.unknown')}`]);
    expect(row('Node.js')).toEqual([`—${t('en', 'host.shop.no')}`, `—${t('en', 'host.shop.no')}`]);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.shop.compare.hide') }));
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('lists what every plan includes without making up service-level promises', () => {
    render(<HostingShop locale="en" orgId="org-1" plans={plans} prices={prices} />);
    expect(screen.getByText(t('en', 'host.every.ssl'))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/uptime|guarantee|unlimited|%/i);
  });
  it('renders in Arabic with the Arabic plan names', () => {
    render(
      <HostingShop
        locale="ar"
        orgId="org-1"
        plans={[plan('web-start', 'Start', 20, { name: { ar: 'البداية', en: 'Start' } })]}
        prices={{ 'id-web-start': null }}
      />,
    );
    expect(screen.getByRole('tab', { name: t('ar', 'host.type.web') })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'البداية' })).toBeTruthy();
  });
});

describe('add a website: how to build it', () => {
  it('offers AI, WordPress, static, PHP and Node.js; AI opens the builder, runtimes continue here, and WordPress is not selectable yet', () => {
    render(<HostingMethods locale="en" query={{ plan: 'p1', domain: 'example.com' }} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const hrefOf = (name: string) =>
      (screen.getByText(name).closest('a') as HTMLAnchorElement | null)?.getAttribute('href');
    expect(hrefOf(t('en', 'host.method.ai'))).toBe('/builder/projects');
    expect(hrefOf(t('en', 'host.method.php'))).toBe(
      '/hosting/sites/new?plan=p1&domain=example.com&method=php',
    );
    expect(hrefOf(t('en', 'host.method.nodejs'))).toContain('method=nodejs');
    expect(hrefOf(t('en', 'host.method.static'))).toContain('method=static');
    const wp = screen.getByText(t('en', 'host.method.wordpress')).closest('[role=listitem]')!;
    expect(wp.querySelector('a')).toBeNull();
    expect(wp.getAttribute('aria-disabled')).toBe('true');
    expect(within(wp as HTMLElement).getByText(t('en', 'host.method.soon'))).toBeTruthy();
  });
});
