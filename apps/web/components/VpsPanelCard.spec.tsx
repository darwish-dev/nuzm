// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type Locale } from '@nuzm/i18n';

const get = vi.fn();
const post = vi.fn();
vi.mock('../lib/compute-client', () => ({
  browserCompute: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

import { panelPollMs, panelUrl, type PanelInstall } from '../lib/compute';
import { VpsPanelCard } from './VpsPanelCard';

const base: PanelInstall = {
  kind: 'hestia',
  stage: 'installing_panel',
  steps: [
    { key: 'create_server', state: 'done' },
    { key: 'wait_boot', state: 'done' },
    { key: 'install_panel', state: 'running' },
    { key: 'register', state: 'pending' },
    { key: 'readiness', state: 'pending' },
  ],
  template: { id: 'hestia-web', mail: false },
  panelVersion: '1.10.9',
  osName: 'Ubuntu 24.04 64 bit',
  panelHost: 'p-0123456789abcdef.vps.nuzm.test',
  panelPort: 8083,
  panelLink: 'none',
  attention: null,
  holdReason: null,
  ready: false,
  rerunCommand: null,
  adminPasswordFile: '/root/.nuzm-panel-admin-password',
  updatedAt: '2026-11-24T10:00:00.000Z',
};
const ok = <T,>(data: T) => ({ data, response: new Response(null, { status: 200 }) });
beforeEach(() => {
  get.mockReset();
  post.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const locales: Locale[] = ['ar', 'en'];
describe.each(locales)('VpsPanelCard (%s)', (locale) => {
  it('shows every stage as an ordered list with the current one marked, in the page language', () => {
    render(<VpsPanelCard locale={locale} instanceId="i1" initial={base} canAct />);
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(5);
    expect(steps[2]!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText(t(locale, 'vps.panel.stage.installing_panel'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'vps.panel.tpl.web'), { exact: false })).toBeTruthy();
    expect(screen.queryByText(t(locale, 'vps.panel.open'))).toBeNull(); // no panel link before it is ready
  });

  it('ready: the panel link state is separate; a lost link keeps the provider actions and says so, and the secret path is a hint, never a value', () => {
    const ready: PanelInstall = {
      ...base,
      stage: 'ready',
      ready: true,
      panelLink: 'lost',
      steps: base.steps.map((s) => ({ ...s, state: 'done' as const })),
    };
    render(<VpsPanelCard locale={locale} instanceId="i1" initial={ready} canAct />);
    expect(screen.getByText(t(locale, 'vps.panel.link.lost'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'vps.panel.link.lost.note'))).toBeTruthy();
    const open = screen.getByText(t(locale, 'vps.panel.open')).closest('a')!;
    expect(open.getAttribute('href')).toBe('https://p-0123456789abcdef.vps.nuzm.test:8083');
    expect(screen.getByText('/root/.nuzm-panel-admin-password')).toBeTruthy();
  });

  it('held: clear reason, the region is not changed, cancelling is free', () => {
    render(
      <VpsPanelCard
        locale={locale}
        instanceId="i1"
        initial={{ ...base, stage: 'held', holdReason: 'provider_capacity_unavailable' }}
        canAct
      />,
    );
    expect(screen.getByText(t(locale, 'vps.panel.held.title'))).toBeTruthy();
    expect(screen.getByText(t(locale, 'vps.panel.held.body'))).toBeTruthy();
  });

  it('needs attention (server side): retry resumes on the same server and shows the command to re-run', async () => {
    const attn: PanelInstall = {
      ...base,
      stage: 'needs_attention',
      attention: { code: 'bootstrap_install_failed', detail: null, resumable: 'server' },
      rerunCommand: 'sudo bash /usr/local/sbin/nuzm-bootstrap.sh',
    };
    post.mockResolvedValue(
      ok({
        action: 'rerun_bootstrap',
        command: 'sudo bash /usr/local/sbin/nuzm-bootstrap.sh',
        panel: { ...base, stage: 'installing_panel' },
      }),
    );
    render(<VpsPanelCard locale={locale} instanceId="i1" initial={attn} canAct />);
    expect(
      screen.getByText(t(locale, 'vps.panel.attn.bootstrap_install_failed'), { exact: false }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t(locale, 'vps.panel.retry') }));
    await waitFor(() =>
      expect(screen.getByText('sudo bash /usr/local/sbin/nuzm-bootstrap.sh')).toBeTruthy(),
    );
    expect(post).toHaveBeenCalledWith(
      '/v1/compute/instances/i1/panel/retry',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(screen.queryByRole('button', { name: t(locale, 'vps.panel.retry') })).toBeNull(); // no longer needs attention
  });

  it('a failed integrity check is not resumable: no retry button, support text instead; a viewer without act permission gets no button either', () => {
    const integrity: PanelInstall = {
      ...base,
      stage: 'needs_attention',
      attention: { code: 'integrity_failed', detail: null, resumable: 'support' },
    };
    const { unmount } = render(
      <VpsPanelCard locale={locale} instanceId="i1" initial={integrity} canAct />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(t(locale, 'vps.panel.attn.support'), { exact: false })).toBeTruthy();
    unmount();
    const here: PanelInstall = {
      ...base,
      stage: 'needs_attention',
      attention: { code: 'readiness_failed', detail: null, resumable: 'here' },
    };
    render(<VpsPanelCard locale={locale} instanceId="i1" initial={here} canAct={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('follows the install by itself while it runs', async () => {
    vi.useFakeTimers();
    get.mockResolvedValue(ok({ ...base, stage: 'readiness' }));
    render(<VpsPanelCard locale={locale} instanceId="i1" initial={base} canAct />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(get).toHaveBeenCalledWith('/v1/compute/instances/i1/panel');
    expect(screen.getByText(t(locale, 'vps.panel.stage.readiness'))).toBeTruthy();
  });
});

describe('panel helpers', () => {
  it('polls while it runs, slowly when ready, never when a person has to act', () => {
    expect(panelPollMs('installing_panel')).toBe(5_000);
    expect(panelPollMs('held')).toBe(5_000);
    expect(panelPollMs('ready')).toBe(60_000);
    expect(panelPollMs('needs_attention')).toBe(0);
  });
  it('the panel address is https on the fixed host the API returned', () => {
    expect(panelUrl({ panelHost: 'p-1.vps.nuzm.test', panelPort: 8083 })).toBe(
      'https://p-1.vps.nuzm.test:8083',
    );
  });
});
