import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../components/HostingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-11: nodes, their health and agent state. Changing status / overcommit is done through the API (the dual-approval modal is NOT BUILT yet). */
export default async function Nodes({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
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
    () => unwrap(s.api.GET('/v1/admin/hosting/nodes', { params: { query: {} } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.admin.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.admin.nodes')}
          rows={data.items}
          rowKey={(n) => n.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'host.col.node'),
              icon: 'globe',
              render: (n) => (
                <a href={`/${locale}/hosting/nodes/${n.id}`}>
                  <Ltr>{n.name}</Ltr>
                </a>
              ),
            },
            {
              key: 'g',
              header: t(locale, 'host.col.region'),
              icon: 'pin',
              render: (n) => <Ltr>{n.dataRegion}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              icon: 'pulse',
              render: (n) => (
                <Badge
                  tone={
                    n.status === 'active' ? 'success' : n.status === 'retired' ? 'danger' : 'warn'
                  }
                >
                  {n.status}
                </Badge>
              ),
            },
            {
              key: 'h',
              header: t(locale, 'host.col.health'),
              icon: 'pulse',
              render: (n) => (
                <Badge tone={n.health === 'healthy' ? 'success' : 'warn'}>{n.health}</Badge>
              ),
            },
            {
              key: 'a',
              icon: 'globe',
              header: t(locale, 'host.col.agent'),
              render: (n) => n.agentState ?? '—',
            },
            {
              key: 'v',
              header: t(locale, 'host.col.version'),
              icon: 'code',
              render: (n) => <Ltr>{n.cloudpanelVersion ?? '—'}</Ltr>,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.nodes')}</PageTitle>
      <HostingAdminTabs locale={locale} current="nodes" />
      {body}
    </>
  );
}
