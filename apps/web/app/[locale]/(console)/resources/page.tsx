import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Resources({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/resources', {})),
    () => (
      <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'resources.empty.body')} />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'resources.title')}</PageTitle>
      {body}
    </>
  );
}
