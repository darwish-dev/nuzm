import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { TaxProfileForm } from '../../../../../components/PaymentsPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M03-10: the tax profile used on invoices (company names, VAT and CR numbers, address, B2B/B2C). */
export default async function TaxProfile({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      try {
        return await unwrap(s.api.GET('/v1/billing/tax-profile', {}));
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return null; // none yet: the form creates it
        throw e;
      }
    },
    (profile) => (
      <>
        <p className="nz-muted">{t(locale, 'tax.help')}</p>
        {!profile && <p className="nz-muted">{t(locale, 'tax.none')}</p>}
        <TaxProfileForm
          locale={locale}
          profile={profile}
          canManage={s.can('billing:manage')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'tax.title')}</PageTitle>
      <BillingTabs locale={locale} current="taxProfile" can={s.can} />
      {body}
    </>
  );
}
