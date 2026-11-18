// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const get = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, GET: get }) }));

import type { AccountDto, CapabilityRow, ProviderDto, RegionRow } from '../lib/providers';
import { AuditedReadNotice, ResourcesTable } from './CloudResources';
import { LiveVerificationPanel } from './LiveVerification';
import { AccountSummary, CapabilityTable, PlansTable, RegionsTable } from './ProviderAccountDetail';
import { AccountsTable, AddAccountForm } from './ProviderAccounts';
import { JobPoller } from './ProviderBits';
import { CostTotals, CostsTable, MarginPanel, Rc04Table } from './ProviderCosts';
import { AccountHealthTable, ProvidersTable } from './ProviderRegistry';
import { RoutingPanel } from './ProviderRouting';
import { ProviderTabs } from './ProviderTabs';

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});
afterEach(cleanup);

const SECRET = ['hunter2', 'SECRET', 'value', '0123456789'].join('-');
const provider = (o: Partial<ProviderDto> = {}): ProviderDto => ({
  id: '0194a1b2-1111-7222-8333-444455556666',
  key: 'alibaba',
  kind: 'compute',
  adapterId: 'alibaba-ecs',
  status: 'active',
  environmentPolicy: 'any',
  adapterAvailable: false,
  accountCount: 1,
  ...o,
});
const account = (o: Partial<AccountDto> = {}): AccountDto => ({
  id: '0194a1b2-aaaa-7222-8333-444455556666',
  providerId: provider().id,
  providerKey: 'alibaba',
  adapterId: 'alibaba-ecs',
  name: 'Main',
  credentialRef: 'vault://providers/alibaba/main',
  status: 'active',
  health: { state: 'healthy', breaker: { state: 'closed' } },
  version: 1,
  ...o,
});
const toneOf = (el: Element | null) => el?.closest('.nz-badge')?.getAttribute('data-tone');
const badges = (c: HTMLElement) => [...c.querySelectorAll('.nz-badge')];

