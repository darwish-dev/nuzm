import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ForbiddenState, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { HostingTabs } from '../../../../../../components/HostingTabs';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M06-04: overview with the creating / failed / suspended / restoring / deleting banners and the quota gauges. */
export default async function Site({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.can('hosting:site:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => ({
      site: await unwrap(s.api.GET('/v1/hosting/sites/{id}', { params: { path: { id } } })),
    }),
    ({ site }) => (
      <>
        {site.status === 'creating' && (
          <Banner tone="warn">{t(locale, 'host.banner.creating')}</Banner>
        )}
        {site.status === 'failed' && (
          <Banner tone="danger">
            {t(locale, 'host.banner.failed', { reason: site.failureReason ?? '—' })}
          </Banner>
        )}
        {site.status === 'suspended' && (
          <Banner tone="danger">
            {t(locale, 'host.banner.suspended', { reason: site.suspension?.reason ?? '—' })}
          </Banner>
        )}
        {site.status === 'restoring' && (
          <Banner tone="warn">{t(locale, 'host.banner.restoring')}</Banner>
        )}
        {site.status === 'deleting' && (
          <Banner tone="warn">{t(locale, 'host.banner.deleting')}</Banner>
        )}
        <p>
          <Badge
            tone={
              site.status === 'active' ? 'success' : site.status === 'failed' ? 'danger' : 'warn'
            }
          >
            {tDynamic(locale, `host.status.${site.status}`, site.status)}
          </Badge>{' '}
          <Ltr>{`${site.runtime} · ${site.dataRegion}`}</Ltr>
        </p>
        <Table
          caption={t(locale, 'host.usage.title')}
          rows={site.quotas}
          rowKey={(q) => q.dim}
          columns={[
            { key: 'd', header: t(locale, 'host.col.dim'), render: (q) => <Ltr>{q.dim}</Ltr> },
            {
              key: 'l',
              header: t(locale, 'host.col.quota'),
              render: (q) => <Ltr>{`${q.soft} / ${q.limit}`}</Ltr>,
            },
            {
              key: 'm',
              header: t(locale, 'host.tab.usage'),
              render: (q) => (
                <Meter label={t(locale, 'host.usage.meter', { dim: q.dim })} percent={0} />
              ),
            },
          ]}
        />
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.title.site', { name: id.slice(0, 8) })}</PageTitle>
      <HostingTabs locale={locale} siteId={id} current="overview" />
      {body}
    </>
  );
}
