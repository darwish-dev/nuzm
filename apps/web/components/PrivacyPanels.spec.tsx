// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PUT: put, DELETE: del }) }));
vi.mock('./StepUp', () => ({ useStepUp: () => ({ ask: vi.fn(), panel: null }) }));
import {
  ExportRequestButton,
  NewRequestForm,
  ResidencyForm,
  WithdrawButton,
} from './PrivacyPanels';
import { PrivacyTabs } from './PrivacyTabs';

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 200 }, data });
const fail = (status: number, error: unknown = {}) => ({ response: { ok: false, status }, error });
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => [post, put, del, push].forEach((m) => m.mockReset()));
afterEach(cleanup);

describe('tabs', () => {
  it('list only what the caller may open', () => {
    const can = (p: string) => p === 'privacy:dsr:self';
    render(<PrivacyTabs locale="en" current="requests" can={can} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      t('en', 'pv.tab.requests'),
    ]);
  });
});

describe('consent withdrawal (UI-M04-01)', () => {
  it('withdraws and says so', async () => {
    del.mockResolvedValue({ response: { ok: true, status: 204 } });
    render(<WithdrawButton locale="en" id="c-1" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.consents.withdraw') }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('/v1/compliance/consents/{id}', {
        params: { path: { id: 'c-1' } },
      }),
    );
    expect(await screen.findByText(t('en', 'pv.consents.withdrawn'))).toBeTruthy();
  });
});

describe('new request (UI-M04-03)', () => {
  it('a member asks about themselves: type and details only, with an Idempotency-Key, then goes to the request', async () => {
    post.mockResolvedValue(ok({ id: 'r-1' }));
    render(<NewRequestForm locale="en" canManage={false} />);
    expect(screen.queryByLabelText(t('en', 'pv.req.subject'))).toBeNull(); // only administrators can ask about someone else
    type(t('en', 'pv.req.type'), 'portability');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.req.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/compliance/data-subject-requests');
    expect(init.body).toEqual({ type: 'portability' });
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/privacy/requests/r-1'));
  });
  it('an administrator asking about someone else must write down the identity check before anything is sent', () => {
    render(<NewRequestForm locale="en" canManage />);
    type(t('en', 'pv.req.subject'), 'enduser-9');
    type(t('en', 'pv.req.attest'), 'short');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.req.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'pv.req.identity'));
    expect(post).not.toHaveBeenCalled();
  });
  it('explains a refusal from the API in plain words', async () => {
    post.mockResolvedValue(fail(422, { code: 'dsr_identity_unverified' }));
    render(<NewRequestForm locale="ar" canManage />);
    fireEvent.click(screen.getByRole('button', { name: t('ar', 'pv.req.submit') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('ar', 'pv.req.identity'));
  });
});

describe('export (UI-M04-06)', () => {
  it('tells the person when this environment has no export store', async () => {
    post.mockResolvedValue(fail(422, { code: 'no_export_sink', detail: 'no_export_sink' }));
    render(<ExportRequestButton locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.exp.request') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'pv.exp.noSink'));
  });
  it('and when five exports are already running', async () => {
    post.mockResolvedValue(fail(422, { code: 'quota_exceeded' }));
    render(<ExportRequestButton locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.exp.request') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'pv.exp.quota'));
  });
  it('requests an organization export', async () => {
    post.mockResolvedValue(ok({ id: 'e-1' }));
    render(<ExportRequestButton locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.exp.request') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ scope: 'org' });
    expect(await screen.findByText(t('en', 'pv.exp.requested'))).toBeTruthy();
  });
});

describe('residency policy (UI-M04-05)', () => {
  const base = {
    locale: 'en' as const,
    version: 2,
    mode: 'allow_listed' as const,
    countries: { personal: ['AE'] },
    floorClasses: ['credentials'],
    canEdit: true,
  };
  it('sends the version it showed as If-Match and the parsed countries', async () => {
    put.mockResolvedValue(ok({}));
    render(<ResidencyForm {...base} />);
    type(t('en', 'pv.res.countries'), 'personal=AE,BH');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.res.save') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]!;
    expect(path).toBe('/v1/compliance/residency-policy');
    expect(init.params.header).toEqual({ 'If-Match': '"2"' });
    expect(init.body).toEqual({
      mode: 'allow_listed',
      allowedCountriesByClass: { personal: ['AE', 'BH'] },
    });
    expect(await screen.findByText(t('en', 'pv.res.saved'))).toBeTruthy();
  });
  it('the first policy needs no If-Match; malformed countries never leave the screen', async () => {
    put.mockResolvedValue(ok({}));
    const { unmount } = render(
      <ResidencyForm {...base} version={0} mode="in_kingdom_only" countries={{}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.res.save') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![1].params).toEqual({});
    expect(put.mock.calls[0]![1].body).toEqual({
      mode: 'in_kingdom_only',
      allowedCountriesByClass: {},
    });
    unmount();
    put.mockReset();
    render(<ResidencyForm {...base} />);
    type(t('en', 'pv.res.countries'), 'personal=uae');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.res.save') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'err.validation'));
    expect(put).not.toHaveBeenCalled();
  });
  it('says so when the policy is below the floor, and when it changed meanwhile', async () => {
    put.mockResolvedValueOnce(fail(422, { code: 'policy_below_floor' }));
    render(<ResidencyForm {...base} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.res.save') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('en', 'pv.res.below'));
    put.mockResolvedValueOnce(fail(412, { code: 'precondition_failed' }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pv.res.save') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t('en', 'pv.res.stale')),
    );
  });
  it('is read-only for a member who cannot manage it', () => {
    render(<ResidencyForm {...base} canEdit={false} />);
    expect(screen.queryByRole('button', { name: t('en', 'pv.res.save') })).toBeNull();
    expect(screen.getByText(t('en', 'pv.res.readOnly'))).toBeTruthy();
    expect((screen.getByLabelText(t('en', 'pv.res.mode')) as HTMLSelectElement).disabled).toBe(
      true,
    );
  });
});
