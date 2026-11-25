// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post, PUT: put, PATCH: patch }) }));
import { NodePanelForm, RegisterNodeForm } from './HostingNodeForms';

const ok = (data: unknown = {}, status = 200) => ({ response: { ok: true, status }, data });
beforeEach(() => [post, put, patch, push].forEach((m) => m.mockReset()));
afterEach(cleanup);
const node = {
  id: 'n1',
  version: 3,
  status: 'maintenance',
  health: 'unknown',
  panelConfigured: false,
};

describe('hosting server forms', () => {
  it('registers a server and opens it', async () => {
    post.mockResolvedValue(ok({ node: { id: 'n9' } }, 201));
    render(<RegisterNodeForm locale="en" mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'hnode.f.name')), {
      target: { value: 'Hosting-KSA-1' },
    });
    fireEvent.change(screen.getByLabelText(t('en', 'hnode.f.instance')), {
      target: { value: 'i-0abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'hnode.register.submit') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1].body).toEqual({
      name: 'hosting-ksa-1',
      computeInstanceId: 'i-0abc',
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/hosting/nodes/n9'));
  });

  it('saves the panel connection, then empties the write-only key field', async () => {
    put.mockResolvedValue(ok({}));
    render(<NodePanelForm locale="en" node={node} canManage mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'hnode.f.host')), {
      target: { value: 'panel.example.com' },
    });
    const key = screen.getByLabelText(t('en', 'hnode.f.key')) as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'ABCDEFGHIJ0123456789:secretsecretsecret' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'hnode.panel.save') }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe('/v1/admin/hosting/nodes/{id}/panel');
    expect(put.mock.calls[0]![1].body).toMatchObject({
      host: 'panel.example.com',
      port: 8083,
      credentials: { accessKey: 'ABCDEFGHIJ0123456789:secretsecretsecret' },
    });
    await waitFor(() => expect(key.value).toBe(''));
  });

  it('refuses an IP address as the panel host without calling the server, and cannot test an unconnected node', () => {
    render(<NodePanelForm locale="en" node={node} canManage mfaFactorId={null} />);
    fireEvent.change(screen.getByLabelText(t('en', 'hnode.f.host')), {
      target: { value: '10.0.0.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'hnode.panel.save') }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('en', 'hnode.err.host'));
    expect(
      (screen.getByRole('button', { name: t('en', 'hnode.test') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('tests the connection and activates with the version the page was read at', async () => {
    post.mockResolvedValue(ok({}, 201));
    patch.mockResolvedValue(ok({}));
    render(
      <NodePanelForm
        locale="en"
        node={{ ...node, panelConfigured: true, panelHost: 'p.example.com', panelPort: 8083 }}
        canManage
        mfaFactorId={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'hnode.test') }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/v1/admin/hosting/nodes/{id}/inventory');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'hnode.activate') }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![1].params.header['If-Match']).toBe('"3"');
    expect(patch.mock.calls[0]![1].body).toEqual({ status: 'active' });
  });
});
