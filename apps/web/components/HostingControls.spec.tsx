// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const del = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, DELETE: del }) }));
import {
  AddDomainForm,
  BackupRowActions,
  CreateBackupForm,
  DeleteSiteForm,
  IssueCertificateButton,
} from './HostingControls';

const ok = (data: unknown = {}, status = 200) => ({ response: { ok: true, status }, data });
const fail = (status: number, code: string) => ({
  response: { ok: false, status },
  error: { code },
});
beforeEach(() => [post, del].forEach((m) => m.mockReset()));
afterEach(cleanup);

describe('website controls in the console', () => {
  it('adds a domain: lower-cased, sent with an idempotency key, and says what to do next', async () => {
    post.mockResolvedValue(ok({ binding: {} }, 201));
    render(<AddDomainForm locale="en" siteId="s1" mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'host.ctl.domain.label')), {
      target: { value: ' Example.COM ' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.domain.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/v1/hosting/sites/{id}/domains');
    expect(post.mock.calls[0]![1].body).toEqual({ domain: 'example.com' });
    expect(post.mock.calls[0]![1].params.header['Idempotency-Key']).toBeTruthy();
    await waitFor(() => expect(screen.getByText(t('en', 'host.ctl.domain.added'))).toBeTruthy());
  });

  it('does not call the server for a bad domain, and names a domain that is already in use', async () => {
    render(<AddDomainForm locale="en" siteId="s1" mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'host.ctl.domain.label')), {
      target: { value: 'not a domain' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.domain.submit') }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'host.ctl.domain.invalid'));
    post.mockResolvedValue(fail(409, 'domain_in_use'));
    fireEvent.change(screen.getByLabelText(t('en', 'host.ctl.domain.label')), {
      target: { value: 'taken.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.domain.submit') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t('en', 'host.ctl.domain.inUse')),
    );
  });

  it('a node that is not connected is said in words, not as a generic failure', async () => {
    post.mockResolvedValue(fail(422, 'unsupported_capability'));
    render(<CreateBackupForm locale="en" siteId="s1" mfaFactorId={null} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.bk.create') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(t('en', 'host.ctl.notReady')),
    );
  });

  it('issues a managed certificate for the verified domains only, and is disabled with none', async () => {
    post.mockResolvedValue(ok({}, 202));
    const { rerender } = render(
      <IssueCertificateButton locale="en" siteId="s1" domains={[]} mfaFactorId={null} />,
    );
    expect(
      (screen.getByRole('button', { name: t('en', 'host.ctl.ssl.issue') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      <IssueCertificateButton
        locale="en"
        siteId="s1"
        domains={['a.com', 'www.a.com']}
        mfaFactorId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.ssl.issue') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      mode: 'managed',
      domains: ['a.com', 'www.a.com'],
    });
  });

  it('a backup row offers restore (after a confirmation) and a download link only when it is available', async () => {
    post.mockResolvedValue(ok({}, 202));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { rerender, container } = render(
      <BackupRowActions
        locale="en"
        siteId="s1"
        backupId="b1"
        available={false}
        canRestore
        mfaFactorId={null}
      />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <BackupRowActions
        locale="en"
        siteId="s1"
        backupId="b1"
        available
        canRestore
        mfaFactorId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.bk.restore') }));
    expect(post).not.toHaveBeenCalled(); // declined at the confirmation
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'host.ctl.bk.restore') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/v1/hosting/sites/{id}/restores');
    expect(post.mock.calls[0]![1].body).toEqual({ backupId: 'b1' });
    confirm.mockRestore();
  });

  it('deleting needs the exact website name, sent as the confirmation header', async () => {
    del.mockResolvedValue(ok({}, 202));
    render(<DeleteSiteForm locale="en" siteId="s1" siteName="my-shop" mfaFactorId={null} />);
    const button = screen.getByRole('button', {
      name: t('en', 'host.ctl.del.submit'),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t('en', 'host.ctl.del.name')), {
      target: { value: 'my-sho' },
    });
    fireEvent.click(button);
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'host.ctl.del.mismatch'));
    fireEvent.change(screen.getByLabelText(t('en', 'host.ctl.del.name')), {
      target: { value: 'my-shop' },
    });
    fireEvent.click(button);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0]![1].params.header['X-Confirm-Delete']).toBe('my-shop');
  });
});
