import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../../components/HostingAdminTabs';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M06-12: capacity by dimension (sellable / reserved / free) of one node. Drain / maintenance controls are NOT BUILT here (the PATCH exists). */
export default async function Node({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:hosting:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.admin.nodes')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/hosting/nodes/{id}/capacity', { params: { path: { id } } })),
    (cap) => (
      <Table
        caption={t(locale, 'host.admin.capacity')}
        rows={cap.dimensions}
        rowKey={(d) => d.dim}
        columns={[
          { key: 'd', header: t(locale, 'host.col.dim'), render: (d) => <Ltr>{d.dim}</Ltr> },
          {
            key: 's',
            header: t(locale, 'host.col.sellable'),
            render: (d) => <Ltr>{d.sellable}</Ltr>,
          },
          {
            key: 'r',
            header: t(locale, 'host.col.reserved'),
            render: (d) => <Ltr>{d.reserved}</Ltr>,
          },
          { key: 'f', header: t(locale, 'host.col.free'), render: (d) => <Ltr>{d.free}</Ltr> },
          {
            key: 'm',
            header: t(locale, 'host.col.quota'),
            render: (d) => (
              <Meter
                label={t(locale, 'host.usage.meter', { dim: d.dim })}
                percent={d.sellable > 0 ? (d.reserved / d.sellable) * 100 : 0}
              />
            ),
          },
        ]}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.node', { name: id.slice(0, 8) })}</PageTitle>
      <HostingAdminTabs locale={locale} current="nodes" />
      {body}
    </>
  );
}
