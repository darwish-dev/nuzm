import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { CreateMeterForm } from '../../../../../components/BillingAdminPanels';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function Meters({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () => await unwrap(s.api.GET('/v1/admin/meters', {})),
    (page) =>
      page.items.length === 0 ? (
        <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'abill.meters.title')}
          rows={page.items}
          rowKey={(m) => m.id}
          columns={[
            { key: 'i', header: t(locale, 'abill.f.meterId'), render: (m) => <Ltr>{m.id}</Ltr> },
            { key: 'u', header: t(locale, 'abill.f.unit'), render: (m) => <Ltr>{m.unit}</Ltr> },
            { key: 'w', header: t(locale, 'abill.f.window'), render: (m) => m.aggregationWindow },
            { key: 'b', header: t(locale, 'abill.f.basis'), render: (m) => m.basis },
            {
              key: 'd',
              header: t(locale, 'abill.f.dims'),
              icon: 'data',
              render: (m) => <Ltr>{m.dimensionsAllowed.join(', ')}</Ltr>,
            },
            {
              key: 'e',
              header: t(locale, 'abill.meters.hasEvents'),
              icon: 'data',
              render: (m) => (m.hasEvents ? <Badge tone="success">✓</Badge> : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'abill.meters.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="meters" can={s.can} />
      {s.can('admin:meters:manage') && (
        <CreateMeterForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      )}
      {body}
    </>
  );
}
