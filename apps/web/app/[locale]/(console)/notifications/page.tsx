import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { NotificationList } from '../../../../components/NotificationList';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Notifications({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 50 } } })),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <NotificationList
          items={page.items.map((n) => ({
            id: n.id,
            text: tDynamic(
              locale,
              `notif.kind.${n.kind}`,
              t(locale, 'notif.kind.unknown', { kind: n.kind }),
              n.params as Record<string, string | number>,
            ),
            when: formatDateTime(n.createdAt, locale),
            read: n.readAt !== null,
          }))}
          labels={{
            read: t(locale, 'action.markRead'),
            unread: t(locale, 'action.markUnread'),
            error: t(locale, 'state.error.title'),
          }}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'notifications.title')}</PageTitle>
      {body}
    </>
  );
}
