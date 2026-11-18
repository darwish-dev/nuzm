import { notFound } from 'next/navigation';
import type { ComponentType } from 'react';
import { isLocale, t, type Locale } from '@nuzm/i18n';
import { ForbiddenState } from '@nuzm/ui';
import { StackPage, StackSection } from '../components/StackSection';
import { requireSession } from '../lib/server';

type Messages = Parameters<typeof t>[1];
type ScreenProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export interface Screen {
  /** The anchor the screen's old route redirects to. */
  id: string;
  title: Messages;
  /** Any one of these permissions shows the section (the same rule as the navigation). */
  perm: string[];
  Screen: ComponentType<ScreenProps>;
}

/** Renders the screens this member may see as sections of one page, one under the other. */
export async function StackedScreens({
  locale: raw,
  title,
  screens,
  params,
  searchParams,
}: {
  locale: string;
  title: Messages;
  screens: Screen[];
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const s = await requireSession(locale);
  const shown = s.org ? screens.filter((x) => x.perm.some(s.can)) : [];
  return (
    <StackPage title={t(locale, title)}>
      {shown.length === 0 ? (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      ) : (
        shown.map(({ id, title: tt, Screen }) => (
          <StackSection key={id} id={id} title={t(locale, tt)}>
            <Screen params={params} searchParams={searchParams} />
          </StackSection>
        ))
      )}
    </StackPage>
  );
}
