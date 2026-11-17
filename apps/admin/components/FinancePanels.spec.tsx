// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const patch = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PATCH: patch }) }));
import {
  BreakActions,
  DecideStep,
  DunningAction,
  RefundForm,
  RunReconciliationsForm,
} from './FinancePanels';

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 201 }, data });
const PAYMENT = '0194a1b2-1111-7222-8333-444455556666';

beforeEach(() => {
  post.mockReset();
  patch.mockReset();
});
afterEach(cleanup);

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('refund form (UI-M03-15)', () => {
  it('refuses a bad payment id or amount on the screen without calling the API', () => {
    render(<RefundForm locale="en" mfaFactorId={null} />);
    type(t('en', 'af.ref.payment'), 'not-an-id');
    type(t('en', 'af.ref.amount'), '1.234');
    type(t('en', 'field.reason'), 'duplicate charge');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.ref.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'af.ref.invalid'));
    expect(post).not.toHaveBeenCalled();
  });

  it('sends integer minor units with an Idempotency-Key and shows the pending result', async () => {
    post.mockResolvedValue(
      ok({
        id: 'r-1',
        paymentId: PAYMENT,
        amountMinor: '11500',
        currency: 'SAR',
        status: 'pending',
        failureCode: null,
      }),
    );
    render(<RefundForm locale="en" mfaFactorId={null} />);
    type(t('en', 'af.ref.payment'), PAYMENT);
    type(t('en', 'af.ref.amount'), '115');
    type(t('en', 'field.reason'), 'duplicate charge');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.ref.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]!;
    expect(path).toBe('/v1/admin/billing/refunds');
    expect(init.body).toEqual({ paymentId: PAYMENT, amount: '11500', reason: 'duplicate charge' });
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(t('en', 'af.ref.pending'))).toBeTruthy();
    expect(screen.getByText(t('en', 'af.ref.status.pending'))).toBeTruthy();
  });
});

describe('run reconciliations (UI-M03-16)', () => {
  it('needs at least one type and a valid period', () => {
    render(
      <RunReconciliationsForm
        locale="en"
        mfaFactorId={null}
        defaultFrom="2026-11-01"
        defaultTo="2026-11-17"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.rc.run.submit') }));
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'af.rc.run.invalid'));
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the chosen types and period', async () => {
    post.mockResolvedValue(ok({ runs: [{}, {}] }));
    render(
      <RunReconciliationsForm
        locale="en"
        mfaFactorId={null}
        defaultFrom="2026-11-01"
        defaultTo="2026-11-17"
      />,
    );
    fireEvent.click(screen.getByLabelText(/RC-01/));
    fireEvent.click(screen.getByLabelText(/RC-05/));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.rc.run.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      types: ['RC-01', 'RC-05'],
      periodFrom: '2026-11-01',
      periodTo: '2026-11-17',
    });
    expect(await screen.findByText(t('en', 'af.rc.run.queued', { count: 2 }))).toBeTruthy();
  });
});

describe('break actions (UI-M03-17)', () => {
  const base = { locale: 'en' as const, runId: 'run', itemId: 'item', mfaFactorId: null };
  it('shows nothing to read-only staff or for a resolved break', () => {
    const a = render(<BreakActions {...base} status="open" canManage={false} />);
    expect(a.container.innerHTML).toBe('');
    const b = render(<BreakActions {...base} status="resolved" canManage={true} />);
    expect(b.container.innerHTML).toBe('');
  });
  it('accepting a variance needs a note', () => {
    render(<BreakActions {...base} status="assigned" canManage={true} />);
    expect(screen.queryByRole('button', { name: t('en', 'af.rc.act.assign') })).toBeNull(); // already taken
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.rc.act.accept') }));
    const form = screen.getByLabelText(t('en', 'af.rc.f.note')).closest('form')!;
    fireEvent.submit(form);
    expect(post).not.toHaveBeenCalled();
  });
  it('assigns with one click', async () => {
    post.mockResolvedValue(ok());
    render(<BreakActions {...base} status="open" canManage={true} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.rc.act.assign') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ itemId: 'item', action: 'assign' });
  });
});

describe('e-invoicing step decision (UI-M03-18)', () => {
  it('asks for the one-time password only on the compliance certificate step, and never stores it in the page', () => {
    const a = render(
      <DecideStep locale="en" stepId="s1" step="compliance_csid" mfaFactorId={null} />,
    );
    const otp = screen.getByLabelText(t('en', 'af.z.otp')) as HTMLInputElement;
    expect(otp.getAttribute('autocomplete')).toBe('off');
    a.unmount();
    render(<DecideStep locale="en" stepId="s2" step="csr" mfaFactorId={null} />);
    expect(screen.queryByLabelText(t('en', 'af.z.otp'))).toBeNull();
  });
  it('sends the decision with the OTP once and clears it', async () => {
    post.mockResolvedValue(ok());
    render(<DecideStep locale="en" stepId="s1" step="compliance_csid" mfaFactorId={null} />);
    const otp = screen.getByLabelText(t('en', 'af.z.otp')) as HTMLInputElement;
    fireEvent.change(otp, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.z.approve') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      stepId: 's1',
      decision: 'approve',
      otp: '123456',
    });
    await waitFor(() => expect(otp.value).toBe(''));
  });
  it('a rejection never carries the OTP', async () => {
    post.mockResolvedValue(ok());
    render(<DecideStep locale="en" stepId="s1" step="compliance_csid" mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'af.z.otp')), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.z.reject') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({ stepId: 's1', decision: 'reject' });
  });
});

describe('dunning hold and resume (UI-M03-20)', () => {
  it('needs a reason, then holds', async () => {
    patch.mockResolvedValue(ok());
    render(<DunningAction locale="en" id="c1" hold={false} mfaFactorId={null} />);
    fireEvent.submit(screen.getByLabelText(t('en', 'af.dn.f.reason')).closest('form')!);
    expect(patch).not.toHaveBeenCalled();
    type(t('en', 'af.dn.f.reason'), 'customer promised payment on Sunday');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'af.dn.act.hold') }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![1].body).toEqual({
      action: 'hold',
      reason: 'customer promised payment on Sunday',
    });
  });
  it('a held case offers resume', () => {
    render(<DunningAction locale="ar" id="c1" hold={true} mfaFactorId={null} />);
    expect(screen.getByRole('button', { name: t('ar', 'af.dn.act.resume') })).toBeTruthy();
  });
});
