import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { requireSession, type Session } from './server';

/**
 * Page entry of the data and email screens: validates the locale, requires the session and the page's permission. A caller without it gets the
 * forbidden state with the page title (the API stays the authority: a 403 from a call renders the same state through `view`).
 */
export async function gate(
  params: Promise<{ locale: string }>,
  permission: string,
  title: MessageKey,
): Promise<{ ok: true; locale: Locale; s: Session } | { ok: false; node: ReactNode }> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can(permission))
    return {
      ok: false,
      node: (
        <>
          <PageTitle>{t(locale, title)}</PageTitle>
          <ForbiddenState
            title={t(locale, 'state.forbidden.title')}
            body={t(locale, 'state.forbidden.body')}
          />
        </>
      ),
    };
  return { ok: true, locale, s };
}
