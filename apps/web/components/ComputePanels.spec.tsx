// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@nuzm/sdk';
import { t, type Locale } from '@nuzm/i18n';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh, replace: vi.fn() }) }));
const post = vi.fn();
const del = vi.fn();
const get = vi.fn();
vi.mock('../lib/compute-client', () => ({
  browserCompute: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));

import type { Instance, Offer, OperationView, Quote } from '../lib/compute';
import { computeView } from '../lib/compute-view';
import { ApprovalsPanel } from './BillingPanels';
import { ComputeTabs, ProblemAlert } from './ComputeBits';
import { InstanceDetail, InstanceNav } from './ComputeInstanceDetail';
import { InstancesPanel } from './ComputeInstances';
import { MetricsPanel } from './ComputeMetrics';
import { OffersPanel } from './ComputeOffers';
import { SnapshotsPanel } from './ComputeSnapshots';
import { ComputeWizard } from './ComputeWizard';

const IMAGE_ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77';
beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  post.mockReset();
  del.mockReset();
  // the operating systems of the chosen size (GET /v1/offers/{id}/images)
  get.mockReset();
  get.mockResolvedValue({
    data: { items: [{ id: IMAGE_ID, name: 'Ubuntu 22.04 LTS', osFamily: 'linux' }] },
    response: new Response(null, { status: 200 }),
  });
});
afterEach(cleanup);

const ok = <T,>(data: T, status = 200) => ({ data, response: new Response(null, { status }) });
const fail = (status: number, error: Record<string, unknown>) => ({
  error,
  response: new Response(null, { status }),
});

const offer = (over: Partial<Offer> = {}): Offer => ({
  offerId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01',
  kind: 'compute',
  country: 'SA',
  dataRegion: 'in_kingdom',
  plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 },
  price: { amount: '12345', currency: 'SAR', period: 'month' },
  capabilities: ['compute.action.start', 'compute.action.stop'],
  verifiedAt: '2026-11-17T10:00:00Z',
  ...over,
});
const instance = (over: Partial<Instance> = {}): Instance => ({
  id: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11',
  name: 'web-01',
  status: 'running',
  dataRegion: 'in_kingdom',
  country: 'SA',
  plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 },
  publicIps: ['203.0.113.7'],
  createdAt: '2026-11-18T09:00:00Z',
  capabilities: ['start', 'stop'],
  operationId: null,
  deletionProtected: false,
  driftState: 'in_sync',
  version: 4,
  ...over,
});
const baseDetail = {
  locale: 'en' as Locale,
  instance: instance(),
  operation: null,
  offers: [] as Offer[],
  canAct: true,
  canDelete: true,
  mfaFactorId: null,
};

