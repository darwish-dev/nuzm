import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../components/HostingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-14: the abuse queue. Actions and appeal decisions are done through the API (the action forms are NOT BUILT yet). */
export default async function Abuse({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:hosting:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.admin.abuse')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/hosting/abuse-cases', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.admin.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.admin.abuse')}
          rows={data.items}
          rowKey={(c) => c.id}
          columns={[
            {
              key: 'r',
              header: t(locale, 'host.col.reason'),
              icon: 'globe',
              render: (c) => <Ltr>{c.reasonCode}</Ltr>,
            },
            {
              key: 'v',
              header: t(locale, 'host.col.severity'),
              icon: 'globe',
              render: (c) => (
                <Badge
                  tone={c.severity === 'critical' || c.severity === 'high' ? 'danger' : 'warn'}
                >
                  {c.severity}
                </Badge>
              ),
            },
            {
              key: 's',
              icon: 'pulse',
              header: t(locale, 'host.col.status'),
              render: (c) => c.state,
            },
            {
              key: 'o',
              header: t(locale, 'host.col.org'),
              icon: 'globe',
              render: (c) => <Ltr>{c.orgId ?? '—'}</Ltr>,
            },
            {
              key: 'c',
              header: t(locale, 'host.col.created'),
              icon: 'calendar',
              render: (c) => <Ltr>{c.createdAt.slice(0, 16)}</Ltr>,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.abuse')}</PageTitle>
      <HostingAdminTabs locale={locale} current="abuse" />
      {body}
    </>
  );
}
