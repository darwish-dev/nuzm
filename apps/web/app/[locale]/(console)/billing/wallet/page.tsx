import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import { Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { TopupForm } from '../../../../../components/PaymentsPanels';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M03-09: the prepaid wallet: balance, top-up, and the consumption ledger. */
export default async function Wallet({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      const [balance, ledger, methods] = await Promise.all([
        unwrap(s.api.GET('/v1/billing/balance', {})),
        unwrap(s.api.GET('/v1/billing/ledger', { params: { query: { limit: 25 } } })),
        s.can('billing:manage')
          ? unwrap(s.api.GET('/v1/billing/payment-methods', {}))
          : Promise.resolve(null),
      ]);
      return { balance, ledger, methods };
    },
    ({ balance, ledger, methods }) => (
      <>
        <Card aria-labelledby="w-bal">
          <h2 className="nz-h2" id="w-bal">
            {t(locale, 'wallet.balance')}
          </h2>
          {balance.balances.length === 0 ? (
            <p className="nz-muted">{t(locale, 'wallet.none')}</p>
          ) : (
            balance.balances.map((b) => (
              <p key={b.currency}>
                <strong>
                  <Ltr>{formatMinor(b.balanceMinor, b.currency, locale)}</Ltr>
                </strong>
              </p>
            ))
          )}
          <p className="nz-muted">{t(locale, 'wallet.vat')}</p>
        </Card>
        {methods && (
          <TopupForm
            locale={locale}
            methods={methods.items}
            minMinor={process.env.WALLET_TOPUP_MIN_MINOR ?? '1000'}
            maxMinor={process.env.WALLET_TOPUP_MAX_MINOR ?? '10000000'}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
        )}
        <h2 className="nz-h2">{t(locale, 'wallet.activity')}</h2>
        {ledger.items.length === 0 ? (
          <EmptyState title={t(locale, 'wallet.noActivity')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'wallet.activity')}
            rows={ledger.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'w',
                header: t(locale, 'wallet.col.date'),
                render: (r) => formatDateTime(r.occurredAt, locale),
              },
              {
                key: 'd',
                header: t(locale, 'wallet.col.description'),
                render: (r) => r.description,
              },
              {
                key: 'a',
                header: t(locale, 'wallet.col.amount'),
                render: (r) => (
                  <Ltr>{`${r.direction === 'credit' ? '+' : '−'}${formatMinor(r.amountMinor, r.currency, locale)}`}</Ltr>
                ),
              },
              {
                key: 'b',
                header: t(locale, 'wallet.col.balance'),
                render: (r) => <Ltr>{formatMinor(r.balanceMinor, r.currency, locale)}</Ltr>,
              },
            ]}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'wallet.title')}</PageTitle>
      <BillingTabs locale={locale} current="wallet" can={s.can} />
      {body}
    </>
  );
}
