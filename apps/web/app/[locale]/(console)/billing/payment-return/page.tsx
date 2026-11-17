import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { PaymentReturn } from '../../../../../components/PaymentsPanels';
import { paymentIdFrom } from '../../../../../lib/payments';
import { requireSession } from '../../../../../lib/server';

/** UI-M03-12: where the PSP (and 3-D Secure) sends the customer back: shows the payment's real state, polling until it is final. */
export default async function PaymentReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ paymentId?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  await requireSession(locale, `/${locale}/billing/payment-return`);
  return (
    <>
      <PageTitle>{t(locale, 'ret.title')}</PageTitle>
      <PaymentReturn locale={locale} paymentId={paymentIdFrom(q.paymentId)} />
    </>
  );
}
