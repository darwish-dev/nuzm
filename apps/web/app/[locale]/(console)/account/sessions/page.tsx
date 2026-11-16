import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { SessionsTable } from '../../../../../components/AccountPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Sessions({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => (await unwrap(s.api.GET('/v1/auth/sessions', {}))).items,
    (items) =>
      items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <SessionsTable
          locale={locale}
          items={items}
          fmt={Object.fromEntries(items.map((i) => [i.id, formatDateTime(i.lastSeenAt, locale)]))}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'sessions.title')}</PageTitle>
      {body}
    </>
  );
}
