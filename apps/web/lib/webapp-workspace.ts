/** Pure helpers of the web-app mode of the builder workspace (the web app opens in the same full-screen workspace as a website). No I/O: tested in `webapp-workspace.spec.ts`. */
import type { Run } from './builder';
import { isRunActive } from './builder';

/** The panels of the web-app mode, in the order of its top bar. They are the former tabbed pages of a web-app project. */
export const APP_TABS = [
  'preview',
  'code',
  'spec',
  'design',
  'tests',
  'deployments',
  'exports',
  'versions',
  'studio',
] as const;
export type AppTab = (typeof APP_TABS)[number];

/** The permission each panel needs: the one its former page checked (`builder:read` unless noted). */
export const APP_TAB_PERMISSION: Record<AppTab, string> = {
  preview: 'builder:read',
  code: 'sandbox:use',
  spec: 'builder:read',
  design: 'builder:read',
  tests: 'builder:read',
  deployments: 'deploy:read',
  exports: 'builder:export',
  versions: 'builder:read',
  studio: 'builder:read',
};
/** `?tab=` of the workspace route; anything else opens the preview. */
export function appTab(raw: string | string[] | undefined): AppTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (APP_TABS as readonly string[]).includes(v ?? '') ? (v as AppTab) : 'preview';
}
/** `studio` (AI Studio, ADR-064) is listed only while the organization has `ai_studio.enabled` (default off). */
export const appTabsFor = (can: (permission: string) => boolean, studio = false): AppTab[] =>
  APP_TABS.filter((x) => can(APP_TAB_PERMISSION[x]) && (x !== 'studio' || studio));

/** The former route segments of a web-app project and the panel each one became (`/builder/projects/{id}/ide` is the Code panel, and so on). */
export const APP_ROUTE_TAB = {
  spec: 'spec',
  design: 'design',
  ide: 'code',
  tests: 'tests',
  deployments: 'deployments',
  exports: 'exports',
  versions: 'versions',
} as const satisfies Record<string, AppTab>;

/** The phase of a web-app run in words a person uses (the title of the card). */
export type AppPhase =
  'queued' | 'working' | 'approval' | 'done' | 'failed' | 'cancelled' | 'budget';
export function appPhase(state: string): AppPhase {
  if (state === 'succeeded') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'budget_exceeded') return 'budget';
  if (state === 'waiting_approval') return 'approval';
  return state === 'queued' ? 'queued' : 'working';
}

/** A run that is not over: the composer waits (one active run per session). */
export const isAppRunActive = (run: Pick<Run, 'state'> | null): boolean =>
  run ? isRunActive(run.state) : false;
