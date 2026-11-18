import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, EmptyState, PageTitle } from '@nuzm/ui';
import { BillingTabs } from '../components/BillingTabs';
import { MethodsTable } from '../components/PaymentsPanels';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M03-01: saved payment methods (tokens only): default, remove, expiring badge. */
export default async function PaymentMethods({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/billing/payment-methods', {})),
    (res) =>
      res.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'pay.methods.none')}
          body={t(locale, 'pay.methods.noneBody')}
        />
      ) : (
        <MethodsTable
          locale={locale}
          rows={res.items}
          canManage={s.can('billing:manage')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pay.methods.title')}</PageTitle>
      <BillingTabs locale={locale} current="methods" can={s.can} />
      {s.can('billing:manage') && (
        <p>
          <ButtonLink href={`/${locale}/billing/payment-methods/add`}>
            {t(locale, 'pay.methods.add')}
          </ButtonLink>
        </p>
      )}
      {body}
    </>
  );
}
