// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const put = vi.fn();
const post = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ PUT: put, POST: post }) }));
import { DynadotSettings } from './DynadotSettings';

beforeEach(() => {
  put.mockReset();
  post.mockReset();
});
afterEach(cleanup);

const account = {
  id: '0190a000-0000-7000-8000-000000000001',
  label: 'Dynadot',
  environment: 'sandbox' as const,
  dataRegion: 'US',
  currency: 'USD',
  settings: {},
  credentialStored: true,
  enabled: false,
};
const view = (over: Partial<Parameters<typeof DynadotSettings>[0]> = {}) =>
  render(<DynadotSettings locale="en" account={null} canManage mfaFactorId={null} {...over} />);

describe('Dynadot settings form', () => {
  it('saves the settings, then empties the write-only fields', async () => {
    put.mockResolvedValue({ response: { ok: true, status: 200 }, data: {} });
    view();
    const key = screen.getByLabelText(t('en', 'dom.dnet.f.key')) as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'dynadot-test-key-123456' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dom.dnet.save') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe('/v1/admin/registrars/dynadot');
    expect(put.mock.calls[0]![1].body).toMatchObject({
      environment: 'sandbox',
      searchBatch: 1,
      credentials: { apiKey: 'dynadot-test-key-123456' },
    });
    await waitFor(() => expect(key.value).toBe(''));
  });

  it('cannot test or enable before an account exists', () => {
    view();
    expect(
      (screen.getByRole('button', { name: t('en', 'dom.dynadot.verify') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('tests and enables the saved account through the verification endpoint', async () => {
    post.mockResolvedValue({ response: { ok: true, status: 200 }, data: {} });
    view({ account });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dom.dynadot.verifyEnable') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/v1/admin/registrars/{id}/verification');
    expect(post.mock.calls[0]![1].body).toEqual({ enable: true });
    expect(post.mock.calls[0]![1].params.path.id).toBe(account.id);
    await waitFor(() => expect(screen.getByText(t('en', 'dom.dynadot.enabled'))).toBeTruthy());
  });

  it('does not call the server when the form is wrong', () => {
    view();
    fireEvent.change(screen.getByLabelText(t('en', 'dom.dynadot.f.currency')), {
      target: { value: 'XX' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dom.dnet.save') }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'dom.dynadot.err.currency'));
  });
});
