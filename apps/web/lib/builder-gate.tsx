import type { ReactNode } from 'react';
import { ApiError } from '@nuzm/sdk';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { NotEnabledState } from '../components/BuilderParts';
import { APP_BUILDER_FLAG } from './appbuilder';
import { serverCompute } from './compute-server';
import { gate } from './gate';
import type { Session } from './server';
import { flagEnabled } from './services';
import { view } from './view';

/**
 * Page entry of the app-builder screens: locale + session + permission (as `gate`), and the feature flag `app_builder.enabled` (default off): while it is off
 * for the organization the page renders the "not enabled" state instead of calling the API (which would answer 404).
 */
export async function bgate(
  params: Promise<{ locale: string }>,
  permission: string,
  title: MessageKey,
): Promise<{ ok: true; locale: Locale; s: Session } | { ok: false; node: ReactNode }> {
  const g = await gate(params, permission, title);
  if (!g.ok) return g;
  if (!flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG))
    return {
      ok: false,
      node: (
        <>
          <PageTitle>{t(g.locale, title)}</PageTitle>
          <NotEnabledState locale={g.locale} />
        </>
      ),
    };
  return g;
}

/** `view` plus: a 404 from a builder call (flag off on the server, or the item does not exist) renders the same "not enabled" state. */
export async function bview<T>(
  locale: Locale,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  return view(
    locale,
    async () => {
      try {
        return await load();
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return NOT_FOUND as unknown as T;
        throw e;
      }
    },
    (data) =>
      data === (NOT_FOUND as unknown) ? <NotEnabledState locale={locale} /> : render(data),
  );
}
const NOT_FOUND = Symbol('not-found');

/** `bgate` plus the server-side API client of the active organization (the web-app workspace pages read runs and artifacts through it). */
export async function agate(
  params: Promise<{ locale: string }>,
  permission: string,
  title: MessageKey,
): Promise<
  | { ok: true; locale: Locale; s: Session; c: Awaited<ReturnType<typeof serverCompute>> }
  | { ok: false; node: ReactNode }
> {
  const g = await bgate(params, permission, title);
  if (!g.ok) return g;
  return { ...g, c: await serverCompute(g.s.org?.orgId) };
}
