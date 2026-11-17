import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, Card, Ltr, PageTitle, Table } from '@nuzm/ui';
import { trimDec } from '../../../../../../lib/billing';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/**
 * UI-M03-11: checkout of a quote. Reviewing the quote and the spend-approval state works; PAYING a quote does not exist yet (the API pays
 * invoices and top-ups; quotes become orders and invoices in M05), and this screen says so instead of faking a payment.
 */
export default async function Checkout({
  params,
}: {
  params: Promise<{ locale: string; quoteId: string }>;
}) {
  const { locale, quoteId } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      try {
        return await unwrap(s.api.GET('/v1/quotes/{id}', { params: { path: { id: quoteId } } }));
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    (q) => (
      <>
        <p className="nz-row">
          <Badge tone={q.status === 'issued' ? 'success' : 'danger'}>
            {q.status === 'issued' ? formatDateTime(q.expiresAt, locale) : t(locale, 'chk.expired')}
          </Badge>
        </p>
        {q.status !== 'issued' && <Banner tone="danger">{t(locale, 'chk.expired')}</Banner>}
        {q.requiresApproval && (
          <Banner tone="warn">
            {t(locale, 'chk.needsApproval')}{' '}
            <a href={`/${locale}/billing/approvals`}>{t(locale, 'chk.approvals')}</a>
          </Banner>
        )}
        <h2 className="nz-h2">{t(locale, 'chk.review')}</h2>
        <Table
          caption={t(locale, 'chk.review')}
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
              key: 'a',
              header: t(locale, 'bill.f.amount'),
              render: (i) => <Ltr>{formatMinor(i.amountMinor, q.currency, locale)}</Ltr>,
            },
          ]}
        />
        <Card aria-labelledby="c-tot">
          <h2 className="nz-h2" id="c-tot">
            {t(locale, 'chk.total')}
          </h2>
          <p>
            <strong>
              <Ltr>{formatMinor(q.totalMinor, q.currency, locale)}</Ltr>
            </strong>
          </p>
        </Card>
        <p className="nz-muted">{t(locale, 'chk.notPayable')}</p>
        <div className="nz-row">
          <ButtonLink variant="secondary" href={`/${locale}/billing/quotes/${q.id}`}>
            {t(locale, 'chk.backToQuote')}
          </ButtonLink>
          <ButtonLink variant="secondary" href={`/${locale}/billing/invoices`}>
            {t(locale, 'chk.invoices')}
          </ButtonLink>
        </div>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'chk.title')}</PageTitle>
      {body}
    </>
  );
}
