import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { LiveVerificationPanel } from '../../../../../components/LiveVerification';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import { loose, type LiveVerification } from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M05-15: live verification status, evidence index and gates. Read-only: nothing on this page can start a live run. */
export default async function LiveVerificationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      () => unwrap(loose(s.api).GET<LiveVerification>('/v1/admin/live-verification')),
      (data) => <LiveVerificationPanel locale={locale} data={data} />,
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.lv.title')}</PageTitle>
      <ProviderTabs locale={locale} current="liveVerification" can={s.can} />
      {body}
    </>
  );
}
