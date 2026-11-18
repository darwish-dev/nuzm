import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { HostingTabs } from '../../../../../../../components/HostingTabs';
import { requireSession } from '../../../../../../../lib/server';
import { view } from '../../../../../../../lib/view';

/** UI-M06-07: unavailable until the M08 database provider is enabled (the API answers `available: false`). */
export default async function Databases({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites/{id}/databases', { params: { path: { id } } })),
    (data) =>
      data.available ? (
        <EmptyState title={t(locale, 'host.tab.databases')} body={t(locale, 'state.empty.body')} />
      ) : (
        <EmptyState title={t(locale, 'host.db.unavailable')} body={t(locale, 'state.empty.body')} />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.tab.databases')}</PageTitle>
      <HostingTabs locale={locale} siteId={id} current="databases" />
      {body}
    </>
  );
}
