import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ForbiddenState, Icon, Ltr, OnOff, PageTitle } from '@nuzm/ui';
import { DomainSettings, RenewButton } from '../../../../../components/DomainPanels';
import { daysLeft, domainTone } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** Days left out of a year, as a ring: red under 30 days, amber under 60. */
function ExpiryRing({ locale, days }: { locale: 'ar' | 'en'; days: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, days / 365));
  const color =
    days <= 30 ? 'var(--nzc-danger)' : days <= 60 ? 'var(--nzc-warn)' : 'var(--nzc-accent)';
  return (
    <div
      className="nzc-ring"
      role="img"
      aria-label={days > 0 ? t(locale, 'dom.ov.daysLeft', { days }) : t(locale, 'dom.ov.expired')}
      style={{ ['--ring' as string]: color }}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="nzc-ring-track" cx="50" cy="50" r={r} />
        {/* a zero-length round cap would still paint a dot */}
        {frac > 0 && (
          <circle
            className="nzc-ring-bar"
            cx="50"
            cy="50"
            r={r}
            strokeDasharray={`${frac * c} ${c}`}
          />
        )}
      </svg>
      <span className="nzc-ring-label" aria-hidden="true">
        {days > 0 ? (
          <span>
            <strong>{days}</strong>
            {t(locale, 'dom.ov.daysLeft', { days: '' }).trim()}
          </span>
        ) : (
          <strong style={{ color: 'var(--nzc-danger)' }}>!</strong>
        )}
      </span>
    </div>
  );
}

