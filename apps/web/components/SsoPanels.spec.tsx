// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask: vi.fn(), panel: null }) }));
import { CopyValue, SsoConnectionControls, SsoCreateForm } from './SsoPanels';

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 201 }, data });
const ORG = '0194a1b2-1111-7222-8333-444455556666';
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => post.mockReset());
afterEach(cleanup);

describe('SSO create form (UI-M12-01)', () => {
  it('sends a SAML connection with an Idempotency-Key and the org in the path', async () => {
    post.mockResolvedValue(ok({ id: 'c-1' }));
    render(<SsoCreateForm locale="en" orgId={ORG} mfaFactorId={null} />);
    type(t('en', 'm12.sso.create.name'), 'Corporate IdP');
    type(t('en', 'm12.sso.create.domains'), 'example.com');
    type(t('en', 'm12.sso.create.metadataUrl'), 'https://idp.example.com/metadata');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.sso.create.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/organizations/{orgId}/sso-connections');
    expect(init.params.path.orgId).toBe(ORG);
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toMatchObject({ protocol: 'saml', domains: ['example.com'] });
    expect(await screen.findByText(t('en', 'm12.sso.created'))).toBeTruthy();
  });
  it('refuses a secret value for OIDC without calling the API', () => {
    render(<SsoCreateForm locale="en" orgId={ORG} mfaFactorId={null} />);
    type(t('en', 'm12.sso.create.name'), 'OIDC');
    type(t('en', 'm12.sso.protocol'), 'oidc');
    type(t('en', 'm12.sso.create.domains'), 'example.com');
    type(t('en', 'm12.sso.create.issuer'), 'https://login.example.com');
    type(t('en', 'm12.sso.create.clientId'), 'nuzm');
    type(t('en', 'm12.sso.create.secretRef'), 'plain-secret-value');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.sso.create.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'm12.sso.err.invalid'));
    expect(post).not.toHaveBeenCalled();
  });
  it('explains a claimed domain', async () => {
    post.mockResolvedValue({
      response: { ok: false, status: 409 },
      error: { code: 'domain_claimed' },
    });
    render(<SsoCreateForm locale="en" orgId={ORG} mfaFactorId={null} />);
    type(t('en', 'm12.sso.create.name'), 'Corporate IdP');
    type(t('en', 'm12.sso.create.domains'), 'example.com');
    type(t('en', 'm12.sso.create.metadataUrl'), 'https://idp.example.com/metadata');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.sso.create.submit') }));
    expect(await screen.findByText(t('en', 'm12.sso.err.domainClaimed'))).toBeTruthy();
  });
});

describe('connection controls', () => {
  const props = {
    locale: 'en' as const,
    orgId: ORG,
    mfaFactorId: null,
    connectionId: 'c-1',
    jit: { enabled: false, defaultRole: 'viewer' },
  };
  it('the test login is disabled and says why; enforcement is unavailable without a successful test login', () => {
    render(<SsoConnectionControls {...props} enforce={false} canEnforce={false} />);
    expect(
      (screen.getByRole('button', { name: t('en', 'm12.sso.test.button') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(t('en', 'm12.sso.test.unavailable'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('en', 'm12.sso.enforce.enable') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(t('en', 'm12.sso.enforce.unavailable'))).toBeTruthy();
  });
  it('enforcement is offered once a test login has succeeded, and can always be turned off', async () => {
    post.mockResolvedValue(ok());
    const { unmount } = render(<SsoConnectionControls {...props} enforce={false} canEnforce />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.sso.enforce.enable') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ connectionId: 'c-1', enforce: true });
    unmount();
    post.mockClear();
    render(<SsoConnectionControls {...props} enforce canEnforce={false} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'm12.sso.enforce.disable') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ connectionId: 'c-1', enforce: false });
  });
  it('JIT offers only non-administrative roles', () => {
    render(<SsoConnectionControls {...props} enforce={false} canEnforce={false} />);
    const select = screen.getByLabelText(t('en', 'm12.sso.jit.role')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      'viewer',
      'developer',
      'billing_admin',
    ]);
  });
});

describe('copy value', () => {
  it('shows the value read-only and left-to-right, with a labelled copy button', () => {
    render(<CopyValue locale="ar" id="x" label="اسم السجل" value="_nuzm-sso.example.com" />);
    const input = screen.getByLabelText('اسم السجل') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.dir).toBe('ltr');
    expect(
      screen.getByRole('button', { name: t('ar', 'm12.sso.copyLabel', { label: 'اسم السجل' }) }),
    ).toBeTruthy();
  });
});
