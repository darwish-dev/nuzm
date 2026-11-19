import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { isLocale, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { builderGuard, builderView, type Guard } from './builder-view';
import { isUuid } from './compute';
import { MOBILE_FLAG, workspaceHref, type WorkspaceTab } from './mobile';
import { flagEnabled } from './services';

/** The "not enabled" panel of the mobile builder (flag `mobile_builder.enabled`, default off; the API answers 404 for the whole surface while it is off). */
export const MobileUnavailable = ({ locale }: { locale: Locale }) => (
  <EmptyState
    title={t(locale, 'mobile.unavailable.title')}
    body={t(locale, 'mobile.unavailable.body')}
  />
);

/**
 * Page entry of the mobile screens: locale (+ project id when the route has one), session, permission, and the feature flag. While the flag is off for the
 * organization the page renders the "not enabled" state and never calls the API.
 */
export async function mobileGuard(
  params: Promise<{ locale: string; id?: string }>,
  perm: string,
  title: MessageKey,
): Promise<
  | { ok: true; locale: Locale; id: string; g: Extract<Guard, { ok: true }> }
  | { ok: false; node: ReactNode }
> {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (id !== undefined && !isUuid(id)) notFound();
  const g = await builderGuard(locale, perm, title);
  if (!g.ok) return { ok: false, node: g.denied };
  if (!flagEnabled(g.s.me.featureFlags, MOBILE_FLAG))
    return {
      ok: false,
      node: (
        <>
          <PageTitle>{t(locale, title)}</PageTitle>
          <MobileUnavailable locale={locale} />
        </>
      ),
    };
  return { ok: true, locale, id: id ?? '', g };
}

/** `builderView` with the mobile "not enabled" panel for a 404. */
export const mobileView = builderView;

/**
 * The former mobile pages (`/mobile/{id}`, `/preview`, `/builds`, `/signing`, `/releases`, `/releases/new`) now live inside the builder workspace
 * (`/builder/projects/{id}?tab=...`). They stay as redirects so a saved link or a bookmark keeps working; the workspace does the permission and flag checks.
 */
export async function redirectToWorkspace(
  params: Promise<{ locale: string; id: string }>,
  tab: WorkspaceTab,
  extra?: Record<string, string>,
): Promise<never> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  return redirect(workspaceHref(locale, id, tab, extra));
}