/** UI-M07-04: overview, nameservers, lock, auto-renew; pending / reconciling / degraded states are explained. Read for everyone, write for owner/admin/developer. */
export default async function DomainPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.detail.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const d = await unwrap(s.api.GET('/v1/domains/{id}', { params: { path: { id } } }));
      // the DNS card shows how many records the zone holds (a missing zone or a failed read just leaves the line out)
      let records: number | null = null;
      if (s.can('dns:read'))
        try {
          const zones = await unwrap(
            s.api.GET('/v1/dns/zones', { params: { query: { limit: 200 } } }),
          );
          const zone = zones.items.find((z) => z.domainId === id);
          if (zone)
            records = (
              await unwrap(
                s.api.GET('/v1/dns/zones/{id}/records', { params: { path: { id: zone.id } } }),
              )
            ).items.length;
        } catch {
          records = null;
        }
      return { d, records };
    },
    ({ d, records }) => {
      const base = `/${locale}/domains/${d.id}`;
      const days = d.expiresAt ? daysLeft(d.expiresAt) : null;
      const live = d.state === 'active' || d.state === 'renewal_at_risk';
      const canRenew = s.can('domain:renew') && d.state !== 'pending' && d.state !== 'failed';
      return (
        <>
          {d.state === 'pending' || d.state === 'transferring' ? (
            <Banner tone="warn">{t(locale, 'dom.detail.pending')}</Banner>
          ) : null}
          {d.renewalAtRisk ? (
            <Banner tone="danger">{t(locale, 'dom.state.renewal_at_risk')}</Banner>
          ) : null}
          {live && days !== null && days <= 30 && (
            <div className="nzc-action" role="status" style={{ marginBlockEnd: 18 }} data-warn>
              <span className="nzc-action-icon" style={{ color: 'var(--nzc-warn)' }}>
                <Icon name="calendar" size={22} />
              </span>
              <span>
                <span className="nzc-action-title">
                  {t(locale, 'dom.ov.expiring', { days: Math.max(days, 0) })}
                </span>
                <span className="nzc-action-desc">{t(locale, 'dom.ov.expiring.body')}</span>
              </span>
              {canRenew && <RenewButton locale={locale} id={d.id} name={d.name} />}
            </div>
          )}
          <div className="nzc-ov">
            <div className="nzc-ov-main">
              <section className="nzc-panel" aria-labelledby="ov-h">
                <h2 id="ov-h">{t(locale, 'dom.ov.title', { name: d.name })}</h2>
                <p className="nzc-panel-sub">{t(locale, 'dom.ov.sub')}</p>
                <div className="nzc-actions">
                  {(
                    [
                      [
                        `/${locale}/hosting/sites/new?domain=${encodeURIComponent(d.name)}`,
                        'hosting',
                        'dom.ov.site',
                        'dom.ov.site.desc',
                        true,
                      ],
                      [
                        `/${locale}/email/domains`,
                        'mail',
                        'dom.ov.email',
                        'dom.ov.email.desc',
                        false,
                      ],
                      [`${base}/dns`, 'globe', 'dom.link.dns', 'dom.link.dns.desc', false],
                      [
                        `${base}/hosting`,
                        'code',
                        'dom.link.hosting',
                        'dom.link.hosting.desc',
                        false,
                      ],
                    ] as const
                  ).map(([href, icon, title, desc, featured]) => (
                    <div key={href} className="nzc-action" data-featured={featured || undefined}>
                      <span className="nzc-action-icon">
                        <Icon name={icon} size={22} />
                      </span>
                      <span>
                        <span className="nzc-action-title">{t(locale, title)}</span>
                        <span className="nzc-action-desc">{t(locale, desc)}</span>
                      </span>
                      <a
                        className="nz-btn"
                        data-variant={featured ? 'primary' : 'secondary'}
                        href={href}
                      >
                        {t(locale, 'dom.ov.start')}
                        <Icon name="arrow" size={16} />
                      </a>
                    </div>
                  ))}
                </div>
              </section>
              {s.can('domain:write') ? (
                <section
                  id="settings"
                  aria-labelledby="dom-set"
                  style={{ scrollMarginBlockStart: 18 }}
                >
                  <h2 className="nzc-section-title" id="dom-set">
                    {t(locale, 'dom.detail.settings')}
                  </h2>
                  <DomainSettings
                    locale={locale}
                    id={d.id}
                    version={d.version}
                    nameservers={d.nameservers}
                    locked={d.locked}
                    autoRenew={d.autoRenew}
                    caps={d.capabilities}
                  />
                </section>
              ) : null}
            </div>

            <aside className="nzc-ov-side" aria-label={t(locale, 'dom.detail.facts')}>
              <section className="nzc-panel">
                <div className="nzc-side-name">
                  <strong>
                    <Ltr>{d.name}</Ltr>
                    {live && (
                      <a
                        href={`https://${d.name}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t(locale, 'dom.ov.visit')}
                      >
                        <Icon name="external" size={16} />
                      </a>
                    )}
                  </strong>
                  <span className="nzc-side-badges">
                    <Badge tone={domainTone(d.state)}>
                      {tDynamic(locale, `dom.state.${d.state}`, d.state)}
                    </Badge>
                    <span
                      className="nzc-lock"
                      data-on={d.locked || undefined}
                      role="img"
                      aria-label={`${t(locale, 'dom.detail.lock')}: ${t(locale, d.locked ? 'dom.on' : 'dom.off')}`}
                    >
                      <Icon name="lock" size={16} />
                    </span>
                  </span>
                </div>
                {d.expiresAt && (
                  <div className="nzc-expiry">
                    <ExpiryRing locale={locale} days={days ?? 0} />
                    <dl style={{ margin: 0 }}>
                      <dt>{t(locale, 'dom.col.expires')}</dt>
                      <dd>{formatDateTime(d.expiresAt, locale)}</dd>
                      {canRenew && <RenewButton locale={locale} id={d.id} name={d.name} />}
                    </dl>
                  </div>
                )}
                <dl className="nzc-side-rows">
                  {(
                    [
                      [
                        'refresh',
                        'dom.col.autoRenew',
                        <OnOff key="ar" on={d.autoRenew}>
                          {t(locale, d.autoRenew ? 'dom.on' : 'dom.off')}
                        </OnOff>,
                      ],
                      [
                        'shield',
                        'dom.detail.privacy',
                        tDynamic(locale, `dom.privacy.${d.privacyState}`, d.privacyState),
                      ],
                      [
                        'calendar',
                        'dom.detail.registered',
                        d.registeredAt ? formatDateTime(d.registeredAt, locale) : '—',
                      ],
                      ['pin', 'dom.detail.region', d.providerRegionId ?? d.dataRegion],
                    ] as const
                  ).map(([icon, label, value]) => (
                    <div key={label}>
                      <dt>
                        <Icon name={icon} size={16} />
                        {t(locale, label)}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="nzc-panel" aria-labelledby="ov-ns">
                <div className="nzc-panel-head">
                  <h3 id="ov-ns">{t(locale, 'dom.ns.title')}</h3>
                  {s.can('domain:write') && <a href="#settings">{t(locale, 'dom.ov.edit')}</a>}
                </div>
                {d.nameservers.length ? (
                  <ul className="nzc-ns-list">
                    {d.nameservers.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="nz-muted">{t(locale, 'dom.ns.none')}</p>
                )}
              </section>

              <section className="nzc-panel" aria-labelledby="ov-dns">
                <div className="nzc-panel-head">
                  <h3 id="ov-dns">{t(locale, 'dom.link.dns')}</h3>
                  <a href={`${base}/dns`}>{t(locale, 'action.manage')}</a>
                </div>
                <p className="nz-muted" style={{ margin: 0 }}>
                  {records === null
                    ? t(locale, 'dom.dns.noZone')
                    : `${records} ${t(locale, 'dom.dns.title')}`}
                </p>
              </section>

              <section className="nzc-panel" aria-labelledby="ov-own">
                <div className="nzc-panel-head">
                  <h3 id="ov-own">{t(locale, 'dom.ov.ownership')}</h3>
                  <a href={`${base}/contacts`}>{t(locale, 'dom.ov.viewAll')}</a>
                </div>
                <p className="nz-muted" style={{ margin: 0 }}>
                  {t(locale, 'dom.ov.ownership.desc')}
                </p>
              </section>
            </aside>
          </div>
        </>
      );
    },
  );
  return (
    <>
      <a className="nzc-back" href={`/${locale}/domains`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.tab.list')}
      </a>
      <PageTitle>{t(locale, 'dom.detail.title')}</PageTitle>
      {body}
    </>
  );
}
