// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PUT: put, PATCH: patch }) }));
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask: vi.fn(), panel: null }) }));
import { ConnectorAuthorize, NewWebhookForm } from './AutomationPanels';
import { PriceRulesEditor, ProposeGrantForm } from './ProgramsPanels';
import { WorkflowEditor } from './WorkflowEditor';
import { DisabledAction } from './M11Parts';
import { dateIn, type ConnectorDto, type RuleSetDto, type WorkflowDto } from '../lib/m11';

const ok = (data: unknown = {}, status = 200) => ({ response: { ok: true, status }, data });
const fail = (status: number, error: unknown = {}) => ({ response: { ok: false, status }, error });
const button = (name: string) => screen.getByRole('button', { name });
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const L = 'en' as const;

beforeEach(() => {
  [post, put, patch, push, refresh].forEach((m) => m.mockReset());
});
afterEach(cleanup);

const rules: RuleSetDto = {
  version: 3,
  etag: '"3"',
  rules: [
    {
      scope: 'meter',
      scopeKey: 'compute.hours',
      markup: { type: 'percent', bps: 1000 },
      effectiveFrom: `${dateIn(5)}T00:00:00.000Z`,
    },
  ],
  history: [],
};

describe('price rule editor (UI-M11-17)', () => {
  it('shows the margin preview computed from the sample wholesale', () => {
    render(
      <PriceRulesEditor
        locale={L}
        resellerId="r1"
        currency="SAR"
        ruleSet={rules}
        canEdit
        mfaFactorId={null}
      />,
    );
    // 10% on 100.00 SAR: retail 110.00, margin 10.00
    expect(screen.getByTestId('preview-0').textContent).toMatch(/110\.00/);
    expect(screen.getByTestId('preview-0').textContent).toMatch(/10\.00/);
  });
  it('blocks a negative markup before anything is sent', () => {
    render(
      <PriceRulesEditor
        locale={L}
        resellerId="r1"
        currency="SAR"
        ruleSet={rules}
        canEdit
        mfaFactorId={null}
      />,
    );
    fill(t(L, 'm11.pr.value.percent'), '-5');
    expect(screen.getByText(t(L, 'm11.pr.blocked'))).toBeTruthy();
    expect(button(t(L, 'm11.pr.save', { version: 3 })).hasAttribute('disabled')).toBe(true);
    fireEvent.click(button(t(L, 'm11.pr.save', { version: 3 })));
    expect(put).not.toHaveBeenCalled();
  });
  it('saves with If-Match = the loaded version and refreshes', async () => {
    put.mockResolvedValue(ok());
    render(
      <PriceRulesEditor
        locale={L}
        resellerId="r1"
        currency="SAR"
        ruleSet={rules}
        canEdit
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t(L, 'm11.pr.save', { version: 3 })));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]!;
    expect(path).toBe('/v1/resellers/{id}/price-rules');
    expect(init.params.header['If-Match']).toBe('"3"');
    expect(init.body.rules[0]).toMatchObject({
      scope: 'meter',
      scopeKey: 'compute.hours',
      markup: { type: 'percent', bps: 1000 },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('a past effective date is refused locally (the API wants a day of notice)', () => {
    const old = {
      ...rules,
      rules: [{ ...rules.rules[0]!, effectiveFrom: '2020-01-01T00:00:00.000Z' }],
    };
    render(
      <PriceRulesEditor
        locale={L}
        resellerId="r1"
        currency="SAR"
        ruleSet={old}
        canEdit
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t(L, 'm11.pr.save', { version: 3 })));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getAllByText(t(L, 'm11.pr.errDate')).length).toBeGreaterThan(0);
  });
  it('a stale version (412) is reported as such', async () => {
    put.mockResolvedValue(fail(412, { code: 'etag_mismatch' }));
    render(
      <PriceRulesEditor
        locale={L}
        resellerId="r1"
        currency="SAR"
        ruleSet={rules}
        canEdit
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t(L, 'm11.pr.save', { version: 3 })));
    expect(await screen.findByText(t(L, 'm11.err.stale'))).toBeTruthy();
  });
});

