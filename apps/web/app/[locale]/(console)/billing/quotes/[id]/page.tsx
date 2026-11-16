import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import { Badge, Card, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ExpiryCountdown, QuoteApprovalButton } from '../../../../../../components/BillingPanels';
import { trimDec } from '../../../../../../lib/billing';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

export default async function QuotePage({
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
        return await unwrap(s.api.GET('/v1/quotes/{id}', { params: { path: { id } } }));
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    (q) => (
      <>
        <p className="nz-row">
          <Badge>{q.kind}</Badge>
          <Badge tone={q.status === 'issued' ? 'success' : 'danger'}>
            {q.status === 'issued'
              ? formatDateTime(q.expiresAt, locale)
              : t(locale, 'bill.quote.expired')}
          </Badge>
          <Badge tone="warn">{q.taxEstimate.status}</Badge>
        </p>
        {q.status === 'issued' && <ExpiryCountdown locale={locale} expiresAt={q.expiresAt} />}
        <Table
          caption={t(locale, 'bill.quote.title')}
          rows={q.items}
          rowKey={(i) => String(i.position)}
          columns={[
            { key: 'd', header: t(locale, 'bill.f.item'), render: (i) => i.description },
            {
              key: 'q',
              header: t(locale, 'bill.f.quantity'),
              render: (i) => <Ltr>{`${trimDec(i.quantity)} ${i.unit}`}</Ltr>,
            },
            {
              key: 'p',
              header: t(locale, 'bill.f.unitPrice'),
              render: (i) => (i.unitPriceMinor ? <Ltr>{trimDec(i.unitPriceMinor)}</Ltr> : '—'),
            },
            {
              key: 'a',
              header: t(locale, 'bill.f.amount'),
              render: (i) => <Ltr>{formatMinor(i.amountMinor, q.currency, locale)}</Ltr>,
            },
          ]}
        />
        <Card aria-label={t(locale, 'bill.f.total')}>
          <dl>
            <dt>{t(locale, 'bill.f.subtotal')}</dt>
            <dd>
              <Ltr>{formatMinor(q.subtotalMinor, q.currency, locale)}</Ltr>
            </dd>
            <dt>{t(locale, 'bill.f.tax')}</dt>
            <dd>
              <Ltr>{formatMinor(q.taxEstimate.taxMinor, q.currency, locale)}</Ltr>
            </dd>
            <dt>{t(locale, 'bill.f.total')}</dt>
            <dd>
              <strong>
                <Ltr>{formatMinor(q.totalMinor, q.currency, locale)}</Ltr>
              </strong>
            </dd>
          </dl>
          <p className="nz-muted">{t(locale, 'bill.quote.provisional')}</p>
          <p className="nz-muted">{t(locale, 'bill.quote.residency')}</p>
        </Card>
        {q.requiresApproval && q.status === 'issued' && (
          <Card role="alert">
            <p>{t(locale, 'bill.quote.needsApproval')}</p>
            {s.can('spend:request') && (
              <QuoteApprovalButton
                locale={locale}
                quoteId={q.id}
                amountMinor={q.totalMinor}
                currency={q.currency}
                mfaFactorId={s.me.mfaFactorId ?? null}
              />
            )}
          </Card>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.quote.title')}</PageTitle>
      {body}
    </>
  );
}
