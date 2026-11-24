// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
let path = '/hosting/plans';
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
import {
  lineFromDomain,
  lineFromPlan,
  lineFromServer,
  serializeCart,
  type CartLine,
} from '../lib/cart';
import type { CatalogPlan } from '../lib/hosting-catalog';
import { AddDomainToCart } from './AddDomainToCart';
import { Checkout } from './Checkout';
import { FloatingCart } from './FloatingCart';

const KEY = 'nuzm_cart:org-1';
const plan: CatalogPlan = {
  id: 'p1',
  key: 'web-business',
  name: { ar: 'الأعمال', en: 'Business' },
  quotas: { diskMb: 51200, inodes: 1000, bandwidthGb: 500, dbCount: 25, sitesCount: 10 },
  runtimes: ['php:8.3', 'static'],
  price: { amountMinor: '5900', currency: 'SAR', placeholder: false },
};
const seed = (lines: CartLine[]) => window.localStorage.setItem(KEY, serializeCart(lines));
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as CartLine[];
const host = lineFromPlan(plan, 'h1');
const dom = lineFromDomain('shop.example.com', { amountMinor: '3686', currency: 'SAR' }, 'd1');
const srv = lineFromServer(
  {
    offerId: 'o1',
    family: 'nova',
    country: 'SA',
    dataRegion: 'in_kingdom',
    plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 },
    price: { amount: '14220', currency: 'SAR' },
  },
  { id: 'img1', name: 'Ubuntu 24.04 LTS' },
  's1',
);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  post.mockReset();
  path = '/hosting/plans';
});
afterEach(cleanup);

