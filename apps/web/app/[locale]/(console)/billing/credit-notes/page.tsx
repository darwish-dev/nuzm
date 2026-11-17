import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { statusTone } from '../../../../../lib/payments';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M03-07 (list): credit notes with their invoice, reason and status. */
export default async function CreditNotes({
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
        s.api.GET('/v1/billing/credit-notes', {
          params: { query: { limit: 25, cursor: q.cursor || undefined } },
        }),
      ),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'cn.none')} body={t(locale, 'cn.noneBody')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'cn.title')}
            rows={page.items}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'n',
                header: t(locale, 'cn.col.number'),
                render: (c) => (
                  <a href={`/${locale}/billing/credit-notes/${c.id}`}>
                    <Ltr>{c.number}</Ltr>
                  </a>
                ),
              },
              {
                key: 'i',
                header: t(locale, 'cn.col.invoice'),
                render: (c) => (
                  <a href={`/${locale}/billing/invoices/${c.invoiceId}`}>
                    <Ltr>{c.invoiceNumber}</Ltr>
                  </a>
                ),
              },
              { key: 'r', header: t(locale, 'cn.col.reason'), render: (c) => c.reason },
              {
                key: 't',
                header: t(locale, 'cn.col.total'),
                render: (c) => <Ltr>{formatMinor(c.totalMinor, c.currency, locale)}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'cn.col.status'),
                render: (c) => (
                  <Badge tone={statusTone(c.status)}>
                    {tDynamic(locale, `cn.status.${c.status}`, c.status)}
                  </Badge>
                ),
              },
              {
                key: 'd',
                header: t(locale, 'cn.col.issued'),
                render: (c) => formatDateTime(c.issuedAt, locale),
              },
            ]}
          />
          {page.nextCursor && (
            <ButtonLink variant="secondary" href={`?cursor=${page.nextCursor}`}>
              {t(locale, 'action.next')}
            </ButtonLink>
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cn.title')}</PageTitle>
      <BillingTabs locale={locale} current="creditNotes" can={s.can} />
      {body}
    </>
  );
}
