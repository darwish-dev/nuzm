import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { NewRequestForm } from '../../../../../../components/PrivacyPanels';
import { PrivacyTabs } from '../../../../../../components/PrivacyTabs';
import { requireSession } from '../../../../../../lib/server';

/** UI-M04-03: open a request (type, subject, details). Someone else's request needs an administrator and a written identity check. */
export default async function NewRequest({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:dsr:self'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.req.new')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  return (
    <>
      <PageTitle>{t(locale, 'pv.req.new')}</PageTitle>
      <PrivacyTabs locale={locale} current="requests" can={s.can} />
      <NewRequestForm locale={locale} canManage={s.can('privacy:dsr:manage')} />
    </>
  );
}
