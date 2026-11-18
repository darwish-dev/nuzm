// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PUT: put }) }));
import { AiBudgetsForm } from './AiBudgetsForm';
import { AiTabs } from './AiTabs';
import { TopUpCard } from './AiUsagePanels';

beforeEach(() => {
  post.mockReset();
  put.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

const ok = (data: unknown = {}) => ({ response: { ok: true, status: 200 }, data });
const fail = (status: number, code?: string) => ({
  response: { ok: false, status },
  error: code ? { code } : undefined,
});
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('tabs', () => {
  it('marks the current section and names the navigation', () => {
    render(<AiTabs locale="en" current="budgets" />);
    expect(screen.getByRole('navigation', { name: t('en', 'aiu.nav') })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('en', 'aiu.tab.budgets') }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('link', { name: t('en', 'aiu.tab.usage') }).getAttribute('aria-current'),
    ).toBeNull();
  });
});

describe('top-up card (UI-M09-10): a quote request, never a purchase', () => {
  const quote = {
    id: 'q1',
    expiresAt: '2030-01-01T00:15:00Z',
    currency: 'SAR',
    subtotalMinor: '1000',
    totalMinor: '1150',
    taxEstimate: { taxMinor: '150' },
    requiresApproval: false,
  };
  it('always says a purchase cannot be completed yet', () => {
    render(<TopUpCard locale="en" canRequest={true} />);
    expect(screen.getByText(t('en', 'aiu.topup.unavailable'))).toBeTruthy();
  });
  it('members without the quote permission get the explanation and no form', () => {
    const { container } = render(<TopUpCard locale="ar" canRequest={false} />);
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getByText(t('ar', 'aiu.topup.noPermission'))).toBeTruthy();
  });
  it('rejects a non-integer amount without calling the API', () => {
    render(<TopUpCard locale="en" canRequest={true} />);
    change(t('en', 'aiu.topup.credits'), '1.5');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aiu.topup.quote') }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(t('en', 'aiu.topup.invalid'))).toBeTruthy();
  });
  it('requests an ai-credit quote with an Idempotency-Key and shows it, with the not-charged notice', async () => {
    post.mockResolvedValue(ok(quote));
    render(<TopUpCard locale="en" canRequest={true} />);
    change(t('en', 'aiu.topup.credits'), '1000');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aiu.topup.quote') }));
    await waitFor(() => expect(screen.getByText('11.50 SAR')).toBeTruthy());
    const [path, init] = post.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: unknown },
    ];
    expect(path).toBe('/v1/quotes');
    expect(init.body).toEqual({ kind: 'ai-credit', items: [{ credits: '1000' }] });
    expect(init.params.header['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText(t('en', 'aiu.topup.notCharged'))).toBeTruthy();
    // no order or purchase call was made
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('a refused quote shows an error and no quote', async () => {
    post.mockResolvedValue(fail(422, 'quota_exceeded'));
    render(<TopUpCard locale="en" canRequest={true} />);
    change(t('en', 'aiu.topup.credits'), '5');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aiu.topup.quote') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refused'));
    expect(screen.queryByText(t('en', 'aiu.topup.quoteTitle'))).toBeNull();
  });
});

