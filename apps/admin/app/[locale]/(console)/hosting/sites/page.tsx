import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../components/HostingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-13: cross-organization site search (the read is audited). Suspend / resume with a reason is done through the API (the form is NOT BUILT yet). */
export default async function Sites({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:hosting:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.admin.sites')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/hosting/sites', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.admin.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          <p>{t(locale, 'host.admin.cross')}</p>
          <Table
            caption={t(locale, 'host.admin.sites')}
            rows={data.items}
            rowKey={(x) => x.id}
            columns={[
              { key: 'n', header: t(locale, 'host.col.name'), render: (x) => x.name },
              {
                key: 'o',
                header: t(locale, 'host.col.org'),
                icon: 'globe',
                render: (x) => <Ltr>{x.orgId ?? '—'}</Ltr>,
              },
              {
                key: 'd',
                header: t(locale, 'host.col.node'),
                icon: 'globe',
                render: (x) => <Ltr>{x.nodeName ?? '—'}</Ltr>,
              },
              {
                key: 'g',
                header: t(locale, 'host.col.region'),
                icon: 'pin',
                render: (x) => <Ltr>{x.dataRegion}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'host.col.status'),
                icon: 'pulse',
                render: (x) => (
                  <Badge
                    tone={
                      x.status === 'active' ? 'success' : x.status === 'failed' ? 'danger' : 'warn'
                    }
                  >
                    {tDynamic(locale, `host.status.${x.status}`, x.status)}
                  </Badge>
                ),
              },
            ]}
          />
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.sites')}</PageTitle>
      <HostingAdminTabs locale={locale} current="sites" />
      {body}
    </>
  );
}
