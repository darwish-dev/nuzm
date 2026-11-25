import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../components/BillingTabs';
import { statusTone } from '../lib/payments';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M03-08: payment history with status and refund state. */
export default async function Payments({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/billing/payments', {
          params: { query: { limit: 25, cursor: q.cursor || undefined } },
        }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'pay.none')} body={t(locale, 'pay.noneBody')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'pay.title')}
            rows={page.items}
            rowKey={(p) => p.id}
            columns={[
              {
                key: 'd',
                header: t(locale, 'pay.col.date'),
                icon: 'calendar',
                render: (p) => formatDateTime(p.createdAt, locale),
              },
              {
                key: 'f',
                header: t(locale, 'pay.col.for'),
                render: (p) =>
                  p.invoiceId ? (
                    <a href={`/billing/invoices/${p.invoiceId}`}>
                      {t(locale, 'pay.for.invoice')}
                    </a>
                  ) : (
                    <a href={`/billing/wallet`}>{t(locale, 'pay.for.topup')}</a>
                  ),
              },
              {
                key: 'a',
                header: t(locale, 'pay.col.amount'),
                icon: 'tag',
                render: (p) => <Ltr>{formatMinor(p.amountMinor, p.currency, locale)}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'inv.col.status'),
                icon: 'pulse',
                render: (p) => (
                  <Badge tone={statusTone(p.status)}>
                    {tDynamic(locale, `pay.status.${p.status}`, p.status)}
                  </Badge>
                ),
              },
              {
                key: 'r',
                header: t(locale, 'pay.col.refunded'),
                render: (p) =>
                  p.refundedMinor === '0' ? (
                    '—'
                  ) : (
                    <Ltr>{formatMinor(p.refundedMinor, p.currency, locale)}</Ltr>
                  ),
              },
            ]}
          />
          {page.nextCursor && (
            <ButtonLink variant="secondary" href={`?cursor=${page.nextCursor}#payments`}>
              {t(locale, 'action.next')}
            </ButtonLink>
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pay.title')}</PageTitle>
      <BillingTabs locale={locale} current="payments" can={s.can} />
      {body}
    </>
  );
}
