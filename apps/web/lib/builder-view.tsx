import type { ReactNode } from 'react';
import { ApiError } from '@nuzm/sdk';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { serverCompute } from './compute-server';
import { requireSession, type Session } from './server';
import { view } from './view';

const GONE = Symbol('not-available');

/** "Not available" panel: the API answers 404 for the whole builder surface while the `ai.enabled` flag is off (and for another organization's ids). */
export const NotAvailable = ({ locale }: { locale: Locale }) => (
  <EmptyState title={t(locale, 'bld.unavailable.title')} body={t(locale, 'bld.unavailable.body')} />
);

/** Like `view`, plus: a 404 renders the clean "not available" state instead of the generic error panel. Never throws. */
export async function builderView<T>(
  locale: Locale,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  return view<T | typeof GONE>(
    locale,
    async () => {
      try {
        return await load();
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return GONE;
        throw e;
      }
    },
    (d) => (d === GONE ? <NotAvailable locale={locale} /> : render(d as T)),
  );
}

export type Guard =
  | { ok: false; denied: ReactNode }
  | { ok: true; s: Session; orgId: string; c: Awaited<ReturnType<typeof serverCompute>> };

/** Session, organization and permission check shared by the builder pages: either the panel to render instead, or everything the page needs. */
export async function builderGuard(
  locale: Locale,
  perm: string,
  title: MessageKey,
): Promise<Guard> {
  const s = await requireSession(locale);
  if (!s.org)
    return {
      ok: false,
      denied: (
        <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />
      ),
    };
  if (!s.can(perm))
    return {
      ok: false,
      denied: (
        <>
          <PageTitle>{t(locale, title)}</PageTitle>
          <ForbiddenState
            title={t(locale, 'state.forbidden.title')}
            body={t(locale, 'state.forbidden.body')}
          />
        </>
      ),
    };
  return { ok: true, s, orgId: s.org.orgId, c: await serverCompute(s.org.orgId) };
}
