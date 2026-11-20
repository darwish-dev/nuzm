// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const put = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ PUT: put }) }));
import { DnetSettings } from './DnetSettings';

beforeEach(() => put.mockReset());
afterEach(cleanup);

const view = (over: Partial<Parameters<typeof DnetSettings>[0]> = {}) =>
  render(<DnetSettings locale="en" account={null} canManage mfaFactorId={null} {...over} />);

describe('DNet settings form', () => {
  it('says plainly that nothing is connected, and offers no connection test', () => {
    view();
    expect(screen.getByText(t('en', 'dom.dnet.notConnected'))).toBeTruthy();
    expect(screen.getByText(t('en', 'dom.dnet.blocked'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /test/i })).toBeNull();
  });

  it('saves the settings, then empties the write-only fields', async () => {
    put.mockResolvedValue({ response: { ok: true, status: 200 }, data: {} });
    view();
    fireEvent.change(screen.getByLabelText(t('en', 'dom.dnet.f.url')), {
      target: { value: 'https://api.example.test' },
    });
    const key = screen.getByLabelText(t('en', 'dom.dnet.f.key')) as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'dnet-test-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dom.dnet.save') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe('/v1/admin/registrars/dnet');
    expect(put.mock.calls[0]![1].body).toMatchObject({
      environment: 'sandbox',
      baseUrl: 'https://api.example.test',
      credentials: { apiKey: 'dnet-test-key-1234567890' },
    });
    await waitFor(() => expect(key.value).toBe(''));
    expect(screen.getByText(t('en', 'dom.dnet.saved'))).toBeTruthy();
  });

  it('does not call the server when the form is wrong', () => {
    view();
    fireEvent.change(screen.getByLabelText(t('en', 'dom.dnet.f.url')), {
      target: { value: 'http://insecure.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dom.dnet.save') }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'dom.dnet.err.baseUrl'));
  });

  it('shows the saved settings but never a credential; read-only for a member without manage', () => {
    view({
      canManage: false,
      account: {
        label: 'DNet KSA',
        environment: 'production',
        settings: { baseUrl: 'https://api.example.test', resellerId: 'R1', timeoutMs: 9000 },
        credentialStored: true,
      },
    });
    expect((screen.getByLabelText(t('en', 'dom.dnet.f.url')) as HTMLInputElement).value).toBe(
      'https://api.example.test',
    );
    expect((screen.getByLabelText(t('en', 'dom.dnet.f.key')) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(t('en', 'dom.dnet.cred.stored'))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: t('en', 'dom.dnet.save') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
