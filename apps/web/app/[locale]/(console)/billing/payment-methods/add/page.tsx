import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, ForbiddenState, PageTitle } from '@nuzm/ui';
import { AddMethodForm } from '../../../../../../components/PaymentsPanels';
import { sandboxUi } from '../../../../../../lib/payments';
import { requireSession } from '../../../../../../lib/server';

/** UI-M03-02: add a payment method. Card details are entered on the PSP's own form (here: the sandbox's test cards); this app never sees a card number. */
export default async function AddPaymentMethod({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  return (
    <>
      <PageTitle>{t(locale, 'pay.add.title')}</PageTitle>
      <Banner tone="warn">{t(locale, 'pay.add.never')}</Banner>
      {s.can('billing:manage') ? (
        <AddMethodForm
          locale={locale}
          sandbox={sandboxUi()}
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
