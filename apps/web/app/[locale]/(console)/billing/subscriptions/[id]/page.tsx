import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, Card, Ltr, PageTitle } from '@nuzm/ui';
import { BillingTabs } from '../../../../../../components/BillingTabs';
import { SubscriptionActions } from '../../../../../../components/PaymentsPanels';
import { statusTone } from '../../../../../../lib/payments';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M03-04: one subscription: change plan (with the proration preview), cancel at period end, and the dunning banner. */
export default async function SubscriptionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      try {
        const sub = await unwrap(
          s.api.GET('/v1/billing/subscriptions/{id}', { params: { path: { id } } }),
        );
        const plans = s.can('billing:manage')
          ? await unwrap(s.api.GET('/v1/billing/plans', {}))
          : null;
        return { sub, plans };
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    ({ sub, plans }) => (
      <>
        {sub.dunningStage && (
          <Banner tone="danger">
            <strong>{t(locale, 'sub.dunning.title')}</strong>{' '}
            {t(locale, 'sub.dunning.body', {
              stage: tDynamic(locale, `sub.dunning.stage.${sub.dunningStage}`, sub.dunningStage),
            })}{' '}
            {sub.latestInvoiceId && (
              <a href={`/billing/invoices/${sub.latestInvoiceId}`}>
                {t(locale, 'sub.dunning.invoice')}
              </a>
            )}
          </Banner>
        )}
        <Card aria-labelledby="sub-h">
          <h2 className="nz-h2" id="sub-h">
            {sub.planKey}
          </h2>
          <p className="nz-row">
            <Badge tone={statusTone(sub.status)}>
              {tDynamic(locale, `sub.status.${sub.status}`, sub.status)}
            </Badge>
            {sub.cancelAtPeriodEnd && (
              <Badge tone="warn">
                {t(locale, 'sub.cancelsOn', { date: sub.currentPeriodEnd })}
              </Badge>
            )}
          </p>
          <p>
            {t(locale, 'sub.col.amount')}:{' '}
            <Ltr>{formatMinor(sub.amountPerPeriodMinor, sub.currency, locale)}</Ltr> ×{' '}
            <Ltr>{String(sub.quantity)}</Ltr>
          </p>
          <p>
            {t(locale, 'sub.col.period')}:{' '}
            <Ltr>{`${sub.currentPeriodStart} → ${sub.currentPeriodEnd}`}</Ltr>
          </p>
          {sub.status !== 'cancelled' && !sub.cancelAtPeriodEnd && (
            <p>{t(locale, 'sub.renews', { date: sub.currentPeriodEnd })}</p>
          )}
        </Card>
        {sub.status !== 'cancelled' && plans && (
          <SubscriptionActions
            locale={locale}
            id={sub.id}
            version={sub.version}
            currency={sub.currency}
            planVersionId={sub.planVersionId}
            quantity={sub.quantity}
            plans={plans.items.flatMap((p) =>
              'version' in p && p.version
                ? [{ key: p.key, name: p.name[locale], versionId: p.version.id }]
                : [],
            )}
            cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
            periodEnd={sub.currentPeriodEnd}
            canManage={s.can('billing:manage')}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
        )}
        <p>
          <ButtonLink variant="secondary" href={`/billing/plans#subscriptions`}>
            {t(locale, 'sub.title')}
          </ButtonLink>
        </p>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'sub.detail.title')}</PageTitle>
      <BillingTabs locale={locale} current="subscriptions" can={s.can} />
      {body}
    </>
  );
}
