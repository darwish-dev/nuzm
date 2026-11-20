import { describe, expect, it } from 'vitest';
import { APP_ROUTE_TAB, APP_TABS, appPhase, appTab, appTabsFor } from './webapp-workspace';

describe('web-app workspace routing', () => {
  it('?tab= picks the panel and anything else opens the preview', () => {
    for (const x of APP_TABS) expect(appTab(x)).toBe(x);
    expect(appTab(['tests', 'code'])).toBe('tests');
    expect(appTab('nope')).toBe('preview');
    expect(appTab(undefined)).toBe('preview');
  });
  it('lists only the panels the member may open, each with the permission its former page needed', () => {
    // AI Studio (ADR-064) is listed only with its flag on
    expect(appTabsFor(() => true)).toEqual(APP_TABS.filter((x) => x !== 'studio'));
    expect(appTabsFor(() => true, true)).toEqual([...APP_TABS]);
    expect(appTabsFor((p) => p === 'builder:read')).toEqual([
      'preview',
      'spec',
      'design',
      'tests',
      'versions',
    ]);
    const without = (perm: string) => appTabsFor((p) => p !== perm);
    expect(without('sandbox:use')).not.toContain('code');
    expect(without('deploy:read')).not.toContain('deployments');
    expect(without('builder:export')).not.toContain('exports');
  });
  it('every former route of a web-app project maps to a panel (the IDE became Code)', () => {
    expect(APP_ROUTE_TAB).toEqual({
      spec: 'spec',
      design: 'design',
      ide: 'code',
      tests: 'tests',
      deployments: 'deployments',
      exports: 'exports',
      versions: 'versions',
    });
    for (const tab of Object.values(APP_ROUTE_TAB)) expect(APP_TABS).toContain(tab);
  });
  it('names the phase of a build from the run state', () => {
    expect(appPhase('queued')).toBe('queued');
    expect(appPhase('running')).toBe('working');
    expect(appPhase('waiting_approval')).toBe('approval');
    expect(appPhase('succeeded')).toBe('done');
    expect(appPhase('failed')).toBe('failed');
    expect(appPhase('cancelled')).toBe('cancelled');
    expect(appPhase('budget_exceeded')).toBe('budget');
  });
});
