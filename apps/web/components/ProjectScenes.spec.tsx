// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';
import { AppBuildingScene } from './AppBuildingScene';
import { MobileBuildingScene } from './MobileBuildingScene';
import { WorkspaceShell } from './WorkspaceShell';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the preview while a web app or a mobile app is being built', () => {
  it('web app: announced once, its three layers named like the agents and built bottom-up, data packets between them', () => {
    const { container } = render(<AppBuildingScene locale="en" label="Database 2/6" />);
    expect(screen.getByRole('img', { name: 'Database 2/6' })).toBeTruthy();
    expect(container.querySelector('.ascene-board')?.getAttribute('aria-hidden')).toBe('true');
    const layers = [...container.querySelectorAll('.ascene-layer h4')].map((h) => h.textContent);
    expect(layers).toEqual([
      t('en', 'm10a.agent.frontend'),
      t('en', 'm10a.agent.backend'),
      t('en', 'm10a.agent.database'),
    ]);
    const order = [...container.querySelectorAll<HTMLElement>('.ascene-layer')].map((e) =>
      Number(e.style.getPropertyValue('--i')),
    );
    expect(order[2]).toBeLessThan(order[1]!); // database first, then API, then the interface
    expect(order[1]).toBeLessThan(order[0]!);
    expect(container.querySelectorAll('.ascene-link b')).toHaveLength(6);
  });
  it('mobile: a phone assembled in step with its Flutter widget tree, announced once with a generic fallback', () => {
    const { container } = render(<MobileBuildingScene locale="en" label="" />);
    expect(screen.getByRole('img', { name: t('en', 'mws.preview.designing') })).toBeTruthy();
    const tree = [...container.querySelectorAll('.mscene-tree code')].map((c) => c.textContent);
    expect(tree).toEqual(['Scaffold', 'AppBar', 'ListView', 'Card', 'Card', 'NavigationBar']);
    expect(container.querySelector('.mscene-phone')).toBeTruthy();
    expect(container.querySelector('.mscene-stage')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the workspace shell shows the scene of its project type while a run works, and fades it out after', () => {
  const shell = (mode: 'webapp' | 'mobile', scene: boolean) => (
    <WorkspaceShell
      locale="en"
      mode={mode}
      backHref="/en/builder/projects"
      name="P"
      tabsLabel="tabs"
      tabs={[{ id: 'preview', icon: 'eye', label: 'Preview' }]}
      tab="preview"
      onTab={() => undefined}
      chat={<p>chat</p>}
      working={{ active: scene, label: 'Working' }}
      scene={scene}
    >
      <p>canvas</p>
    </WorkspaceShell>
  );
  it('web app mode gets the blueprint, mobile mode the phone, and nothing while idle', () => {
    const { container, rerender } = render(shell('webapp', false));
    expect(container.querySelector('.bscene-wrap')).toBeNull();
    rerender(shell('webapp', true));
    expect(container.querySelector('.ascene')).toBeTruthy();
    expect(container.querySelector('.mscene')).toBeNull();
    cleanup();
    const m = render(shell('mobile', true));
    expect(m.container.querySelector('.mscene')).toBeTruthy();
    expect(m.container.querySelector('.ascene')).toBeNull();
  });
  it('stays a moment after the run ends (leaving), then goes', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(shell('webapp', true));
    rerender(shell('webapp', false));
    expect(container.querySelector('.bscene-wrap')?.getAttribute('data-leaving')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(container.querySelector('.bscene-wrap')).toBeNull();
  });
});
