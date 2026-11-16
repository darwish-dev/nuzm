import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { trimDec } from '../../../../../lib/billing';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Plans({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => ({
      plans: await unwrap(s.api.GET('/v1/billing/plans', {})),
      ent: await unwrap(s.api.GET('/v1/billing/entitlements', {})),
    }),
    ({ plans, ent }) => (
      <>
        <p>
          {ent.plan.source === 'default'
            ? t(locale, 'bill.plans.default')
            : t(locale, 'bill.plans.current', { plan: ent.plan.key })}
        </p>
        <div className="nz-grid">
          {plans.items.map((p) => (
            <Card key={p.id} aria-labelledby={`plan-${p.key}`}>
              <h2 className="nz-h2" id={`plan-${p.key}`}>
                {p.name[locale]}
              </h2>
              <p className="nz-row">
                {p.key === ent.plan.key && (
                  <Badge tone="success">
                    {t(locale, 'bill.plans.current', { plan: p.name[locale] })}
                  </Badge>
                )}
                {p.placeholder && <Badge tone="warn">{t(locale, 'bill.plans.placeholder')}</Badge>}
              </p>
            </Card>
          ))}
        </div>
        <h2 className="nz-h2">{t(locale, 'bill.plans.limits')}</h2>
        {ent.limits.length === 0 ? (
          <EmptyState title={t(locale, 'bill.plans.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'bill.plans.limits')}
            rows={ent.limits}
            rowKey={(l) => l.meterGroup}
            columns={[
              {
                key: 'g',
                header: t(locale, 'bill.f.group'),
                render: (l) => <Ltr>{l.meterGroup}</Ltr>,
              },
              {
                key: 'l',
                header: t(locale, 'bill.f.limit'),
                render: (l) =>
                  l.limit ? <Ltr>{trimDec(l.limit)}</Ltr> : t(locale, 'bill.unlimited'),
              },
              {
                key: 'm',
                header: t(locale, 'bill.f.mode'),
                render: (l) => tDynamic(locale, `bill.mode.${l.mode}`, l.mode),
              },
              {
                key: 's',
                header: t(locale, 'bill.f.source'),
                render: (l) => tDynamic(locale, `bill.source.${l.source}`, l.source),
              },
            ]}
          />
        )}
        <p className="nz-muted">{t(locale, 'bill.plans.change')}</p>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.plans.title')}</PageTitle>
      <BillingTabs locale={locale} current="plans" can={s.can} />
      {body}
    </>
  );
}
