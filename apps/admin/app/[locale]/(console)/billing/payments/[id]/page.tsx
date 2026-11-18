import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../../components/BillingAdminTabs';
import { eventTone, isUuid } from '../../../../../../lib/finance';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/**
 * UI-M03-14 (detail): the provider events stored for one payment, redacted by the API (whitelist payload, masked provider reference), with the
 * duplicate-event indicator: a provider may resend an event, and it is processed once however often it comes.
 */
export default async function PaymentEvents({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/billing/payments/{id}/events', { params: { path: { id } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'af.pay.detail.none')}
          body={t(locale, 'af.pay.detail.noneBody')}
        />
      ) : (
        <Table
          caption={t(locale, 'af.pay.detail.title')}
          rows={data.items}
          rowKey={(e) => e.id}
          columns={[
            {
              key: 't',
              header: t(locale, 'af.pay.ev.col.type'),
              render: (e) => <Ltr>{e.type}</Ltr>,
            },
            {
              key: 'i',
              header: t(locale, 'af.pay.ev.col.eventId'),
              render: (e) => <Ltr>{e.eventId}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'af.pay.ev.col.status'),
              render: (e) => (
                <>
                  <Badge tone={eventTone(e.status)}>
                    {tDynamic(locale, `af.pay.ev.status.${e.status}`, e.status)}
                  </Badge>
                  {e.error && (
                    <>
                      <br />
                      <span className="nz-muted">
                        <Ltr>{e.error}</Ltr>
                      </span>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'a',
              header: t(locale, 'af.pay.ev.col.at'),
              render: (e) => formatDateTime(e.eventAt, locale),
            },
            {
              key: 'r',
              header: t(locale, 'af.pay.ev.col.received'),
              render: (e) => formatDateTime(e.receivedAt, locale),
            },
            {
              key: 'd',
              header: t(locale, 'af.pay.ev.col.duplicates'),
              render: (e) =>
                e.duplicateCount > 0 ? (
                  <>
                    <Badge tone="warn">
                      {t(locale, 'af.pay.ev.dup', { count: e.duplicateCount })}
                    </Badge>
                    {e.lastDuplicateAt && (
                      <>
                        <br />
                        <span className="nz-muted">
                          {formatDateTime(e.lastDuplicateAt, locale)}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="nz-muted">{t(locale, 'af.pay.ev.noDup')}</span>
                ),
            },
            {
              key: 'p',
              header: t(locale, 'af.pay.ev.col.payload'),
              render: (e) => (
                <Ltr>
                  <code>{JSON.stringify(e.payload)}</code>
                </Ltr>
              ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.pay.detail.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="payments" can={s.can} />
      <p>
        <Ltr>{id}</Ltr>
      </p>
      <p className="nz-muted">{t(locale, 'af.pay.detail.redaction')}</p>
      <p className="nz-muted">{t(locale, 'af.pay.ev.dupHelp')}</p>
      <p className="nz-row">
        <ButtonLink variant="secondary" href={`/${locale}/billing/payments`}>
          {t(locale, 'af.pay.detail.back')}
        </ButtonLink>
        {s.can('admin:billing:manage') && (
          <ButtonLink variant="secondary" href={`/${locale}/billing/refunds?paymentId=${id}`}>
            {t(locale, 'af.pay.detail.refund')}
          </ButtonLink>
        )}
      </p>
      {body}
    </>
  );
}