describe('budgets form (UI-M09-11)', () => {
  const org = {
    dailyCredits: 100,
    runMaxCredits: null,
    runMaxTokens: null,
    totalCredits: null,
    totalTokens: null,
    alertThresholds: [50, 80, 100],
    logBodies: false,
    bodyRetentionDays: null,
    autoApplyLowRisk: false,
  };
  const base = {
    locale: 'en' as const,
    org,
    projects: [],
    version: 3,
    projectOptions: [{ id: '0194a1b2-1111-7222-8333-444455556666', name: 'Shop' }],
    canWrite: true,
    canAutoApply: true,
  };
  it('read-only members see the values and no save button', () => {
    render(<AiBudgetsForm {...base} canWrite={false} />);
    expect(screen.getByText(t('en', 'aiu.budgets.readOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('en', 'action.save') })).toBeNull();
    expect(
      (screen.getByLabelText(t('en', 'aiu.budgets.dailyCredits')) as HTMLInputElement).disabled,
    ).toBe(true);
  });
  it('saves with the budget version as a quoted If-Match', async () => {
    put.mockResolvedValue(ok({}));
    render(<AiBudgetsForm {...base} />);
    change(t('en', 'aiu.budgets.dailyCredits'), '250');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, init] = put.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: { org: { dailyCredits: number } } },
    ];
    expect(path).toBe('/v1/ai/budgets');
    expect(init.params.header['If-Match']).toBe('"3"');
    expect(init.body.org.dailyCredits).toBe(250);
    await waitFor(() => expect(screen.getByText(t('en', 'aiu.budgets.saved'))).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });
  it('a stale version (412) shows the reload banner and reloads on request', async () => {
    put.mockResolvedValue(fail(412, 'etag_mismatch'));
    render(<AiBudgetsForm {...base} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    const reload = await screen.findByRole('button', { name: t('en', 'aiu.budgets.reload') });
    fireEvent.click(reload);
    expect(refresh).toHaveBeenCalled();
  });
  it('prompt logging needs a retention period: nothing is sent without it', () => {
    render(<AiBudgetsForm {...base} />);
    fireEvent.click(screen.getByLabelText(t('en', 'aiu.budgets.logToggle')));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'aiu.budgets.err.retention'));
  });
  it('bodies are off by default and the retention field is disabled until logging is on', () => {
    render(<AiBudgetsForm {...base} />);
    expect(
      (screen.getByLabelText(t('en', 'aiu.budgets.logToggle')) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByLabelText(t('en', 'aiu.budgets.retention')) as HTMLInputElement).disabled,
    ).toBe(true);
  });
  it('auto-apply cannot be switched on without the AI write permission, and says who can', () => {
    render(<AiBudgetsForm {...base} canAutoApply={false} />);
    const box = screen.getByLabelText(t('en', 'aiu.budgets.autoToggle')) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(t('en', 'aiu.budgets.autoRoles'))).toBeTruthy();
  });
  it('a 403 on save names the auto-apply rule', async () => {
    put.mockResolvedValue(fail(403, 'forbidden'));
    render(<AiBudgetsForm {...base} />);
    fireEvent.click(screen.getByLabelText(t('en', 'aiu.budgets.autoToggle')));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    await waitFor(() => expect(screen.getByText(t('en', 'aiu.budgets.forbidden'))).toBeTruthy());
  });
  it('a new budget version from the server replaces the form values and keeps the saved notice', async () => {
    put.mockResolvedValue(ok({}));
    const { rerender } = render(<AiBudgetsForm {...base} />);
    change(t('en', 'aiu.budgets.dailyCredits'), '250');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    await waitFor(() => expect(screen.getByText(t('en', 'aiu.budgets.saved'))).toBeTruthy());
    rerender(<AiBudgetsForm {...base} version={4} org={{ ...org, dailyCredits: 500 }} />);
    expect(
      (screen.getByLabelText(t('en', 'aiu.budgets.dailyCredits')) as HTMLInputElement).value,
    ).toBe('500');
    expect(screen.getByText(t('en', 'aiu.budgets.saved'))).toBeTruthy();
  });
  it('adds a project cap row from the projects that have none', async () => {
    put.mockResolvedValue(ok({}));
    render(<AiBudgetsForm {...base} />);
    change(t('en', 'aiu.budgets.addProject'), '0194a1b2-1111-7222-8333-444455556666');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'aiu.budgets.addCap') }));
    fireEvent.change(
      screen.getByLabelText(t('en', 'aiu.budgets.totalCredits'), { selector: '#aiu-pc-0' }),
      {
        target: { value: '40' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'action.save') }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = (put.mock.calls[0] as [string, { body: { projects: unknown[] } }])[1].body;
    expect(body.projects).toEqual([
      { projectId: '0194a1b2-1111-7222-8333-444455556666', totalCredits: 40, totalTokens: null },
    ]);
  });
});
