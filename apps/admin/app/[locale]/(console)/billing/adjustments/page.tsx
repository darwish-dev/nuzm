import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { AdjustmentsPanel } from '../../../../../components/BillingAdminPanels';
import { requireStaff } from '../../../../../lib/server';

export default async function Adjustments({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const allowed = s.can('admin:billing:manage') || s.can('admin:billing:approve');
  return (
    <>
      <PageTitle>{t(locale, 'abill.adj.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="adjustments" can={s.can} />
      {allowed ? (
        <AdjustmentsPanel
          locale={locale}
          canRequest={s.can('admin:billing:manage')}
          canDecide={s.can('admin:billing:approve')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      ) : (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      )}
    </>
  );
}
