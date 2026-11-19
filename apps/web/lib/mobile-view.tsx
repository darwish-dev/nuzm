import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { builderGuard, builderView, type Guard } from './builder-view';
import { isUuid } from './compute';
import { MOBILE_FLAG } from './mobile';
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
