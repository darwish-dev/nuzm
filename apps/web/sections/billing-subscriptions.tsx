import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../components/BillingTabs';
import { SubscribeForm } from '../components/PaymentsPanels';
import { statusTone } from '../lib/payments';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M03-03: subscriptions with status, amount and next renewal; subscribe when there is none. */
export default async function Subscriptions({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      const subs = await unwrap(
        s.api.GET('/v1/billing/subscriptions', { params: { query: { limit: 25 } } }),
      );
      const live = subs.items.some((x) => x.status !== 'cancelled');
      const [plans, methods] =
        live || !s.can('billing:manage')
          ? [null, null]
          : await Promise.all([
              unwrap(s.api.GET('/v1/billing/plans', {})),
              unwrap(s.api.GET('/v1/billing/payment-methods', {})),
            ]);
      return { subs, live, plans, methods };
    },
    ({ subs, live, plans, methods }) => (
      <>
        {subs.items.length === 0 ? (
          <EmptyState title={t(locale, 'sub.none')} body={t(locale, 'sub.noneBody')} />
        ) : (
          <Table
            caption={t(locale, 'sub.title')}
            rows={subs.items}
            rowKey={(x) => x.id}
            rowHref={(x) => `/billing/subscriptions/${x.id}`}
            manageLabel={t(locale, 'action.manage')}
            columns={[
              {
                key: 'p',
                header: t(locale, 'sub.col.plan'),
                icon: 'tag',
                render: (x) => <a href={`/billing/subscriptions/${x.id}`}>{x.planKey}</a>,
              },
              {
                key: 's',
                header: t(locale, 'sub.col.status'),
                icon: 'pulse',
                render: (x) => (
                  <span className="nz-row">
                    <Badge tone={statusTone(x.status)}>
                      {tDynamic(locale, `sub.status.${x.status}`, x.status)}
                    </Badge>
                    {x.dunningStage && (
                      <Badge tone="danger">
                        {tDynamic(locale, `sub.dunning.stage.${x.dunningStage}`, x.dunningStage)}
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                key: 'a',
                header: t(locale, 'sub.col.amount'),
                icon: 'tag',
                render: (x) => <Ltr>{formatMinor(x.amountPerPeriodMinor, x.currency, locale)}</Ltr>,
              },
              {
                key: 'r',
                header: t(locale, 'sub.col.renews'),
                icon: 'refresh',
                render: (x) => (x.status === 'cancelled' ? '—' : <Ltr>{x.currentPeriodEnd}</Ltr>),
              },
            ]}
          />
        )}
        {!live && plans && methods && (
          <SubscribeForm
            locale={locale}
            plans={plans.items.flatMap((p) =>
              'version' in p && p.version
                ? [{ key: p.key, name: p.name[locale], versionId: p.version.id }]
                : [],
            )}
            methods={methods.items}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'sub.title')}</PageTitle>
      <BillingTabs locale={locale} current="subscriptions" can={s.can} />
      {body}
    </>
  );
}
