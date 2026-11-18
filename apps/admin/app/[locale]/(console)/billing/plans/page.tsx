import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function AdminPlans({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(s.api.GET('/v1/admin/billing/plans', { params: { query: { limit: 50 } } })),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'abill.plans.title')}
          rows={page.items}
          rowKey={(p) => p.id}
          columns={[
            { key: 'k', header: t(locale, 'abill.f.key'), render: (p) => <Ltr>{p.key}</Ltr> },
            {
              key: 'n',
              header: t(locale, 'field.name'),
              render: (p) => `${p.name.ar ?? ''} / ${p.name.en ?? ''}`,
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (p) => (
                <>
                  {p.status}{' '}
                  {p.placeholder && (
                    <Badge tone="warn">{t(locale, 'bill.plans.placeholder')}</Badge>
                  )}
                </>
              ),
            },
            {
              key: 'v',
              header: t(locale, 'abill.f.versions'),
              icon: 'code',
              render: (p) => (
                <ul>
                  {p.versions.map((v) => (
                    <li key={v.id}>
                      <Ltr>{`v${v.version} ${v.status}`}</Ltr>
                      {v.entitlements.length > 0 && (
                        <span className="nz-muted">
                          {' '}
                          {t(locale, 'abill.plans.limits')}:{' '}
                          <Ltr>
                            {v.entitlements
                              .map(
                                (e) =>
                                  `${e.meterGroup ?? e.featureKey}${e.limit ? `=${e.limit}` : ''}`,
                              )
                              .join(', ')}
                          </Ltr>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'abill.plans.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="plans" can={s.can} />
      {body}
    </>
  );
}
