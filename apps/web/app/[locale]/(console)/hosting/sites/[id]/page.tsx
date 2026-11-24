import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ForbiddenState, Icon, Ltr, PageTitle, type IconName } from '@nuzm/ui';
import { HostingInsights } from '../../../../../../components/HostingInsights';
import { REASON_KEY, SITE_TOOLS, type ToolReason } from '../../../../../../lib/hosting-tools';
import { DeleteSiteForm } from '../../../../../../components/HostingControls';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M06-04: the website overview: a header with the key facts, resource cards, and cards that open every part of the site. */
export default async function Site({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const back = (
    <a className="nzc-back" href={`/hosting/sites`}>
      <Icon name="chevron" size={16} />
      {t(locale, 'host.title.sites')}
    </a>
  );
  if (!s.can('hosting:site:read'))
    return (
      <>
        {back}
        <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const base = `/hosting/sites/${id}`;
  const body = await view(
    locale,
    async () => ({
      site: await unwrap(s.api.GET('/v1/hosting/sites/{id}', { params: { path: { id } } })),
      // the API's own answer to "which tools work for this website, role, plan, panel version and connection now?" (a failure shows every tool as unavailable, never as open)
      tools: await unwrap(
        s.api.GET('/v1/hosting/sites/{id}/tools', { params: { path: { id } } }),
      ).catch(() => null),
    }),
    ({ site, tools }) => {
      const used: Record<string, number | undefined> = {
        disk_mb: site.usageSummary?.diskMb,
        inodes: site.usageSummary?.inodes,
      };
      const limit = (dim: string) => site.quotas.find((q) => q.dim === dim)?.limit ?? null;
      const parts: [string, IconName, Parameters<typeof t>[1], Parameters<typeof t>[1]][] = [
        ['domains', 'domains', 'host.tab.domains', 'host.card.domains'],
        ['ssl', 'shield', 'host.tab.ssl', 'host.card.ssl'],
        ['backups', 'cloud', 'host.tab.backups', 'host.card.backups'],
        ['databases', 'data', 'host.tab.databases', 'host.card.databases'],
        ['usage', 'dashboard', 'host.tab.usage', 'host.card.usage'],
      ];
      const tone =
        site.status === 'active' ? 'success' : site.status === 'failed' ? 'danger' : 'warn';
      return (
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

          <header className="nzc-site-hero">
            <div className="nzc-site-hero-main">
              <h2>{site.name}</h2>
              <Badge tone={tone}>
                {tDynamic(locale, `host.status.${site.status}`, site.status)}
              </Badge>
            </div>
            <dl className="nzc-site-facts">
              <div>
                <dt>{t(locale, 'host.col.domain')}</dt>
                <dd>{site.primaryDomain ? <Ltr>{site.primaryDomain}</Ltr> : '—'}</dd>
              </div>
              <div>
                <dt>{t(locale, 'host.col.plan')}</dt>
                <dd>
                  {site.plan.name[locale]} · <Ltr>{site.runtime}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'host.col.region')}</dt>
                <dd>
                  <Ltr>{site.dataRegion}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'host.col.created')}</dt>
                <dd>{formatDateTime(site.createdAt, locale)}</dd>
              </div>
            </dl>
            {site.primaryDomain && site.status === 'active' && (
              <a className="nz-btn" data-variant="secondary" href={`https://${site.primaryDomain}`}>
                {t(locale, 'host.visit')}
                <Icon name="arrow" size={15} />
              </a>
            )}
          </header>

          <HostingInsights
            locale={locale}
            site={{
              runtime: site.runtime,
              planName: site.plan.name[locale],
              domains: site.domains,
              limits: Object.fromEntries(site.quotas.map((q) => [q.dim, q.limit])),
              used,
              diskLimitMb: limit('disk_mb'),
              diskUsedMb: used.disk_mb,
            }}
          />

          <section aria-labelledby="site-manage">
            <h2 className="nzc-section-title" id="site-manage">
              {t(locale, 'host.ov.title', { name: site.name })}
            </h2>
            <div className="nzc-site-tiles">
              {parts.map(([path, icon, title, desc]) => (
                <a key={path} className="nzc-site-tile" href={`${base}/${path}`}>
                  <span className="nzc-site-tile-ico" aria-hidden="true">
                    <Icon name={icon} size={22} />
                  </span>
                  <strong>{t(locale, title)}</strong>
                  <span className="nz-muted">{t(locale, desc)}</span>
                  <span className="nzc-site-tile-go">
                    {t(locale, 'host.ov.open')} <Icon name="arrow" size={14} />
                  </span>
                </a>
              ))}
            </div>
          </section>

          <section aria-labelledby="site-tools">
            <h2 className="nzc-section-title" id="site-tools">
              {t(locale, 'host.ov.tools')}
            </h2>
            <div className="nzc-tool-tiles">
              {SITE_TOOLS.map((tool) => {
                const cap = tools?.tools.find((c) => c.id === tool.id);
                const open = cap?.state === 'available';
                const inner = (
                  <>
                    <span className="nzc-site-tile-ico" aria-hidden="true">
                      <Icon name={tool.icon} size={20} />
                    </span>
                    <strong>{t(locale, tool.title)}</strong>
                    <span className="nz-muted">{t(locale, tool.desc)}</span>
                    {open ? (
                      <span className="nzc-site-tile-go">
                        {t(locale, 'ht.open')} <Icon name="arrow" size={14} />
                      </span>
                    ) : (
                      <Badge tone="warn">
                        {t(locale, REASON_KEY[(cap?.reason ?? 'connection') as ToolReason])}
                      </Badge>
                    )}
                  </>
                );
                return open ? (
                  <a key={tool.id} className="nzc-tool-tile" href={`${base}/${tool.path}`}>
                    {inner}
                  </a>
                ) : (
                  <div key={tool.id} className="nzc-tool-tile" aria-disabled="true">
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>

          {s.can('hosting:site:delete') && site.status !== 'deleting' && (
            <details className="nzc-danger-zone">
              <summary>{t(locale, 'host.ctl.del.open')}</summary>
              <DeleteSiteForm
                locale={locale}
                siteId={id}
                siteName={site.name}
                mfaFactorId={s.me.mfaFactorId ?? null}
              />
            </details>
          )}
        </>
      );
    },
  );
  return (
    <>
      {back}
      <PageTitle>{t(locale, 'host.tab.overview')}</PageTitle>
      {body}
    </>
  );
}
