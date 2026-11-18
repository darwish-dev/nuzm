import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { InvitationsTable, InviteForm } from '../components/TeamPanels';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

export default async function Invitations({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/invitations', { params: { query: { limit: 100 } } })),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <InvitationsTable
          locale={locale}
          items={page.items}
          mfaFactorId={s.me.mfaFactorId ?? null}
          fmt={Object.fromEntries(
            page.items.map((i) => [i.id, formatDateTime(i.expiresAt, locale)]),
          )}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'invitations.title')}</PageTitle>
      {s.can('member:invite') && (
        <InviteForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      )}
      {body}
    </>
  );
}
