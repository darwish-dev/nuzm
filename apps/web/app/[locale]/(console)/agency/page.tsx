import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle, EmptyState } from '@nuzm/ui';
import { requireSession } from '../../../../lib/server';

export default async function Shell({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (s.org?.type !== 'agency')
    return (
      <ForbiddenState
        title={t(locale, 'state.forbidden.title')}
        body={t(locale, 'state.forbidden.body')}
      />
    );
  return (
    <>
      <PageTitle>{t(locale, 'shell.agency.title')}</PageTitle>
      <EmptyState title={t(locale, 'shell.agency.title')} body={t(locale, 'shell.m11')} />
    </>
  );
}