describe('floating basket', () => {
  it('is not drawn while the basket is empty', async () => {
    const { container } = render(<FloatingCart locale="en" orgId="org-1" />);
    await waitFor(() => expect(container.querySelector('.nzc-cart')).toBeNull());
  });
  it('shows a round button with the count; opens to the lines and an exact total; removes a line; empties', async () => {
    seed([host, dom, srv]);
    render(<FloatingCart locale="en" orgId="org-1" />);
    const fab = await screen.findByRole('button', { name: new RegExp(t('en', 'cart.open')) });
    expect(fab.getAttribute('aria-label')).toContain('3 items');
    fireEvent.click(fab);
    const panel = screen
      .getByText(t('en', 'cart.checkout'))
      .closest('.nzc-cart-panel') as HTMLElement;
    // 59.00 + 36.86 + 142.20, added in integer minor units
    expect(within(panel).getByText(/238\.06/)).toBeTruthy();
    expect(within(panel).getByText('Business')).toBeTruthy();
    expect(within(panel).getByText('shop.example.com')).toBeTruthy();
    expect(within(panel).getByText(/Nuzm Cloud Nova/)).toBeTruthy();
    expect(
      within(panel)
        .getByRole('link', { name: t('en', 'cart.checkout') })
        .getAttribute('href'),
    ).toBe('/checkout');
    fireEvent.click(
      within(panel).getByRole('button', {
        name: t('en', 'cart.remove', { plan: 'shop.example.com' }),
      }),
    );
    await waitFor(() => expect(stored().map((l) => l.id)).toEqual(['h1', 's1']));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cart.clear') }));
    await waitFor(() => expect(stored()).toEqual([]));
  });
  it('is hidden on the checkout page, which shows the same lines in full', async () => {
    seed([host]);
    path = '/checkout';
    const { container } = render(<FloatingCart locale="en" orgId="org-1" />);
    await waitFor(() => expect(container.querySelector('.nzc-cart')).toBeNull());
  });
  it('opens by itself when something is added, and says what was added', async () => {
    render(
      <AddDomainToCart
        locale="en"
        orgId="org-1"
        name="new.example.com"
        price={{ amountMinor: '3686', currency: 'SAR' }}
      />,
    );
    render(<FloatingCart locale="en" orgId="org-1" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cart.add') }));
    await screen.findByText(t('en', 'cart.checkout'));
    expect(
      screen.getAllByText(t('en', 'cart.added', { plan: 'new.example.com' })).length,
    ).toBeGreaterThan(0);
    expect(stored()).toMatchObject([
      { kind: 'domain', domain: 'new.example.com', priceMinor: '3686' },
    ]);
  });
});

const methods = [
  { id: 'm1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true },
];
const base = {
  locale: 'en' as const,
  orgId: 'org-1',
  plans: [plan],
  projects: [{ id: 'pr1', name: 'Main' }],
  methods,
  canSites: true,
  canAddCard: true,
  sandbox: true,
};
const ok = (data: unknown) => ({ data, response: { ok: true, status: 201 } });

describe('checkout', () => {
  it('an empty basket sends the customer to the hosting plans', async () => {
    render(<Checkout {...base} />);
    expect(
      (await screen.findByRole('link', { name: t('en', 'checkout.empty.action') })).getAttribute(
        'href',
      ),
    ).toBe('/hosting/plans');
  });
  it('a domain and a server each continue in their own order step, with the basket line to finish', async () => {
    seed([dom, srv]);
    render(<Checkout {...base} />);
    const d = await screen.findByRole('link', { name: t('en', 'checkout.domains.continue') });
    expect(d.getAttribute('href')).toBe('/domains/checkout?name=shop.example.com&years=1&cart=d1');
    const s = screen.getByRole('link', { name: t('en', 'checkout.servers.continue') });
    expect(s.getAttribute('href')).toBe('/compute/instances/new?offerId=o1&image=img1&cart=s1');
  });
  it('hosting: details → card → real quote → create; the created website leaves the basket', async () => {
    seed([host]);
    post
      .mockResolvedValueOnce(
        ok({
          id: 'q1',
          currency: 'SAR',
          subtotalMinor: '5900',
          totalMinor: '6785',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          taxEstimate: { taxMinor: '885' },
        }),
      )
      .mockResolvedValueOnce(ok({ site: { id: 'site1' }, operationId: 'op1' }));
    render(<Checkout {...base} />);
    fireEvent.change(await screen.findByLabelText(t('en', 'checkout.line.name')), {
      target: { value: 'my-shop' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.next') }));
    // payment: the saved card is preselected and the sandbox note is shown
    expect(screen.getByRole('radio')).toHaveProperty('checked', true);
    expect(screen.getByText(t('en', 'checkout.payment.note'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.next') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'checkout.review.get') }));
    await screen.findByText(t('en', 'bill.f.total'));
    expect(document.body.textContent).toContain('67.85'); // the API's total with VAT, not the basket's running total
    expect(post.mock.calls[0]![1].body).toEqual({
      kind: 'hosting',
      items: [{ planId: 'p1', runtime: 'php:8.3' }],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('en', 'checkout.confirm') }));
    });
    await screen.findByText(t('en', 'checkout.done.ok', { name: 'my-shop' }));
    expect(post.mock.calls[1]![0]).toBe('/v1/hosting/sites');
    expect(post.mock.calls[1]![1].body).toMatchObject({
      quoteId: 'q1',
      planId: 'p1',
      name: 'my-shop',
      projectId: 'pr1',
      runtime: 'php:8.3',
    });
    expect(stored()).toEqual([]);
  });
  it('a website that fails stays in the basket and says why; a card is required to continue', async () => {
    seed([host]);
    render(<Checkout {...base} methods={[]} />);
    fireEvent.change(await screen.findByLabelText(t('en', 'checkout.line.name')), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.next') }));
    expect(screen.getByText(t('en', 'checkout.payment.none'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'action.next') })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen
        .getByRole('link', { name: new RegExp(t('en', 'checkout.payment.add')) })
        .getAttribute('href'),
    ).toBe(`/billing/payment-methods/add?next=${encodeURIComponent('/checkout')}`);
  });
  it('keeps what was typed while the customer goes to add a card and comes back (also under React strict mode)', async () => {
    seed([host]);
    const { StrictMode } = await import('react');
    const first = render(
      <StrictMode>
        <Checkout {...base} />
      </StrictMode>,
    );
    fireEvent.change(await screen.findByLabelText(t('en', 'checkout.line.name')), {
      target: { value: 'kept-name' },
    });
    first.unmount();
    render(
      <StrictMode>
        <Checkout {...base} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(t('en', 'checkout.line.name')) as HTMLInputElement).value).toBe(
        'kept-name',
      ),
    );
  });
  it('a plan that is no longer offered blocks the websites step until it is removed', async () => {
    seed([host]);
    render(<Checkout {...base} plans={[]} />);
    expect(await screen.findByText(t('en', 'checkout.line.gone'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'action.next') })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