describe('offers (UI-M05-01)', () => {
  const panel = (over: Partial<Parameters<typeof OffersPanel>[0]> = {}) =>
    render(
      <OffersPanel
        locale="en"
        offers={[]}
        nextCursor={null}
        filters={{}}
        errors={{}}
        canCreate
        {...over}
      />,
    );
  it('shows the "no verified offers" empty state when country=SA has none (AC-M05-03)', () => {
    panel({ filters: { country: 'SA' } });
    expect(screen.getByText(t('en', 'm05.web.offers.empty.title'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.offers.empty.filtered'))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'm05.web.offers.reset') })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('shows the empty state in Arabic as well', () => {
    panel({ locale: 'ar' });
    expect(screen.getByText(t('ar', 'm05.web.offers.empty.title'))).toBeTruthy();
  });
  it('lists offers with the price as integer minor units formatted, and never shows provider identity', () => {
    const leaky = {
      ...offer(),
      provider: 'alibaba',
      providerRegionId: 'cn-hangzhou',
      cost: '999',
    } as Offer;
    const { container } = panel({ offers: [leaky], nextCursor: 'c2', filters: { country: 'SA' } });
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.textContent).toContain('123.45');
    expect(container.textContent).toContain('2 vCPU');
    expect(container.textContent).toContain('4 GB');
    expect(container.textContent).not.toMatch(/alibaba|cn-hangzhou|999/i);
    expect(
      screen
        .getByRole('link', { name: new RegExp(`^${t('en', 'm05.web.offers.use')}`) })
        .getAttribute('href'),
    ).toContain('/en/compute/instances/new?offerId=');
    expect(
      screen.getByRole('link', { name: t('en', 'm05.web.page.next') }).getAttribute('href'),
    ).toContain('cursor=c2');
  });
  it('hides the create link without permission and reports invalid filters', () => {
    panel({ offers: [offer()], canCreate: false, errors: { country: true, minVcpu: true } });
    expect(
      screen.queryByRole('link', { name: new RegExp(`^${t('en', 'm05.web.offers.use')}`) }),
    ).toBeNull();
    expect(screen.getByText(t('en', 'm05.web.offers.country.err'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.offers.num.err'))).toBeTruthy();
  });
});

describe('instances list (UI-M05-03)', () => {
  it('shows an empty state with a create action', () => {
    render(<InstancesPanel locale="en" items={[]} nextCursor={null} canCreate />);
    expect(screen.getByText(t('en', 'm05.web.instances.empty.title'))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('en', 'm05.web.instances.create') })).toBeTruthy();
  });
  it('shows provisioning, failed and drift badges', () => {
    render(
      <InstancesPanel
        locale="en"
        nextCursor={null}
        canCreate={false}
        items={[
          instance({ id: 'a', name: 'a1', status: 'provisioning' }),
          instance({ id: 'b', name: 'b1', status: 'failed' }),
          instance({ id: 'c', name: 'c1', status: 'running', driftState: 'drift' }),
        ]}
      />,
    );
    expect(screen.getByText(t('en', 'm05.web.status.provisioning'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.status.failed'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.drift.drift'))).toBeTruthy();
    // each server: its name links to it, and its card has a Manage button to the same page
    expect(screen.getAllByRole('link').length).toBe(6);
    expect(screen.getAllByRole('link', { name: t('en', 'action.manage') })).toHaveLength(3);
  });
});

describe('instance detail (UI-M05-04)', () => {
  it('offers ONLY the actions in the instance capabilities (unsupported ones are absent)', () => {
    render(<InstanceDetail {...baseDetail} />);
    const group = screen.getByRole('group', { name: t('en', 'm05.web.actions.title') });
    expect(within(group).getByRole('button', { name: t('en', 'm05.web.act.stop') })).toBeTruthy();
    expect(within(group).getByRole('button', { name: t('en', 'm05.web.act.start') })).toBeTruthy();
    for (const k of ['reboot', 'snapshot', 'resize'] as const)
      expect(screen.queryByRole('button', { name: t('en', `m05.web.act.${k}`) })).toBeNull();
    // a running instance cannot be started
    expect(
      (
        within(group).getByRole('button', {
          name: t('en', 'm05.web.act.start'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(group).getByRole('button', {
          name: t('en', 'm05.web.act.stop'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it('shows the "none available" text when the capability set has no action', () => {
    render(<InstanceDetail {...baseDetail} instance={instance({ capabilities: ['metrics'] })} />);
    expect(screen.getByText(t('en', 'm05.web.actions.none'))).toBeTruthy();
  });
  it('sends an action with an Idempotency-Key and refreshes on 202', async () => {
    post.mockResolvedValue(ok({ operationId: 'op1' }, 202));
    render(<InstanceDetail {...baseDetail} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.act.stop') }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [path, o] = post.mock.calls[0] as [string, { body: unknown; idempotencyKey: string }];
    expect(path).toBe(`/v1/compute/instances/${instance().id}/actions`);
    expect(o.body).toEqual({ type: 'stop' });
    expect(o.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole('status').textContent).toContain(t('en', 'm05.web.act.stop'));
  });
  it('maps invalid_state and unsupported_capability problems to localised messages', async () => {
    post.mockResolvedValueOnce(fail(409, { code: 'invalid_state', traceId: 'tr-1' }));
    render(<InstanceDetail {...baseDetail} locale="ar" />);
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'm05.web.act.stop') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('ar', 'm05.web.err.invalid_state'));
    expect(alert.textContent).toContain('tr-1');
  });
  it('shows the uncertain-state banner for UNKNOWN and pauses actions', () => {
    render(<InstanceDetail {...baseDetail} instance={instance({ status: 'unknown' })} />);
    expect(screen.getByText(t('en', 'm05.web.uncertain.title'))).toBeTruthy();
    for (const b of within(
      screen.getByRole('group', { name: t('en', 'm05.web.actions.title') }),
    ).getAllByRole('button'))
      expect((b as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows the uncertain-state banner when the operation needs reconciliation', () => {
    const op: OperationView = {
      id: 'o',
      kind: 'compute.instance.create',
      state: 'needs_reconcile',
      attempts: 2,
      cancelRequested: false,
      createdAt: '2026-11-18T09:00:00Z',
      updatedAt: '2026-11-18T09:01:00Z',
    };
    render(<InstanceDetail {...baseDetail} operation={op} />);
    expect(screen.getByText(t('en', 'm05.web.uncertain.title'))).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('en', 'm05.web.timeline.title') })).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.opstate.needs_reconcile'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.timeline.attempts', { n: 2 }))).toBeTruthy();
  });
  it('offers resize with same-placement sizes only and sends the chosen offer id', async () => {
    post.mockResolvedValue(ok({ operationId: 'op' }, 202));
    const bigger = offer({ offerId: 'bigger', plan: { vcpu: 4, memoryMb: 8192, diskGb: 160 } });
    const elsewhere = offer({ offerId: 'eu', dataRegion: 'eu', country: 'DE' });
    render(
      <InstanceDetail
        {...baseDetail}
        instance={instance({ capabilities: ['resize'] })}
        offers={[bigger, elsewhere]}
      />,
    );
    const select = screen.getByLabelText(t('en', 'm05.web.resize.label')) as HTMLSelectElement;
    expect(select.options.length).toBe(2); // placeholder + the offer in the same placement
    const btn = screen.getByRole('button', {
      name: t('en', 'm05.web.act.resize'),
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'bigger' } });
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      type: 'resize',
      params: { offerId: 'bigger' },
    });
  });
  it('asks for confirmation before deleting and sends If-Match with the instance version', async () => {
    del.mockResolvedValue(ok({ operationId: 'op' }, 202));
    render(<InstanceDetail {...baseDetail} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.delete.start') }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.delete.confirmBtn') }));
    await waitFor(() => expect(del).toHaveBeenCalled());
    const [, o] = del.mock.calls[0] as [string, { ifMatch: string; idempotencyKey: string }];
    expect(o.ifMatch).toBe('"4"');
    expect(o.idempotencyKey).toBeTruthy();
  });
  it('prefers the ETag the API sent for If-Match', async () => {
    del.mockResolvedValue(ok({ operationId: 'op' }, 202));
    render(<InstanceDetail {...baseDetail} etag={'W/"inst-9"'} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.delete.start') }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.delete.confirmBtn') }));
    await waitFor(() => expect(del).toHaveBeenCalled());
    expect((del.mock.calls[0] as [string, { ifMatch: string }])[1].ifMatch).toBe('W/"inst-9"');
  });
  it('disables delete while protection is on and hides actions without permission', () => {
    render(
      <InstanceDetail
        {...baseDetail}
        canAct={false}
        instance={instance({ deletionProtected: true })}
      />,
    );
    expect(
      (screen.getByRole('button', { name: t('en', 'm05.web.delete.start') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole('group', { name: t('en', 'm05.web.actions.title') })).toBeNull();
  });
  it('links metrics and snapshots only when supported', () => {
    const { rerender } = render(
      <InstanceNav
        locale="en"
        instance={{ id: 'x', capabilities: ['start'] }}
        current="overview"
      />,
    );
    expect(screen.queryByRole('link', { name: t('en', 'm05.web.detail.tab.metrics') })).toBeNull();
    expect(
      screen.queryByRole('link', { name: t('en', 'm05.web.detail.tab.snapshots') }),
    ).toBeNull();
    rerender(
      <InstanceNav
        locale="en"
        instance={{ id: 'x', capabilities: ['compute.metrics', 'snapshot'] }}
        current="overview"
      />,
    );
    expect(screen.getByRole('link', { name: t('en', 'm05.web.detail.tab.metrics') })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'm05.web.detail.tab.snapshots') }),
    ).toBeTruthy();
  });
});

