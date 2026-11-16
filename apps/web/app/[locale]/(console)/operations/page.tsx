import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { OperationsTable } from '../../../../components/ProjectPanels';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Operations({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      (await unwrap(s.api.GET('/v1/operations', { params: { query: { limit: 50 } } }))).items,
    (items) =>
      items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <OperationsTable
          locale={locale}
          items={items}
          canCancel={s.can('operation:cancel')}
          fmt={Object.fromEntries(items.map((o) => [o.id, formatDateTime(o.createdAt, locale)]))}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'operations.title')}</PageTitle>
      {body}
    </>
  );
}
