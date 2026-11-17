import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { RefundForm } from '../../../../../components/FinancePanels';
import { requireStaff } from '../../../../../lib/server';

/**
 * UI-M03-15: request a refund (step-up). PARTIAL: the list of refunds and their status needs `GET /v1/admin/billing/refunds`, which
 * docs/04 does not define (owner decision pending), so each request's result is shown here right after it is sent, nothing more.
 */
export default async function Refunds({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  return (
    <>
      <PageTitle>{t(locale, 'af.ref.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="refunds" can={s.can} />
      {s.can('admin:billing:manage') ? (
        <>
          <RefundForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
          <p className="nz-muted">{t(locale, 'af.ref.listMissing')}</p>
        </>
      ) : (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      )}
    </>
  );
}
