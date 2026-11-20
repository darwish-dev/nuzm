import { notFound, redirect } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import { Art, CountUp, Badge, Bars, Icon, Ltr, StatTile } from '@nuzm/ui';
import { OP_TERMINAL } from '../../../lib/compute';
import { requireSession } from '../../../lib/server';
import { flagEnabled, visibleServices } from '../../../lib/services';

/** A figure this role may not see, or that fails to load, is simply left out of the dashboard: nothing here is ever invented. */
const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const name = s.me.displayName ?? s.me.email;
  // finishing sign-up comes first: no organization yet means step 2, not an empty dashboard
  if (!s.org) redirect(`/${locale}/orgs/new`);

  const [balance, summary, limits, ops, notes, audit] = await Promise.all([
    s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/balance', {}))) : null,
    s.can('usage:read') ? safe(unwrap(s.api.GET('/v1/usage/summary', {}))) : null,
    s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/spending-limits', {}))) : null,
    s.can('operation:read')
      ? safe(unwrap(s.api.GET('/v1/operations', { params: { query: { limit: 50 } } })))
      : null,
    safe(unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 1 } } }))),
    s.can('audit:read')
      ? safe(unwrap(s.api.GET('/v1/audit-logs', { params: { query: { limit: 6 } } })))
      : null,
  ]);

  const base = `/${locale}`;
  const wallet = balance?.balances[0] ?? null;
  const activeOps = ops ? ops.items.filter((o) => !OP_TERMINAL.has(o.state)).length : null;
  const cap = limits?.items.find((l) => l.scope === 'org') ?? null;
  const spent =
    summary?.totalMinor && cap && summary.currency === cap.currency
      ? BigInt(summary.totalMinor)
      : 0n;
  const capPercent =
    cap && BigInt(cap.monthlyCapMinor) > 0n
      ? Number((spent * 100n) / BigInt(cap.monthlyCapMinor))
      : null;

  const meters = (summary?.items ?? [])
    .filter((i) => i.amountMinor !== null && BigInt(i.amountMinor) > 0n)
    .sort((a, b) => (BigInt(b.amountMinor!) > BigInt(a.amountMinor!) ? 1 : -1))
    .slice(0, 6);
  const top = meters[0] ? BigInt(meters[0].amountMinor!) : 1n;
  const services = visibleServices(s.can, (f) => flagEnabled(s.me.featureFlags, f));

  const featuredServices = ['hosting', 'compute', 'domains']
    .map((id) => services.find((service) => service.id === id))
    .filter((service) => service !== undefined);
  const otherServices = services.filter((service) => !featuredServices.includes(service));
  const primaryService =
    services.find((service) => service.id === 'builder') ?? featuredServices[0];
  const ar = locale === 'ar';

  return (
    <div className="nzc-dashboard">
      <section className="nzc-home-banner" aria-labelledby="d-hero">
        <div className="nzc-home-banner-copy">
          <p className="nzc-home-org">
            {s.org.name} <Badge>{t(locale, `org.type.${s.org.type}`)}</Badge>
          </p>
          <h1 id="d-hero">{t(locale, 'home.title', { name })}</h1>
          <h2>{ar ? 'فكرتك التالية، تبدأ من هنا.' : 'Your next idea starts here.'}</h2>
          <p className="nzc-home-intro">
            {ar
              ? 'من أول نطاق إلى تطبيقك القادم. استضف مواقعك وأدر مواردك السحابية من مكان واحد.'
              : 'From your first domain to your next application. Bring your websites and cloud resources together.'}
          </p>
          {primaryService && (
            <a
              className="nz-btn nz-btn-primary nzc-home-cta"
              href={`${base}${primaryService.href}`}
            >
              {primaryService.id === 'builder'
                ? ar
                  ? 'ابدأ البناء'
                  : 'Start building'
                : t(locale, primaryService.label)}
              <Icon name="arrow" size={17} />
            </a>
          )}
        </div>
        <div className="nzc-home-banner-visual" aria-hidden="true">
          <Art name="cloud" />
          <span className="nzc-home-visual-label">
            <Icon name="cloud" size={16} />
            {ar ? 'كل أفكارك. منصة واحدة.' : 'All your ideas. One platform.'}
          </span>
        </div>
      </section>

      {featuredServices.length > 0 && (
        <section aria-labelledby="d-featured">
          <div className="nzc-cardhead">
            <h2 id="d-featured">{ar ? 'مساحتك للنمو' : 'Room to grow'}</h2>
          </div>
          <ul className="nzc-home-products">
            {featuredServices.map((service) => {
              const art = service.id === 'compute' ? 'cloud' : service.id;
              return (
                <li key={service.id}>
                  <a className="nzc-home-product" href={`${base}${service.href}`}>
                    <div className="nzc-home-product-image">
                      <img
                        src={`/images/services/${art}-studio.webp`}
                        alt=""
                        width={1536}
                        height={1024}
                        loading="lazy"
                      />
                    </div>
                    <div className="nzc-home-product-body">
                      <span className="nzc-home-product-heading">
                        <Icon name={service.icon} size={20} />
                        <strong>
                          {service.id === 'compute'
                            ? ar
                              ? 'السحابة'
                              : 'Cloud'
                            : t(locale, service.label)}
                        </strong>
                        <Icon name="arrow" size={18} />
                      </span>
                      <p>{t(locale, service.desc)}</p>
                      <span className="nzc-home-product-link">
                        {ar ? 'إدارة الخدمة' : 'Manage service'}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="nzc-stats">
        {balance && (
          <StatTile
            icon="wallet"
            featured
            label={t(locale, 'dash.stat.wallet')}
            href={`${base}/billing/payments#wallet`}
            value={
              wallet ? <Ltr>{formatMinor(wallet.balanceMinor, wallet.currency, locale)}</Ltr> : '—'
            }
            sub={wallet ? undefined : t(locale, 'dash.stat.wallet.none')}
          />
        )}
        {summary && (
          <StatTile
            icon="finance"
            label={t(locale, 'dash.stat.mtd')}
            href={`${base}/billing/usage`}
            value={
              summary.totalMinor && summary.currency ? (
                <Ltr>{formatMinor(summary.totalMinor, summary.currency, locale)}</Ltr>
              ) : (
                '—'
              )
            }
            sub={t(locale, 'dash.stat.mtd.sub', { date: summary.periodStart })}
          />
        )}
        {capPercent !== null && cap && (
          <StatTile
            icon="shield"
            label={t(locale, 'dash.stat.cap')}
            href={`${base}/billing/spending-limits`}
            value={<Ltr>{`${Math.min(capPercent, 999)}%`}</Ltr>}
            sub={t(locale, 'dash.stat.cap.sub', {
              cap: formatMinor(cap.monthlyCapMinor, cap.currency, locale),
            })}
          />
        )}
        {activeOps !== null && ops && (
          <StatTile
            icon="cloud"
            label={t(locale, 'dash.stat.ops')}
            href={`${base}/operations`}
            value={
              <Ltr>
                <CountUp value={activeOps} />
              </Ltr>
            }
            sub={t(locale, 'dash.stat.ops.sub', { n: ops.items.length })}
          />
        )}
        {notes && (
          <StatTile
            icon="bell"
            label={t(locale, 'dash.stat.unread')}
            href={`${base}/notifications`}
            value={
              <Ltr>
                <CountUp value={notes.unreadCount} />
              </Ltr>
            }
          />
        )}
      </div>

      {(summary || audit) && (
        <div className="nzc-split">
          {summary && (
            <section className="nz-card" aria-labelledby="d-usage">
              <div className="nzc-cardhead">
                <h2 id="d-usage">{t(locale, 'dash.usage.title')}</h2>
                <a href={`${base}/billing/usage`}>{t(locale, 'dash.activity.all')}</a>
              </div>
              {meters.length === 0 ? (
                <div className="nzc-dashboard-empty">
                  <span>
                    <Icon name="finance" size={30} />
                  </span>
                  <p>{t(locale, 'dash.usage.empty')}</p>
                  <a href={`${base}/billing/usage`}>
                    {t(locale, 'dash.activity.all')} <Icon name="arrow" size={15} />
                  </a>
                </div>
              ) : (
                <Bars
                  label={t(locale, 'dash.usage.title')}
                  rows={meters.map((m) => ({
                    key: m.meterId,
                    label: <Ltr>{m.meterId}</Ltr>,
                    value: <Ltr>{formatMinor(m.amountMinor!, m.currency ?? '', locale)}</Ltr>,
                    ratio: Number((BigInt(m.amountMinor!) * 1000n) / top) / 1000,
                  }))}
                />
              )}
            </section>
          )}
          {audit && (
            <section className="nz-card" aria-labelledby="d-activity">
              <div className="nzc-cardhead">
                <h2 id="d-activity">{t(locale, 'dash.activity.title')}</h2>
                <a href={`${base}/settings/organization#audit`}>{t(locale, 'dash.activity.all')}</a>
              </div>
              {audit.items.length === 0 ? (
                <p className="nz-muted">{t(locale, 'state.empty.body')}</p>
              ) : (
                <ul className="nzc-list">
                  {audit.items.map((e) => (
                    <li key={e.id}>
                      <span className="nzc-dashboard-event">
                        <Icon
                          name={
                            e.action.includes('blocked') || e.action.includes('denied')
                              ? 'shield'
                              : 'code'
                          }
                          size={18}
                        />
                        <Ltr>
                          {(
                            {
                              'domain.quote.residency_blocked':
                                locale === 'ar'
                                  ? 'سياسة الإقامة منعت عرض سعر النطاق'
                                  : 'Domain quote blocked by residency policy',
                              'compliance.residency.evaluate_denied':
                                locale === 'ar'
                                  ? 'رُفض طلب الإقامة'
                                  : 'Residency policy check denied',
                              'builder.preview.created':
                                locale === 'ar'
                                  ? 'تم إنشاء معاينة الموقع'
                                  : 'Website preview created',
                              'ai.session.created':
                                locale === 'ar' ? 'بدأت جلسة ذكاء اصطناعي' : 'AI session started',
                              'builder.project.created':
                                locale === 'ar' ? 'تم إنشاء مشروع' : 'Project created',
                            } as Record<string, string>
                          )[e.action] ?? e.action}
                        </Ltr>
                      </span>
                      <span className="nz-muted">{formatDateTime(e.occurredAt, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {otherServices.length > 0 && (
        <section aria-labelledby="d-services">
          <div className="nzc-cardhead">
            <h2 id="d-services">{t(locale, 'dash.services.title')}</h2>
          </div>
          <ul className="nzc-tiles">
            {otherServices.map((svc) => (
              <li key={svc.id}>
                <a className="nzc-tile" href={`${base}${svc.href}`}>
                  <span className="nzc-tile-icon">
                    <Icon name={svc.icon} size={18} />
                  </span>
                  <strong>{t(locale, svc.label)}</strong>
                  <span className="nzc-tile-sub">{t(locale, svc.desc)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
