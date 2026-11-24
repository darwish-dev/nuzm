import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Card, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../../components/BillingTabs';
import { statusTone } from '../../../../../../lib/payments';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M03-07 (detail): the credit note, the invoice it corrects and the lines it credits. */
export default async function CreditNotePage({
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
        return await unwrap(
          s.api.GET('/v1/billing/credit-notes/{id}', { params: { path: { id } } }),
        );
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    (c) => (
      <>
        <p className="nz-row">
          <Badge tone={statusTone(c.status)}>
            {tDynamic(locale, `cn.status.${c.status}`, c.status)}
          </Badge>
          {c.environment === 'sandbox' && <Badge tone="warn">{t(locale, 'inv.sandbox')}</Badge>}
        </p>
        <Card aria-labelledby="cn-h">
          <h2 className="nz-h2" id="cn-h">
            <Ltr>{c.number}</Ltr>
          </h2>
          <p>
            {t(locale, 'cn.forInvoice', { number: c.invoiceNumber })}{' '}
            <a href={`/billing/invoices/${c.invoiceId}`}>{c.invoiceNumber}</a>
          </p>
          <p>{c.reason}</p>
          <p>{formatDateTime(c.issuedAt, locale)}</p>
          <p>
            <strong>
              {t(locale, 'cn.col.total')}:{' '}
              <Ltr>{formatMinor(c.totalMinor, c.currency, locale)}</Ltr>
            </strong>
          </p>
        </Card>
        <h2 className="nz-h2">{t(locale, 'cn.lines')}</h2>
        <Table
          caption={t(locale, 'cn.lines')}
          rows={c.lines}
          rowKey={(l) => l.invoiceLineId}
          columns={[
            { key: 'p', header: '#', render: (l) => <Ltr>{String(l.position)}</Ltr> },
            {
              key: 'n',
              header: t(locale, 'inv.col.net'),
              render: (l) => <Ltr>{formatMinor(l.netMinor, c.currency, locale)}</Ltr>,
            },
            {
              key: 't',
              header: t(locale, 'inv.col.tax'),
              icon: 'tag',
              render: (l) => <Ltr>{formatMinor(l.taxMinor, c.currency, locale)}</Ltr>,
            },
          ]}
        />
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