describe('navigation (UI-M05-08..15)', () => {
  it('lists the sections only for a caller with admin:provider:read', () => {
    const { container, rerender } = render(
      <ProviderTabs locale="en" current="registry" can={() => false} />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <ProviderTabs locale="en" current="routing" can={(p) => p === 'admin:provider:read'} />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(
      screen
        .getByRole('link', { name: t('en', 'm05.adm.tab.routing') })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('registry (UI-M05-08)', () => {
  it('shows adapter availability, unverified accounts and the worst circuit state', () => {
    const { container } = render(
      <ProvidersTable
        locale="en"
        providers={[provider()]}
        accounts={[
          account({ verifiedAt: null }),
          account({ id: 'x', health: { state: 'unhealthy', breaker: { state: 'open' } } }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain(t('en', 'm05.adm.reg.adapterNo'));
    expect(text).toContain(t('en', 'm05.adm.reg.unverified', { count: 2 }));
    expect(text).toContain(t('en', 'm05.adm.breaker.open'));
  });
  it('empty states', () => {
    render(<ProvidersTable locale="en" providers={[]} accounts={[]} />);
    expect(screen.getByText(t('en', 'm05.adm.reg.empty.title'))).toBeTruthy();
    cleanup();
    render(<AccountHealthTable locale="ar" accounts={[]} />);
    expect(screen.getByText(t('ar', 'm05.adm.acc.empty.title'))).toBeTruthy();
  });
  it('an account that never ran verification is marked, never verified', () => {
    const { container } = render(
      <AccountHealthTable locale="en" accounts={[account({ verifiedAt: null })]} />,
    );
    expect(container.textContent).toContain(t('en', 'm05.adm.acc.notVerified'));
  });
});

describe('accounts (UI-M05-09): a credential value is never shown or accepted', () => {
  it('renders the vault reference, but hides anything that is not one', () => {
    const { container } = render(
      <AccountsTable
        locale="en"
        rows={[account({ credentialRef: SECRET }), account({ id: 'b', name: 'Second' })]}
        canManage={false}
        mfaFactorId={null}
      />,
    );
    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).toContain('vault://providers/alibaba/main');
    expect(container.textContent).toContain(t('en', 'm05.adm.acc.refHidden'));
  });
  it('the verification button is only offered to managers', () => {
    const { rerender } = render(
      <AccountsTable locale="en" rows={[account()]} canManage={false} mfaFactorId={null} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<AccountsTable locale="en" rows={[account()]} canManage mfaFactorId={null} />);
    expect(screen.getByRole('button', { name: /Run verification/ })).toBeTruthy();
  });
  it('empty state', () => {
    render(<AccountsTable locale="ar" rows={[]} canManage mfaFactorId={null} />);
    expect(screen.getByText(t('ar', 'm05.adm.acc.empty.title'))).toBeTruthy();
  });
  it('verification starts a job (202) with an idempotency key and follows it', async () => {
    post.mockResolvedValue({
      response: { ok: true, status: 202 },
      data: { operationId: 'job-1', job: {} },
    });
    get.mockResolvedValue({
      response: { ok: true, status: 200 },
      data: {
        id: 'job-1',
        accountId: 'a',
        kind: 'verification',
        state: 'succeeded',
        result: { health: 'healthy' },
      },
    });
    render(<AccountsTable locale="en" rows={[account()]} canManage mfaFactorId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Run verification/ }));
    await waitFor(() =>
      expect(screen.getByText(t('en', 'm05.adm.job.state.succeeded'))).toBeTruthy(),
    );
    const [path, init] = post.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(path).toBe('/v1/admin/provider-accounts/{id}/verification');
    expect(init.headers['Idempotency-Key']).toMatch(/\S{8}/);
    expect(get).toHaveBeenCalledWith('/v1/admin/provider-jobs/{id}', {
      params: { path: { id: 'job-1' } },
    });
  });

  const fill = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  it('refuses a non-vault value on the screen without calling the API', () => {
    render(<AddAccountForm locale="en" providers={[provider()]} mfaFactorId={null} />);
    fill(t('en', 'field.name'), 'Main');
    fill(t('en', 'm05.adm.col.credentialRef'), SECRET);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.adm.acc.addSubmit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'm05.adm.acc.err.vaultRef'));
    expect(post).not.toHaveBeenCalled();
  });
  it('a value the server rejects is cleared from the field and its explanation is not shown', async () => {
    post.mockResolvedValue({
      response: { ok: false, status: 422 },
      error: { code: 'credential_value_rejected', detail: `echo ${SECRET}`, traceId: 'tr-1' },
    });
    const { container } = render(
      <AddAccountForm locale="en" providers={[provider()]} mfaFactorId={null} />,
    );
    fill(t('en', 'field.name'), 'Main');
    fill(t('en', 'm05.adm.col.credentialRef'), 'vault://providers/x');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.adm.acc.addSubmit') }));
    await waitFor(() =>
      expect(container.textContent).toContain(t('en', 'm05.adm.err.credential_value_rejected')),
    );
    expect(container.textContent).not.toContain(SECRET);
    await waitFor(() =>
      expect(
        (screen.getByLabelText(t('en', 'm05.adm.col.credentialRef')) as HTMLInputElement).value,
      ).toBe(''),
    );
    // only the vault reference travels, in the one credential field
    const body = (post.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(Object.keys(body).sort()).toEqual(['credentialRef', 'name', 'providerId']);
  });
  it('a successful add reports it and sends an idempotency key', async () => {
    post.mockResolvedValue({ response: { ok: true, status: 201 }, data: account() });
    render(<AddAccountForm locale="ar" providers={[provider()]} mfaFactorId={null} />);
    fill(t('ar', 'field.name'), 'الرئيسي');
    fill(t('ar', 'm05.adm.col.credentialRef'), 'vault://providers/alibaba/main');
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'm05.adm.acc.addSubmit') }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(t('ar', 'm05.adm.acc.created')),
    );
    expect(
      (post.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers[
        'Idempotency-Key'
      ],
    ).toBeTruthy();
  });
});

describe('job poller', () => {
  it('shows the localized reason of a failed job (adapter_not_available)', async () => {
    get.mockResolvedValue({
      response: { ok: true, status: 200 },
      data: {
        id: 'j',
        accountId: 'a',
        kind: 'verification',
        state: 'failed',
        error: { code: 'adapter_not_available', message: 'x' },
      },
    });
    render(<JobPoller locale="en" jobId="j" />);
    await waitFor(() => expect(screen.getByText(t('en', 'm05.adm.job.state.failed'))).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain(
      t('en', 'm05.adm.err.adapter_not_available'),
    );
  });
  it('says so when the status cannot be read', async () => {
    get.mockResolvedValue({ response: { ok: false, status: 404 } });
    render(<JobPoller locale="en" jobId="j" />);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t('en', 'm05.adm.job.pollFailed')),
    );
  });
});

describe('account detail (UI-M05-10)', () => {
  const caps: CapabilityRow[] = [
    {
      capabilityId: 'compute.provision',
      state: 'supported',
      effective: 'supported',
      evidenceRef: 'ev-1',
      probedAt: '2026-11-18T00:00:00Z',
    },
    {
      capabilityId: 'compute.metrics',
      state: 'unknown',
      effective: 'unsupported',
      probedAt: null,
      evidenceRef: null,
    },
    {
      capabilityId: 'compute.delete',
      state: 'unsupported',
      effective: 'unsupported',
      probedAt: null,
      evidenceRef: null,
    },
  ];
  it('shows unknown as UNSUPPORTED, never as supported', () => {
    const { container } = render(<CapabilityTable locale="en" rows={caps} />);
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows[0]!.textContent).toContain('Supported');
    for (const r of rows.slice(1)) {
      expect(r.textContent).toContain('Unsupported');
      expect(r.textContent).not.toMatch(/(?<!Un)[Ss]upported/);
      expect(toneOf(r.querySelector('.nz-badge'))).toBeNull();
    }
    expect(rows[1]!.textContent).toContain(t('en', 'm05.adm.cap.notProbed'));
  });
  it('Arabic render of the matrix', () => {
    const { container } = render(<CapabilityTable locale="ar" rows={caps} />);
    expect(container.textContent).toContain(t('ar', 'm05.adm.cap.unsupported'));
  });
  it('empty matrix', () => {
    render(<CapabilityTable locale="en" rows={[]} />);
    expect(screen.getByText(t('en', 'm05.adm.cap.empty.title'))).toBeTruthy();
  });

  const region = (o: Partial<RegionRow>): RegionRow => ({
    id: Math.random().toString(),
    providerRegionId: 'me-central-1',
    countryCode: 'SA',
    state: 'verified',
    verifiedAt: '2026-11-18T00:00:00Z',
    evidenceRef: 'ev-9',
    evidenceKind: 'live',
    ...o,
  });
  it('fixture and mock evidence is never rendered as verified or green', () => {
    const { container } = render(
      <RegionsTable
        locale="en"
        rows={[
          region({ providerRegionId: 'r-fix', evidenceKind: 'fixture' }),
          region({ providerRegionId: 'r-mock', evidenceKind: 'mock' }),
          region({ providerRegionId: 'r-none', evidenceKind: null }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain(t('en', 'm05.adm.reg2.v.verified_live'));
    expect(text.match(/NOT VERIFIED/g)).toHaveLength(3);
    expect(badges(container).filter((b) => b.getAttribute('data-tone') === 'success')).toHaveLength(
      0,
    );
    expect(text).toContain(t('en', 'm05.adm.evidence.fixture'));
    expect(text).toContain(t('en', 'm05.adm.evidence.mock'));
  });
  it('live evidence is the only verified and green case, with its evidence kind', () => {
    const { container } = render(<RegionsTable locale="en" rows={[region({})]} />);
    expect(container.textContent).toContain(t('en', 'm05.adm.reg2.v.verified_live'));
    expect(container.textContent).toContain(t('en', 'm05.adm.evidence.live'));
    expect(badges(container).filter((b) => b.getAttribute('data-tone') === 'success')).toHaveLength(
      2,
    );
  });
  it('empty regions and plans; plan price is integer minor units in the vendor currency', () => {
    render(<RegionsTable locale="en" rows={[]} />);
    expect(screen.getByText(t('en', 'm05.adm.reg2.empty.title'))).toBeTruthy();
    cleanup();
    const { container } = render(
      <PlansTable
        locale="en"
        rows={[
          {
            id: 'p1',
            providerRegionId: 'r',
            planRef: 'ecs.g6',
            vcpu: 2,
            memoryMb: 4096,
            diskGb: 40,
            availability: 'available',
            providerPrice: { amountMinor: '123456', currency: 'CNY', period: 'month' },
          },
          {
            id: 'p2',
            providerRegionId: 'r',
            planRef: 'ecs.x',
            vcpu: 1,
            memoryMb: 1024,
            diskGb: 10,
            availability: 'sold_out',
            providerPrice: null,
          },
        ]}
      />,
    );
    expect(container.textContent).toContain('1,234.56 CNY');
    expect(container.textContent).toContain(t('en', 'm05.adm.plan.noPrice'));
  });
  it('the summary shows a vault reference and never a value', () => {
    const { container } = render(
      <AccountSummary locale="en" a={account({ credentialRef: SECRET })} />,
    );
    expect(container.textContent).not.toContain(SECRET);
  });
});

describe('routing (UI-M05-11)', () => {
  it('shows the rules; the editor and edit buttons exist only for managers; the simulator is read-only', () => {
    const rules = [
      {
        id: 'r1',
        ruleKey: 'sa.prefer',
        version: 2,
        priority: 10,
        match: { country: ['SA'] },
        action: { type: 'prefer', providerKey: 'contabo' },
        enabled: true,
      },
    ];
    const { container, rerender } = render(
      <RoutingPanel locale="en" rules={rules} canManage={false} mfaFactorId={null} />,
    );
    expect(container.textContent).toContain('sa.prefer');
    expect(screen.queryByRole('form', { name: t('en', 'm05.adm.rt.newRule') })).toBeNull();
    expect(screen.queryByRole('button', { name: /New version of rule/ })).toBeNull();
    expect(screen.getByRole('form', { name: t('en', 'm05.adm.rt.sim') })).toBeTruthy();
    expect(container.textContent).toContain(t('en', 'm05.adm.rt.sim.readOnly'));
    rerender(<RoutingPanel locale="en" rules={rules} canManage mfaFactorId={null} />);
    expect(screen.getByRole('form', { name: t('en', 'm05.adm.rt.newRule') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New version of rule sa\.prefer/ }));
    expect(screen.getByRole('form', { name: t('en', 'm05.adm.rt.editRule') })).toBeTruthy();
  });
  it('empty rule list', () => {
    render(<RoutingPanel locale="ar" rules={[]} canManage={false} mfaFactorId={null} />);
    expect(screen.getByText(t('ar', 'm05.adm.rt.empty.title'))).toBeTruthy();
  });
  it('refuses an invalid rule without calling the API', () => {
    render(<RoutingPanel locale="en" rules={[]} canManage mfaFactorId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
  });
  it('the simulator reads the admin offers endpoint (GET only) and shows failing conditions', async () => {
    get.mockResolvedValue({
      response: { ok: true, status: 200 },
      data: {
        items: [
          { offerId: 'o1', eligible: true, provider: { key: 'contabo' }, planRef: 'vps-s' },
          { offerId: 'o2', eligible: false, planRef: 'big', failures: ['region_not_verified'] },
        ],
        nextCursor: null,
      },
    });
    render(<RoutingPanel locale="en" rules={[]} canManage={false} mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'm05.adm.rt.sim.org')), {
      target: { value: '0194a1b2-1111-7222-8333-444455556666' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm05.adm.rt.sim.run') }));
    await waitFor(() => expect(screen.getByText(/region_not_verified/)).toBeTruthy());
    expect(post).not.toHaveBeenCalled();
    const [path, init] = get.mock.calls[0] as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(path).toBe('/v1/admin/offers');
    expect(init.params.query.includeIneligible).toBe(true);
  });
});

describe('resources and operations (UI-M05-12/13)', () => {
  const res = (o: Record<string, unknown> = {}) => ({
    id: '0194a1b2-cccc-7222-8333-444455556666',
    orgId: '0194a1b2-dddd-7222-8333-444455556666',
    kind: 'compute.instance',
    providerAccountId: 'a',
    providerKey: 'contabo',
    state: 'UNKNOWN',
    dataRegion: 'eu',
    country: 'DE',
    providerRegionId: 'EU',
    driftState: 'orphan_suspected',
    createdAt: '2026-11-18T00:00:00Z',
    ...o,
  });
  it('shows the audited cross-org notice, drift state, and force reconcile only for managers', () => {
    const { container, rerender } = render(
      <>
        <AuditedReadNotice locale="en" />
        <ResourcesTable
          locale="en"
          rows={[res()]}
          canManage={false}
          mfaFactorId={null}
          caption="cap"
        />
      </>,
    );
    expect(container.textContent).toContain(t('en', 'm05.adm.res.audited'));
    expect(container.textContent).toContain(t('en', 'm05.adm.res.drift.orphan_suspected'));
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <ResourcesTable locale="en" rows={[res()]} canManage mfaFactorId={null} caption="cap" />,
    );
    expect(screen.getByRole('button', { name: /Force reconciliation of resource/ })).toBeTruthy();
  });
  it('force reconcile posts with an idempotency key and follows the job', async () => {
    post.mockResolvedValue({
      response: { ok: true, status: 202 },
      data: { operationId: 'job-9', job: {} },
    });
    get.mockResolvedValue({
      response: { ok: true, status: 200 },
      data: { id: 'job-9', accountId: 'a', kind: 'verification', state: 'running' },
    });
    render(
      <ResourcesTable locale="en" rows={[res()]} canManage mfaFactorId={null} caption="cap" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Force reconciliation/ }));
    await waitFor(() =>
      expect(screen.getByText(t('en', 'm05.adm.job.state.running'))).toBeTruthy(),
    );
    const [path, init] = post.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(path).toBe('/v1/admin/resources/{id}/reconciliations');
    expect(init.headers['Idempotency-Key']).toBeTruthy();
  });
  it('the operations monitor classifies needs_reconcile and stuck rows', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const { container } = render(
      <ResourcesTable
        locale="en"
        caption="ops"
        canManage={false}
        mfaFactorId={null}
        now={now}
        rows={[
          res(),
          res({
            id: 's',
            state: 'PROVISIONING',
            createdAt: '2026-11-18T10:00:00Z',
            driftState: 'in_sync',
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain(t('en', 'm05.adm.ops.class.needs_reconcile'));
    expect(container.textContent).toContain(t('en', 'm05.adm.ops.class.stuck'));
    expect(container.textContent).toContain(t('en', 'm05.adm.ops.minutes', { count: 120 }));
  });
  it('empty state', () => {
    render(<ResourcesTable locale="ar" rows={[]} canManage mfaFactorId={null} caption="x" />);
    expect(screen.getByText(t('ar', 'm05.adm.res.empty.title'))).toBeTruthy();
  });
});

describe('provider costs (UI-M05-14)', () => {
  const cost = (o: Record<string, unknown> = {}) => ({
    id: Math.random().toString(),
    providerAccountId: 'a',
    providerKey: 'alibaba',
    resourceId: 'r',
    orgId: '0194a1b2-dddd-7222-8333-444455556666',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    meterOrSku: 'ecs.g6',
    quantity: '720',
    costMinor: '123456',
    currency: 'CNY',
    source: 'api' as const,
    providerLineRef: 'l',
    capturedAt: '2026-11-18T00:00:00Z',
    ...o,
  });
  it('shows integer minor units in the vendor currency and highlights unattributed records', () => {
    const { container } = render(
      <CostsTable locale="en" rows={[cost(), cost({ orgId: null, costMinor: '5' })]} />,
    );
    expect(container.textContent).toContain('1,234.56 CNY');
    expect(container.textContent).toContain('0.05 CNY');
    expect(badges(container).filter((b) => b.getAttribute('data-tone') === 'danger')).toHaveLength(
      1,
    );
  });
  it('totals per currency with a warning for unattributed records', () => {
    const { container } = render(
      <CostTotals
        locale="en"
        totals={[
          { currency: 'CNY', costMinor: '1000', records: 4, unattributed: 2 },
          { currency: 'USD', costMinor: '50', records: 1, unattributed: 0 },
        ]}
      />,
    );
    expect(container.textContent).toContain('10.00 CNY');
    expect(container.textContent).toContain('0.50 USD');
    expect(container.textContent).toContain(t('en', 'm05.adm.cost.unattributedWarn', { count: 2 }));
  });
  it('empty state', () => {
    render(<CostsTable locale="ar" rows={[]} />);
    expect(screen.getByText(t('ar', 'm05.adm.cost.empty.title'))).toBeTruthy();
  });
  it('RC-04: open variance is danger, a skipped comparison is marked and never "no variance" claims a match it did not make', () => {
    const run = (o: Record<string, unknown>) => ({
      id: Math.random().toString(),
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
      status: 'completed',
      itemsChecked: 3,
      breaksCount: 0,
      openBreaks: 0,
      createdAt: '2026-11-18T00:00:00Z',
      ...o,
    });
    const { container } = render(
      <Rc04Table
        locale="en"
        linkRuns
        rows={[run({ breaksCount: 2, openBreaks: 2 }), run({ summary: { skipped: true } })]}
      />,
    );
    expect(container.textContent).toContain(t('en', 'm05.adm.rc4.variance.open', { count: 2 }));
    expect(container.textContent).toContain(t('en', 'm05.adm.rc4.skipped'));
    expect(badges(container).some((b) => b.getAttribute('data-tone') === 'danger')).toBe(true);
    expect(container.querySelectorAll('a')).toHaveLength(2);
  });
  it('margin view renders money from minor units and flags a negative margin', () => {
    const { container } = render(
      <MarginPanel
        locale="en"
        r={{
          from: '2026-11-01',
          to: '2026-11-30',
          notes: [],
          totals: {},
          columns: [
            { key: 'revenueMinor', label: 'Revenue', kind: 'money' },
            { key: 'marginMinor', label: 'Margin', kind: 'money' },
          ],
          rows: [{ revenueMinor: '10000', marginMinor: '-2500', currency: 'SAR' }],
        }}
      />,
    );
    expect(container.textContent).toContain('100.00 SAR');
    expect(container.textContent).toContain('-25.00 SAR');
    expect(container.textContent).toContain(t('en', 'm05.adm.margin.negative'));
  });
});

describe('live verification (UI-M05-15): read-only, honest labels', () => {
  const job = (o: Record<string, unknown> = {}) => ({
    jobId: 'live-verify-alibaba',
    provider: 'alibaba',
    gate: 'HG-05-01',
    gateStatus: 'PENDING' as const,
    label: 'NOT RUN' as const,
    lastRunAt: null,
    ...o,
  });
  it('has no control that can start a run: no button, no form, no submit input', () => {
    const { container } = render(
      <LiveVerificationPanel
        locale="en"
        data={{ jobs: [job(), job({ jobId: 'live-verify-huawei', gate: 'HG-05-02' })], runs: [] }}
      />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('form, input, button, select')).toBeNull();
    expect(container.textContent).toContain(t('en', 'm05.adm.lv.ownerOnly'));
    expect(container.textContent).toContain('HG-05-01');
    expect(container.textContent).toContain(t('en', 'm05.adm.lv.gate.pending'));
    expect(container.textContent).toContain('NOT RUN');
    expect(container.textContent).not.toContain('LIVE-VERIFIED');
  });
  it('LIVE-VERIFIED appears only with a granted gate and recorded evidence', () => {
    const run = (o: Record<string, unknown>) => ({
      id: Math.random().toString(),
      jobId: 'live-verify-alibaba',
      status: 'LIVE-VERIFIED' as const,
      reason: 'ok',
      steps: [{ step: 'probe', status: 'pass' as const }],
      evidenceIds: ['e1'],
      gateEvidenceId: 'g1',
      spendCapMinor: '5000',
      currency: 'USD',
      residualResources: 0,
      createdAt: '2026-11-18T00:00:00Z',
      ...o,
    });
    const good = render(
      <LiveVerificationPanel
        locale="en"
        data={{ jobs: [job({ gateStatus: 'GRANTED', label: 'LIVE-VERIFIED' })], runs: [run({})] }}
      />,
    );
    expect(good.container.textContent).toContain('LIVE-VERIFIED');
    expect(good.container.textContent).toContain('50.00 USD');
    cleanup();
    const bad = render(
      <LiveVerificationPanel
        locale="en"
        data={{
          jobs: [job({ gateStatus: 'PENDING', label: 'LIVE-VERIFIED' })],
          runs: [run({ evidenceIds: [] }), run({ gateEvidenceId: null })],
        }}
      />,
    );
    expect(bad.container.textContent).not.toContain('LIVE-VERIFIED');
    // the label badges are never green (a passed step is not a verification claim)
    expect(
      badges(bad.container).filter(
        (b) => b.getAttribute('data-tone') === 'success' && /VERIFIED/.test(b.textContent ?? ''),
      ),
    ).toHaveLength(0);
    expect(bad.container.textContent).toContain(t('en', 'm05.adm.lv.downgraded'));
  });
  it('a failed run and residual resources are danger; empty states in Arabic', () => {
    const { container } = render(
      <LiveVerificationPanel
        locale="en"
        data={{
          jobs: [],
          runs: [
            {
              id: 'r',
              jobId: 'live-verify-contabo',
              status: 'FAIL',
              reason: 'boom',
              steps: [{ step: 'create', status: 'fail', detail: 'x' }],
              evidenceIds: [],
              gateEvidenceId: null,
              spendCapMinor: null,
              currency: null,
              residualResources: 2,
              createdAt: '2026-11-18T00:00:00Z',
            },
          ],
        }}
      />,
    );
    expect(
      badges(container).filter((b) => b.getAttribute('data-tone') === 'danger').length,
    ).toBeGreaterThanOrEqual(3);
    cleanup();
    render(<LiveVerificationPanel locale="ar" data={{ jobs: [], runs: [] }} />);
    expect(screen.getByText(t('ar', 'm05.adm.lv.empty.title'))).toBeTruthy();
    expect(screen.getByText(t('ar', 'm05.adm.lv.noRuns.title'))).toBeTruthy();
    expect(screen.getByText(t('ar', 'm05.adm.lv.noEvidence.title'))).toBeTruthy();
  });
});