describe('metrics (UI-M05-05) and snapshots (UI-M05-06)', () => {
  it('metrics: unsupported is an empty state, supported shows the series', () => {
    const { rerender } = render(<MetricsPanel locale="en" unsupported series={[]} window="1h" />);
    expect(screen.getByText(t('en', 'm05.web.metrics.unsupported.title'))).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    rerender(
      <MetricsPanel
        locale="en"
        unsupported={false}
        window="24h"
        series={[{ name: 'cpu', unit: '%', points: 3, latest: 2.5, min: 1, max: 3 }]}
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    rerender(<MetricsPanel locale="en" unsupported={false} window="1h" series={[]} />);
    expect(screen.getByText(t('en', 'm05.web.metrics.empty.title'))).toBeTruthy();
  });
  it('snapshots: unsupported shows the empty state and no create button', () => {
    render(
      <SnapshotsPanel
        locale="en"
        instanceId="i"
        status="running"
        supported={false}
        canAct
        mfaFactorId={null}
      />,
    );
    expect(screen.getByText(t('en', 'm05.web.snap.unsupported.title'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('snapshots: creates one through the snapshot action', async () => {
    post.mockResolvedValue(ok({ operationId: 'op' }, 202));
    render(
      <SnapshotsPanel
        locale="en"
        instanceId="i1"
        status="running"
        supported
        canAct
        mfaFactorId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.snap.create') }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      type: 'snapshot',
    });
    expect(await screen.findByText(t('en', 'm05.web.snap.requested'))).toBeTruthy();
  });
});

describe('create wizard (UI-M05-02)', () => {
  const quote = (over: Partial<Quote> = {}): Quote => ({
    id: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a21',
    kind: 'compute',
    status: 'issued',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    currency: 'SAR',
    items: [
      {
        position: 1,
        description: 'vCPU hours',
        quantity: '1460',
        unit: 'h',
        unitPriceMinor: '5',
        amountMinor: '7300',
      },
    ],
    subtotalMinor: '10000',
    taxEstimate: { status: 'provisional', rateBps: 1500, taxMinor: '1500', note: 'n' },
    totalMinor: '11500',
    requiresApproval: false,
    residency: { decision: 'allow', policyVersion: 3, dataRegion: 'in_kingdom' },
    ...over,
  });
  const ed = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl u@h';
  const O = offer();

  /** Walks configure (size, operating system, name) → keys and requests the quote. */
  async function toReview(locale: Locale = 'en') {
    render(
      <ComputeWizard locale={locale} offers={[O]} initialOfferId={O.offerId} mfaFactorId={null} />,
    );
    fireEvent.click(await screen.findByLabelText('Ubuntu 22.04 LTS'));
    fireEvent.change(screen.getByLabelText(t(locale, 'field.name')), {
      target: { value: 'web-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'action.next') }));
    fireEvent.change(screen.getByLabelText(t(locale, 'm05.web.wiz.keys')), {
      target: { value: ed },
    });
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'm05.web.wiz.getQuote') }));
  }

  it('shows an empty state when there is no verified offer', () => {
    render(<ComputeWizard locale="en" offers={[]} mfaFactorId={null} />);
    expect(screen.getByText(t('en', 'm05.web.wiz.noOffers.title'))).toBeTruthy();
  });
  it('groups the choices by region, Nuzm Cloud line and size, and prices the selection as you go', async () => {
    const offers = [
      offer({
        offerId: 'a',
        family: 'nova',
        plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 },
        price: { amount: '14220', currency: 'SAR', period: 'month' },
      }),
      offer({
        offerId: 'b',
        family: 'nova',
        plan: { vcpu: 4, memoryMb: 8192, diskGb: 160 },
        price: { amount: '28440', currency: 'SAR', period: 'month' },
      }),
      offer({
        offerId: 'c',
        family: 'orbit',
        plan: { vcpu: 2, memoryMb: 4096, diskGb: 200 },
        price: { amount: '8000', currency: 'SAR', period: 'month' },
      }),
      offer({
        offerId: 'd',
        family: 'nova',
        country: 'AE',
        dataRegion: 'gcc',
        plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 },
        price: { amount: '15000', currency: 'SAR', period: 'month' },
      }),
    ];
    render(<ComputeWizard locale="en" offers={offers} mfaFactorId={null} />);
    // the Kingdom region is first and selected; its two lines are named as Nuzm products
    expect(screen.getByLabelText(/Saudi Arabia/)).toHaveProperty('checked', true);
    expect(screen.getByLabelText(/Nuzm Cloud Nova/)).toBeTruthy();
    expect(screen.getByLabelText(/Nuzm Cloud Orbit/)).toBeTruthy();
    // the cheapest size of the first line is chosen and its price is in the summary (integer minor units, never a float)
    const summary = screen.getByRole('complementary');
    expect(within(summary).getByText('SAR 142.20')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/4 vCPU/));
    expect(within(summary).getByText('SAR 284.40')).toBeTruthy();
    // another line keeps the nearest size, another region shows its own offers
    fireEvent.click(screen.getByLabelText(/Nuzm Cloud Orbit/));
    expect(within(summary).getByText('SAR 80.00')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/United Arab Emirates/));
    expect(within(summary).getByText('SAR 150.00')).toBeTruthy();
    // no vendor name anywhere on the screen
    expect(document.body.textContent).not.toMatch(/alibaba|huawei|contabo/i);
  });
  it('lists the operating systems of the chosen size from the API and clears the choice when the size changes', async () => {
    const offers = [
      offer({ offerId: 'a', plan: { vcpu: 2, memoryMb: 4096, diskGb: 80 } }),
      offer({ offerId: 'b', plan: { vcpu: 4, memoryMb: 8192, diskGb: 160 } }),
    ];
    render(<ComputeWizard locale="en" offers={offers} mfaFactorId={null} />);
    fireEvent.click(await screen.findByLabelText('Ubuntu 22.04 LTS'));
    expect(get).toHaveBeenCalledWith('/v1/offers/a/images');
    fireEvent.click(screen.getByLabelText(/4 vCPU/));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/v1/offers/b/images'));
    expect((await screen.findByLabelText('Ubuntu 22.04 LTS')) as HTMLInputElement).toHaveProperty(
      'checked',
      false,
    );
  });
  it('says so when a size has no operating system or the list cannot be loaded', async () => {
    get.mockResolvedValueOnce(ok({ items: [] }));
    const { unmount } = render(<ComputeWizard locale="en" offers={[O]} mfaFactorId={null} />);
    expect(await screen.findByText(t('en', 'cloud.cfg.os.none'))).toBeTruthy();
    unmount();
    get.mockResolvedValueOnce(fail(500, {}));
    render(<ComputeWizard locale="en" offers={[O]} mfaFactorId={null} />);
    expect(await screen.findByText(t('en', 'cloud.cfg.os.error'))).toBeTruthy();
  });
  it('validates the choices before moving on', async () => {
    render(<ComputeWizard locale="en" offers={[O]} mfaFactorId={null} />);
    await screen.findByLabelText('Ubuntu 22.04 LTS');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.next') }));
    expect(screen.getByText(t('en', 'm05.web.wiz.name.err'))).toBeTruthy();
    expect(screen.getByText(t('en', 'm05.web.wiz.image.err'))).toBeTruthy();
  });
  it('rejects an invalid SSH key line without calling the API', async () => {
    render(
      <ComputeWizard locale="en" offers={[O]} initialOfferId={O.offerId} mfaFactorId={null} />,
    );
    fireEvent.click(await screen.findByLabelText('Ubuntu 22.04 LTS'));
    fireEvent.change(screen.getByLabelText(t('en', 'field.name')), { target: { value: 'web-01' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.next') }));
    fireEvent.change(screen.getByLabelText(t('en', 'm05.web.wiz.keys')), {
      target: { value: 'not a key' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.wiz.getQuote') }));
    expect(screen.getByText(t('en', 'm05.web.wiz.keys.err', { lines: 1 }))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('reviews cost, tax estimate and the residency result, then creates the instance with the quote and an Idempotency-Key', async () => {
    post.mockResolvedValueOnce(ok(quote(), 201));
    await toReview();
    expect(await screen.findByText(t('en', 'm05.web.quote.provisional'))).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toContain('115.00'); // total from integer minor units
    expect(body).toContain('15.00'); // tax estimate
    expect(body).toContain(
      t('en', 'm05.web.quote.res.allowed', {
        region: t('en', 'm05.web.region.in_kingdom'),
        version: '3',
      }),
    );
    const [qPath, qOpts] = post.mock.calls[0] as [
      string,
      { body: Record<string, unknown>; idempotencyKey: string },
    ];
    expect(qPath).toBe('/v1/quotes');
    expect(qOpts.body).toMatchObject({
      kind: 'compute',
      offerId: O.offerId,
      spec: { imageId: IMAGE_ID, count: 1 },
      term: { period: 'month' },
    });
    expect(qOpts.idempotencyKey).toBeTruthy();

    post.mockResolvedValueOnce(
      ok({ instance: { id: 'new-id', status: 'provisioning' }, operationId: 'op' }, 202),
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.wiz.confirm') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/compute/instances/new-id'));
    const [cPath, cOpts] = post.mock.calls[1] as [
      string,
      { body: Record<string, unknown>; idempotencyKey: string },
    ];
    expect(cPath).toBe('/v1/compute/instances');
    expect(cOpts.body).toEqual({ quoteId: quote().id, name: 'web-01', sshPublicKeys: [ed] });
    expect(cOpts.idempotencyKey).toBeTruthy();
    expect(cOpts.idempotencyKey).not.toBe(qOpts.idempotencyKey);
  });
  it('quote expired: blocks confirm and offers a fresh quote', async () => {
    post.mockResolvedValueOnce(
      ok(quote({ expiresAt: new Date(Date.now() - 1000).toISOString() }), 201),
    );
    await toReview();
    expect(await screen.findByText(t('en', 'm05.web.quote.expired'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'm05.web.wiz.confirm') })).toBeNull();
    post.mockResolvedValueOnce(ok(quote(), 201));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.quote.renew') }));
    expect(
      await screen.findByRole('button', { name: t('en', 'm05.web.wiz.confirm') }),
    ).toBeTruthy();
  });
  it('quote_expired from the API is localised and switches to "get a new quote"', async () => {
    post.mockResolvedValueOnce(ok(quote(), 201));
    await toReview('ar');
    await screen.findByText(t('ar', 'm05.web.quote.provisional'));
    post.mockResolvedValueOnce(fail(409, { code: 'quote_expired' }));
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'm05.web.wiz.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('ar', 'm05.web.err.quote_expired'));
    expect(screen.getByRole('button', { name: t('ar', 'm05.web.quote.renew') })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
  it('residency denied is shown as a clear, localised error', async () => {
    post.mockResolvedValueOnce(ok(quote(), 201));
    await toReview();
    await screen.findByText(t('en', 'm05.web.quote.provisional'));
    post.mockResolvedValueOnce(fail(403, { code: 'residency_denied', traceId: 'tr-9' }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.wiz.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('en', 'm05.web.err.residency_denied'));
    expect(alert.textContent).toContain('tr-9');
  });
  it('spend approval required links to the approvals screen with the approval id', async () => {
    post.mockResolvedValueOnce(ok(quote({ requiresApproval: true }), 201));
    await toReview();
    await screen.findByText(t('en', 'm05.web.quote.provisional'));
    expect(screen.getByText(new RegExp(t('en', 'm05.web.quote.needsApproval')))).toBeTruthy();
    post.mockResolvedValueOnce(
      fail(422, {
        code: 'spend_approval_required',
        approvalId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a31',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.web.wiz.confirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('en', 'm05.web.err.spend_approval_required'));
    expect(alert.textContent).toContain('0198a1b2');
    expect(within(alert).getByRole('link').getAttribute('href')).toBe('/en/billing/approvals');
  });
  it('no_eligible_offer at the quote step lets the user pick another offer', async () => {
    post.mockResolvedValueOnce(fail(422, { code: 'no_eligible_offer' }));
    await toReview();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('en', 'm05.web.err.no_eligible_offer'));
    fireEvent.click(
      within(alert).getByRole('button', { name: t('en', 'm05.web.wiz.chooseOther') }),
    );
    expect(
      screen.getByRole('heading', { name: t('en', 'm05.web.wiz.step.configure') }),
    ).toBeTruthy();
  });
});

describe('shared pieces', () => {
  it('lists only the tabs the member may open', () => {
    render(<ComputeTabs locale="en" current="offers" can={(p) => p === 'offers:read'} />);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/en/compute/offers',
    ]);
  });
  it('maps every known problem code to a localised message in both languages', () => {
    for (const l of ['ar', 'en'] as const)
      for (const code of [
        'quote_expired',
        'quote_consumed',
        'price_changed',
        'spend_approval_required',
        'residency_denied',
        'quota_exceeded',
        'unsupported_capability',
        'invalid_state',
        'deletion_protected',
        'no_eligible_offer',
      ]) {
        const { unmount } = render(<ProblemAlert locale={l} problem={{ status: 409, code }} />);
        expect(screen.getByRole('alert').textContent).toContain(
          t(l, `m05.web.err.${code}` as 'm05.web.err.quote_expired'),
        );
        unmount();
      }
  });
  it('computeView renders "not available" for a 404 (flag off) and forbidden for a 403, never throwing', async () => {
    const notFound = await computeView(
      'en',
      async () => Promise.reject(new ApiError(404, 'not_found', undefined, undefined, undefined)),
      () => <p>data</p>,
    );
    render(<>{notFound}</>);
    expect(screen.getByText(t('en', 'm05.web.unavailable.title'))).toBeTruthy();
    cleanup();
    const forbidden = await computeView(
      'en',
      async () => Promise.reject(new ApiError(403, 'forbidden', undefined, undefined, undefined)),
      () => <p>data</p>,
    );
    render(<>{forbidden}</>);
    expect(screen.getByText(t('en', 'state.forbidden.title'))).toBeTruthy();
    cleanup();
    const boom = await computeView(
      'en',
      async () => Promise.reject(new ApiError(500, 'x', undefined, 'tr-5', undefined)),
      () => <p>data</p>,
    );
    render(<>{boom}</>);
    expect(screen.getByRole('alert').textContent).toContain('tr-5');
  });
});

describe('spend approvals recognise provisioning (UI-M05-07)', () => {
  const row = {
    id: 'a1',
    requesterUserId: 'u2',
    subjectKind: 'quote',
    subjectId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a21',
    amountMinor: '11500',
    currency: 'SAR',
    reason: 'new server',
    status: 'pending',
    fourEyes: true,
    expiresAt: '2026-11-19T10:00:00Z',
  };
  const props = {
    locale: 'en' as Locale,
    rows: [row],
    fmt: { a1: 'x' },
    selfId: 'u1',
    canDecide: true,
    mfaFactorId: null,
  };
  it('marks a compute-quote approval as provisioning with its summary, and keeps approve/deny', () => {
    render(
      <ApprovalsPanel
        {...props}
        provisioning={{ a1: { summary: '2 vCPU', totalMinor: '11500', currency: 'SAR' } }}
      />,
    );
    expect(screen.getByText(t('en', 'm05.web.approvals.provisioning'))).toBeTruthy();
    expect(screen.getByText(/2 vCPU/)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'bill.act.approve') })).toBeTruthy();
  });
  it('does not mark other approvals, and prefills the request form from the wizard', () => {
    render(
      <ApprovalsPanel {...props} prefill={{ quoteId: row.subjectId, amountMinor: '11500' }} />,
    );
    expect(screen.queryByText(t('en', 'm05.web.approvals.provisioning'))).toBeNull();
    expect((screen.getByLabelText(t('en', 'bill.f.subjectId')) as HTMLInputElement).value).toBe(
      row.subjectId,
    );
    expect((screen.getByLabelText(t('en', 'bill.f.amount')) as HTMLInputElement).value).toBe('115');
  });
});
