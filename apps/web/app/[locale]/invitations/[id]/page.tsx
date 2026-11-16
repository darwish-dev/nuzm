import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Card, ErrorState, LocaleSwitch, PageTitle } from '@nuzm/ui';
import { AcceptInvitation } from '../../../../components/TeamPanels';
import { requireSession } from '../../../../lib/server';

/**
 * Invitation link: `/invitations/{id}?token=…` (the API's acceptance route needs the invitation id as well as the
 * secret token, so the mail carries both). Signed-out visitors are sent to sign in and come straight back here.
 */
export default async function Accept({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale, id } = await params;
  const { token } = await searchParams;
  if (!isLocale(locale)) notFound();
  await requireSession(
    locale,
    `/${locale}/invitations/${id}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
  );
  return (
    <main className="nz-main" style={{ maxInlineSize: 520, marginInline: 'auto' }}>
      <PageTitle>{t(locale, 'invite.accept.title')}</PageTitle>
      {token ? (
        <Card>
          <p>{t(locale, 'invite.accept.body')}</p>
          <AcceptInvitation locale={locale} id={id} token={token} />
        </Card>
      ) : (
        <ErrorState title={t(locale, 'invite.accept.gone')} body={t(locale, 'state.error.body')} />
      )}
      <p>
        <LocaleSwitch
          current={locale}
          locales={['ar', 'en']}
          labels={{ ar: 'العربية', en: 'English' }}
        />
      </p>
    </main>
  );
}
