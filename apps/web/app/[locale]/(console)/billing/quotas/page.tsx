import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { trimDec } from '../../../../../lib/billing';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Quotas({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/quotas', {})),
    (q) => (
      <>
        {q.restricted && (
          <p role="alert" className="nz-error-text">
            {t(locale, 'bill.quotas.restricted')}
          </p>
        )}
        {q.items.length === 0 ? (
          <EmptyState title={t(locale, 'bill.quotas.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'bill.quotas.title')}
            rows={q.items}
            rowKey={(i) => i.meterGroup}
            columns={[
              {
                key: 'g',
                header: t(locale, 'bill.f.group'),
                render: (i) => <Ltr>{i.meterGroup}</Ltr>,
              },
              {
                key: 'u',
                header: t(locale, 'bill.f.used'),
                render: (i) =>
                  i.measured ? (
                    <Ltr>{`${trimDec(i.used)} / ${i.limit === null ? t(locale, 'bill.unlimited') : trimDec(i.limit)}${i.unit ? ` ${i.unit}` : ''}`}</Ltr>
                  ) : (
                    t(locale, 'bill.quotas.unmeasured')
                  ),
              },
              {
                key: 'g2',
                header: t(locale, 'bill.tab.quotas'),
                render: (i) =>
                  i.measured && i.percent !== null ? (
                    <Meter
                      label={t(locale, 'bill.quotas.meter', { group: i.meterGroup })}
                      percent={i.percent}
                    />
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'm',
                header: t(locale, 'bill.f.mode'),
                render: (i) => tDynamic(locale, `bill.mode.${i.mode}`, i.mode),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (i) => (
                  <Badge
                    tone={i.state === 'ok' ? 'success' : i.state === 'soft' ? 'warn' : 'danger'}
                  >
                    {tDynamic(locale, `bill.state.${i.state}`, i.state)}
                  </Badge>
                ),
              },
            ]}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.quotas.title')}</PageTitle>
      <BillingTabs locale={locale} current="quotas" can={s.can} />
      {body}
    </>
  );
}
