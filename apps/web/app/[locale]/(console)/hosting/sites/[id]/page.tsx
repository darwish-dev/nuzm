import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic, type Locale } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  ForbiddenState,
  Icon,
  Ltr,
  Meter,
  PageTitle,
  type IconName,
} from '@nuzm/ui';
import {
  ActionLink,
  ActionPanel,
  ActionRow,
  OverviewLayout,
  Ring,
  SidePanel,
  SummaryCard,
} from '../../../../../../components/Overview';
import { DeleteSiteForm } from '../../../../../../components/HostingControls';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** The resource dimensions in the order a customer reads them, with their label and how to show the numbers. */
const DIMS: { dim: string; label: Parameters<typeof t>[1]; unit: 'mb' | 'gb' | 'n' }[] = [
  { dim: 'disk_mb', label: 'host.usage.disk', unit: 'mb' },
  { dim: 'bandwidth_gb', label: 'host.usage.bandwidth', unit: 'gb' },
  { dim: 'memory_mb', label: 'host.dim.memory', unit: 'mb' },
  { dim: 'inodes', label: 'host.usage.inodes', unit: 'n' },
  { dim: 'processes', label: 'host.dim.processes', unit: 'n' },
  { dim: 'db_count', label: 'host.tab.databases', unit: 'n' },
  { dim: 'backup_count', label: 'host.tab.backups', unit: 'n' },
  { dim: 'backup_gb', label: 'host.usage.backup', unit: 'gb' },
];
const amount = (v: number, unit: 'mb' | 'gb' | 'n', locale: Locale) => {
  const n = (x: number, d = 0) =>
    x.toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-US', { maximumFractionDigits: d });
  if (unit === 'mb') return v >= 1024 ? `${n(v / 1024, 1)} GB` : `${n(v)} MB`;
  if (unit === 'gb') return `${n(v)} GB`;
  return n(v);
};

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
    }),
    ({ site }) => {
      const used: Record<string, number | undefined> = {
        disk_mb: site.usageSummary?.diskMb,
        inodes: site.usageSummary?.inodes,
      };
      const diskQ = site.quotas.find((q) => q.dim === 'disk_mb');
      const diskPct =
        diskQ && used.disk_mb !== undefined && diskQ.limit
          ? (used.disk_mb / diskQ.limit) * 100
          : null;
      const open = t(locale, 'host.ov.open');
      const parts: [string, IconName, Parameters<typeof t>[1], Parameters<typeof t>[1]][] = [
        ['domains', 'domains', 'host.tab.domains', 'host.card.domains'],
        ['ssl', 'shield', 'host.tab.ssl', 'host.card.ssl'],
        ['databases', 'data', 'host.tab.databases', 'host.card.databases'],
        ['backups', 'cloud', 'host.tab.backups', 'host.card.backups'],
        ['usage', 'dashboard', 'host.tab.usage', 'host.card.usage'],
      ];
      // parts of a site the hosting API does not offer yet: listed so the customer knows they are planned, never faked
      const soon: [IconName, Parameters<typeof t>[1], Parameters<typeof t>[1]][] = [
        ['projects', 'host.card.files', 'host.card.files.desc'],
        ['calendar', 'host.card.cron', 'host.card.cron.desc'],
        ['panel', 'host.card.php', 'host.card.php.desc'],
        ['list', 'host.card.logs', 'host.card.logs.desc'],
        ['key', 'host.card.access', 'host.card.access.desc'],
        ['shield', 'host.card.security', 'host.card.security.desc'],
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
          <OverviewLayout
            sideLabel={t(locale, 'host.ov.summary')}
            main={
              <>
                <ActionPanel
                  id="site-manage"
                  title={t(locale, 'host.ov.title', { name: site.name })}
                  sub={t(locale, 'host.ov.sub')}
                >
                  {parts.map(([path, icon, title, desc], i) => (
                    <ActionRow
                      key={path}
                      icon={icon}
                      title={t(locale, title)}
                      desc={t(locale, desc)}
                      featured={i === 0}
                      action={
                        <ActionLink href={`${base}/${path}`} label={open} primary={i === 0} />
                      }
                    />
                  ))}
                </ActionPanel>
                <ActionPanel id="site-soon" title={t(locale, 'host.ov.more')}>
                  {soon.map(([icon, title, desc]) => (
                    <ActionRow
                      key={title}
                      icon={icon}
                      title={t(locale, title)}
                      desc={t(locale, desc)}
                      action={<Badge>{t(locale, 'host.soon')}</Badge>}
                    />
                  ))}
                </ActionPanel>
                {site.quotas.length > 0 && (
                  <section aria-labelledby="site-res">
                    <h2 className="nzc-section-title" id="site-res">
                      {t(locale, 'host.resources')}
                    </h2>
                    <div className="nzc-quotas">
                      {DIMS.map(({ dim, label, unit }) => {
                        const q = site.quotas.find((x) => x.dim === dim);
                        if (!q) return null;
                        const u = used[dim];
                        return (
                          <div key={dim} className="nzc-quota">
                            <span className="nzc-quota-label">{t(locale, label)}</span>
                            <span className="nzc-quota-value">
                              {u === undefined ? (
                                amount(q.limit, unit, locale)
                              ) : (
                                <>
                                  {amount(u, unit, locale)}{' '}
                                  <small>/ {amount(q.limit, unit, locale)}</small>
                                </>
                              )}
                            </span>
                            {u !== undefined && (
                              <Meter
                                label={t(locale, 'host.usage.meter', { dim: t(locale, label) })}
                                percent={q.limit ? (u / q.limit) * 100 : 0}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </>
            }
            side={
              <>
                <SummaryCard
                  name={site.name}
                  link={
                    site.primaryDomain && site.status === 'active'
                      ? `https://${site.primaryDomain}`
                      : undefined
                  }
                  linkLabel={t(locale, 'host.visit')}
                  badges={
                    <Badge tone={tone}>
                      {tDynamic(locale, `host.status.${site.status}`, site.status)}
                    </Badge>
                  }
                  gauge={
                    <>
                      <Ring
                        percent={diskPct ?? 0}
                        value={diskPct === null ? '—' : `${Math.round(diskPct)}%`}
                        caption={t(locale, 'host.ov.disk')}
                        label={
                          diskPct === null
                            ? t(locale, 'host.usage.disk')
                            : t(locale, 'host.ov.diskLabel', { percent: Math.round(diskPct) })
                        }
                        tone={
                          diskPct !== null && diskPct >= 90
                            ? 'danger'
                            : diskPct !== null && diskPct >= 75
                              ? 'warn'
                              : 'accent'
                        }
                      />
                      <dl style={{ margin: 0 }}>
                        <dt>{t(locale, 'host.col.plan')}</dt>
                        <dd>{site.plan.name[locale]}</dd>
                        <dt>{t(locale, 'host.col.runtime')}</dt>
                        <dd style={{ fontSize: 15 }}>
                          <Ltr>{site.runtime}</Ltr>
                        </dd>
                      </dl>
                    </>
                  }
                  rows={[
                    {
                      icon: 'pin',
                      label: t(locale, 'host.col.region'),
                      value: <Ltr>{site.dataRegion}</Ltr>,
                    },
                    {
                      icon: 'globe',
                      label: t(locale, 'host.col.domain'),
                      value: site.primaryDomain ? <Ltr>{site.primaryDomain}</Ltr> : '—',
                    },
                    {
                      icon: 'calendar',
                      label: t(locale, 'host.col.created'),
                      value: formatDateTime(site.createdAt, locale),
                    },
                  ]}
                />
                <SidePanel
                  title={t(locale, 'host.tab.domains')}
                  link={`${base}/domains`}
                  linkLabel={t(locale, 'action.manage')}
                >
                  {site.domains.length ? (
                    <ul className="nzc-ns-list">
                      {site.domains.map((d) => (
                        <li key={d.id}>{d.domain}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="nz-muted" style={{ margin: 0 }}>
                      {t(locale, 'host.none.domains')}
                    </p>
                  )}
                </SidePanel>
                <SidePanel
                  title={t(locale, 'host.tab.backups')}
                  link={`${base}/backups`}
                  linkLabel={t(locale, 'host.ov.open')}
                >
                  <p className="nz-muted" style={{ margin: 0 }}>
                    {t(locale, 'host.card.backups')}
                  </p>
                </SidePanel>
              </>
            }
          />
          {s.can('hosting:site:delete') && site.status !== 'deleting' && (
            <DeleteSiteForm
              locale={locale}
              siteId={id}
              siteName={site.name}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
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
