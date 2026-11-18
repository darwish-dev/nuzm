import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../components/HostingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-15: node agents (state, version, last seen). Enrolment tokens and the command-log viewer are API-only for now (NOT BUILT here). */
export default async function Agents({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:hosting:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.admin.agents')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/hosting/agents', {})),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.admin.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.admin.agents')}
          rows={data.items}
          rowKey={(a) => a.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'host.col.node'),
              render: (a) => <Ltr>{a.nodeName}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              render: (a) => (
                <Badge
                  tone={
                    a.state === 'enrolled' ? 'success' : a.state === 'revoked' ? 'danger' : 'warn'
                  }
                >
                  {a.state}
                </Badge>
              ),
            },
            {
              key: 'v',
              header: t(locale, 'host.col.version'),
              render: (a) => <Ltr>{a.version ?? '—'}</Ltr>,
            },
            {
              key: 'l',
              header: t(locale, 'host.col.seen'),
              render: (a) => (a.lastSeenAt ? <Ltr>{a.lastSeenAt.slice(0, 16)}</Ltr> : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.agents')}</PageTitle>
      <HostingAdminTabs locale={locale} current="agents" />
      {body}
    </>
  );
}