describe('grant proposal (UI-M11-12)', () => {
  it('defaults the expiry to 90 days and refuses a proposal without a scope', () => {
    render(<ProposeGrantForm locale={L} agencyId="a1" clientOrgId="c1" mfaFactorId={null} />);
    expect((screen.getByLabelText(t(L, 'm11.gr.expiry')) as HTMLInputElement).value).toBe(
      dateIn(90),
    );
    fireEvent.click(button(t(L, 'm11.gr.proposeAction')));
    expect(screen.getByText(t(L, 'm11.gr.errScopes'))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('refuses a missing or too-far expiry', () => {
    render(<ProposeGrantForm locale={L} agencyId="a1" clientOrgId="c1" mfaFactorId={null} />);
    fireEvent.click(screen.getByLabelText('automation:read'));
    fill(t(L, 'm11.gr.expiry'), '');
    fireEvent.click(button(t(L, 'm11.gr.proposeAction')));
    expect(screen.getByText(t(L, 'm11.gr.errExpiry.missing'))).toBeTruthy();
    fill(t(L, 'm11.gr.expiry'), dateIn(400));
    fireEvent.click(button(t(L, 'm11.gr.proposeAction')));
    expect(screen.getByText(t(L, 'm11.gr.errExpiry.too_far', { max: 365 }))).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it('only offers delegable scopes (never billing or members) and sends scopes plus expiry', async () => {
    post.mockResolvedValue(ok({}, 201));
    render(<ProposeGrantForm locale={L} agencyId="a1" clientOrgId="c1" mfaFactorId={null} />);
    expect(screen.queryByLabelText('billing:read')).toBeNull();
    expect(screen.queryByLabelText('member:read')).toBeNull();
    fireEvent.click(screen.getByLabelText('automation:read'));
    fireEvent.click(screen.getByLabelText('automation:run'));
    fireEvent.click(button(t(L, 'm11.gr.proposeAction')));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const init = post.mock.calls[0]![1];
    expect(init.body.scopes).toEqual(['automation:read', 'automation:run']);
    expect(init.body.expiresAt).toBe(`${dateIn(90)}T23:59:59.000Z`);
    expect(init.body.clientOrgId).toBe('c1');
  });
});

describe('workflow editor (UI-M11-02)', () => {
  const wf: WorkflowDto = {
    id: '018f0000-0000-7000-8000-000000000001',
    name: 'Nightly',
    status: 'draft',
    activeVersionId: 'v1',
    activeVersion: 1,
    triggers: [{ type: 'manual' }],
    lastRunAt: null,
    nextRunAt: null,
    pausedReason: null,
    pausedByAdmin: false,
    sourceListingVersionId: null,
    definition: {
      schemaVersion: 1,
      start: 'a',
      steps: [{ id: 'a', type: 'delay', name: 'Wait', params: { seconds: 5 } }],
    },
    versions: [],
    etag: 1,
    createdAt: '2027-01-01T00:00:00Z',
  };
  it('draws the steps as cards and shows the 422 errors of a refused publish inline', async () => {
    post.mockResolvedValue(
      fail(422, {
        code: 'validation_failed',
        errors: [{ code: 'cycle', path: '$.steps.a', message: 'the graph has a cycle' }],
      }),
    );
    render(<WorkflowEditor locale={L} mode="edit" workflow={wf} canWrite mfaFactorId={null} />);
    expect(screen.getByRole('button', { name: /Wait/ })).toBeTruthy();
    fireEvent.click(button(t(L, 'm11.wf.publish.action')));
    expect(await screen.findByText('the graph has a cycle')).toBeTruthy();
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/workflows/{id}/versions');
    expect(init.params.header['Idempotency-Key']).toBeTruthy();
    expect(init.body.definition.start).toBe('a');
  });
  it('sends the acting header when an agency acts for a client', async () => {
    post.mockResolvedValue(ok({ version: 2, unchanged: false }, 201));
    render(
      <WorkflowEditor
        locale={L}
        mode="edit"
        workflow={wf}
        actingOrgId="client-1"
        canWrite
        mfaFactorId={null}
      />,
    );
    fireEvent.click(button(t(L, 'm11.wf.publish.action')));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1].params.header['X-Nuzm-Acting-Org']).toBe('client-1');
    expect(await screen.findByText(t(L, 'm11.wf.publish.done', { version: 2 }))).toBeTruthy();
  });
  it('shows a broken JSON definition as a hint and does not publish it', () => {
    render(<WorkflowEditor locale={L} mode="edit" workflow={wf} canWrite mfaFactorId={null} />);
    fireEvent.click(button(t(L, 'm11.wf.view.json')));
    fireEvent.change(screen.getByLabelText(t(L, 'm11.wf.json.label')), {
      target: { value: '{ not json' },
    });
    expect(button(t(L, 'm11.wf.publish.action')).hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/Not valid JSON|JSON/).length).toBeGreaterThan(0);
  });
  it('shows the webhook trigger secret once after creation and then removes it', async () => {
    post.mockResolvedValue(
      ok(
        { ...wf, webhook: { path: '/v1/webhooks/workflows/tok', secret: 'SECRET-VALUE-1234' } },
        201,
      ),
    );
    render(<WorkflowEditor locale={L} mode="create" canWrite mfaFactorId={null} />);
    fill(t(L, 'field.name'), 'Hooked');
    fireEvent.click(screen.getByLabelText(t(L, 'm11.wf.trigger.webhook')));
    fireEvent.click(button(t(L, 'm11.wf.new.publish')));
    expect((await screen.findByTestId('secret-value')).textContent).toBe('SECRET-VALUE-1234');
    expect(post.mock.calls[0]![1].body.triggers).toEqual([{ type: 'manual' }, { type: 'webhook' }]);
    fireEvent.click(button(t(L, 'm11.secret.stored')));
    expect(screen.queryByText('SECRET-VALUE-1234')).toBeNull();
    expect(push).toHaveBeenCalledWith(`/en/automation/workflows/${wf.id}/edit`);
  });
  it('is read-only without the write permission', () => {
    render(
      <WorkflowEditor locale={L} mode="edit" workflow={wf} canWrite={false} mfaFactorId={null} />,
    );
    expect(screen.queryByRole('button', { name: t(L, 'm11.wf.publish.action') })).toBeNull();
    expect(screen.getByText(t(L, 'm11.wf.readOnly'))).toBeTruthy();
  });
});

describe('connectors and webhooks', () => {
  const conn: ConnectorDto = {
    id: 'c1',
    type: 'http',
    name: 'Billing API',
    scopes: ['x:read'],
    rateLimit: { perMinute: 60, burst: 10 },
    config: {},
    status: 'pending',
    authorization: null,
    dataRegion: 'sa',
    etag: 1,
    createdAt: '2027-01-01T00:00:00Z',
  };
  it('refuses to send a raw secret: only a vault reference of this organization is accepted', () => {
    render(<ConnectorAuthorize locale={L} connector={conn} orgId="org-1" mfaFactorId={null} />);
    fireEvent.click(button(t(L, 'm11.cn.authorize')));
    fill(t(L, 'm11.cn.vaultRef'), 'sk_live_abcdefghijklmnop');
    fireEvent.click(button(t(L, 'm11.cn.authorizeAction')));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(t(L, 'm11.cn.errVaultRef', { org: 'org-1' }))).toBeTruthy();
  });
  it('sends a vault reference of the organization', async () => {
    post.mockResolvedValue(ok({}, 201));
    render(<ConnectorAuthorize locale={L} connector={conn} orgId="org-1" mfaFactorId={null} />);
    fireEvent.click(button(t(L, 'm11.cn.authorize')));
    fill(t(L, 'm11.cn.vaultRef'), 'vault://kv/tenant-org-1-billing');
    fireEvent.click(button(t(L, 'm11.cn.authorizeAction')));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1].body).toEqual({
      kind: 'credential',
      vaultRef: 'vault://kv/tenant-org-1-billing',
    });
  });
  it('shows a new webhook secret once', async () => {
    post.mockResolvedValue(
      ok(
        {
          id: 'w',
          url: 'https://hooks.example/in',
          events: ['invoice.issued'],
          secret: 'whsec_abc123',
        },
        201,
      ),
    );
    render(<NewWebhookForm locale={L} mfaFactorId={null} />);
    fill(t(L, 'm11.wh.url'), 'https://hooks.example/in');
    fireEvent.click(button(t(L, 'action.create')));
    expect((await screen.findByTestId('secret-value')).textContent).toBe('whsec_abc123');
    fireEvent.click(button(t(L, 'm11.secret.stored')));
    expect(screen.queryByText('whsec_abc123')).toBeNull();
  });
  it('a refused (private) address is explained', async () => {
    post.mockResolvedValue(fail(422, { code: 'ssrf_denied' }));
    render(<NewWebhookForm locale={L} mfaFactorId={null} />);
    fill(t(L, 'm11.wh.url'), 'https://10.0.0.1/hook');
    fireEvent.click(button(t(L, 'action.create')));
    expect(await screen.findByText(t(L, 'm11.err.ssrf'))).toBeTruthy();
  });
});

describe('disabled actions', () => {
  it('are visible, disabled and explain why', () => {
    render(<DisabledAction id="x" label="Revoke" reason="SCR-M11-01 pending" />);
    const b = screen.getByRole('button', { name: 'Revoke' });
    expect(b.hasAttribute('disabled')).toBe(true);
    expect(b.getAttribute('aria-describedby')).toBe('x');
    expect(screen.getByText('SCR-M11-01 pending')).toBeTruthy();
  });
});
