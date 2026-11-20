import { DashboardSlider } from '../../../components/DashboardSlider';
import { DashboardStatus } from '../../../components/DashboardStatus';
import { notFound, redirect } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import { CountUp, Badge, Bars, Icon, Ltr, StatTile } from '@nuzm/ui';
import {
  DOMAIN_PROBLEM_STATES,
  SERVER_BAD,
  SITE_BAD,
  expiringSoon,
  formatDay,
  problemCount,
  sortAttention,
  type AttentionItem,
  type StatusRow,
} from '../../../lib/dashboard-status';
import { OP_TERMINAL, unwrapCall, type Instance, type Paged } from '../../../lib/compute';
import { serverCompute } from '../../../lib/compute-server';
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

  // the start-side status column: the member's current servers, domains and websites, and what needs attention (real data only; a module the member cannot
  // reach, or whose list fails to load, simply has no card)
  const has = (id: string) => services.some((x) => x.id === id);
  const [instances, domainList, siteList] = await Promise.all([
    has('compute')
      ? safe(
          serverCompute(s.org.orgId).then((c) =>
            unwrapCall(c.get<Paged<Instance>>('/v1/compute/instances', { query: { limit: 50 } })),
          ),
        )
      : null,
    has('domains')
      ? safe(unwrap(s.api.GET('/v1/domains', { params: { query: { limit: 50 } } })))
      : null,
    has('hosting')
      ? safe(unwrap(s.api.GET('/v1/hosting/sites', { params: { query: { limit: 50 } } })))
      : null,
  ]);
  const now = Date.now();
  const word = (key: string) => t(locale, `ds.status.${key}` as 'ds.status.other');
  const serverItems = instances?.items.filter((i) => i.status !== 'deleted') ?? [];
  const domainItems = domainList?.items ?? [];
  const siteItems = siteList?.items.filter((i) => i.status !== 'deleted') ?? [];
  const attention: AttentionItem[] = [];
  const failedServers = problemCount(
    serverItems.map((i) => ({ state: String(i.status) })),
    SERVER_BAD,
  );
  if (failedServers > 0)
    attention.push({
      id: 'servers',
      tone: 'bad',
      text: t(locale, 'ds.att.serversFailed', { n: failedServers }),
      href: `${base}/compute/instances`,
    });
  const badDomains = problemCount(domainItems, DOMAIN_PROBLEM_STATES);
  if (badDomains > 0)
    attention.push({
      id: 'domains-bad',
      tone: 'bad',
      text: t(locale, 'ds.att.domainsProblem', { n: badDomains }),
      href: `${base}/domains`,
    });
  const soonDomains = expiringSoon(domainItems, now);
  if (soonDomains > 0)
    attention.push({
      id: 'domains-soon',
      tone: 'warn',
      text: t(locale, 'ds.att.domainsSoon', { n: soonDomains }),
      href: `${base}/domains`,
    });
  const badSites = problemCount(
    siteItems.map((i) => ({ state: i.status })),
    SITE_BAD,
  );
  if (badSites > 0)
    attention.push({
      id: 'sites',
      tone: 'bad',
      text: t(locale, 'ds.att.sitesProblem', { n: badSites }),
      href: `${base}/hosting/sites`,
    });
  if (capPercent !== null && capPercent >= 80)
    attention.push({
      id: 'cap',
      tone: capPercent >= 100 ? 'bad' : 'warn',
      text: t(locale, 'ds.att.cap', { n: Math.min(capPercent, 999) }),
      href: `${base}/billing/spending-limits`,
    });
  if (notes && notes.unreadCount > 0)
    attention.push({
      id: 'unread',
      tone: 'warn',
      text: t(locale, 'ds.att.unread', { n: notes.unreadCount }),
      href: `${base}/notifications`,
    });
  if (!s.me.emailVerified)
    attention.push({
      id: 'email',
      tone: 'warn',
      text: t(locale, 'ds.att.email'),
      href: `${base}/account`,
    });
  const serverRows: StatusRow[] = serverItems.map((i) => ({
    id: i.id,
    name: i.name,
    detail: word(
      ['running', 'stopped', 'provisioning', 'failed'].includes(String(i.status))
        ? String(i.status)
        : 'other',
    ),
    tone: i.status === 'running' ? 'ok' : i.status === 'failed' ? 'bad' : 'neutral',
    href: `${base}/compute/instances/${i.id}`,
  }));
  const domainRows: StatusRow[] = domainItems.map((d) => ({
    id: d.id,
    name: d.name,
    detail: DOMAIN_PROBLEM_STATES.has(d.state)
      ? word(d.state === 'expired' ? 'expired' : 'failed')
      : d.expiresAt
        ? t(locale, 'ds.expires', { date: formatDay(d.expiresAt, locale) })
        : word('active'),
    tone: DOMAIN_PROBLEM_STATES.has(d.state) ? 'bad' : 'ok',
    href: `${base}/domains/${d.id}`,
  }));
  const siteRows: StatusRow[] = siteItems.map((x) => ({
    id: x.id,
    name: x.name,
    detail: word(
      ['active', 'failed', 'suspended', 'creating'].includes(x.status) ? x.status : 'other',
    ),
    tone: x.status === 'active' ? 'ok' : SITE_BAD.has(x.status) ? 'bad' : 'neutral',
    href: `${base}/hosting/sites/${x.id}`,
  }));
  const statusColumn = (
    <DashboardStatus
      locale={locale}
      base={base}
      attention={sortAttention(attention)}
      servers={
        instances
          ? { count: serverItems.length, capped: Boolean(instances.nextCursor), rows: serverRows }
          : null
      }
      domains={
        domainList
          ? { count: domainItems.length, capped: Boolean(domainList.nextCursor), rows: domainRows }
          : null
      }
      sites={
        siteList
          ? { count: siteItems.length, capped: Boolean(siteList.nextCursor), rows: siteRows }
          : null
      }
    />
  );

  const featuredServices = ['hosting', 'compute', 'domains']
    .map((id) => services.find((service) => service.id === id))
    .filter((service) => service !== undefined);
  const otherServices = services.filter((service) => !featuredServices.includes(service));
  const ar = locale === 'ar';
  const slides = featuredServices.map((service) => ({
    id: service.id,
    title:
      service.id === 'hosting'
        ? ar
          ? 'انشر موقعك القادم.'
          : 'Publish your next website.'
        : service.id === 'compute'
          ? ar
            ? 'بنية تحتية متصلة.'
            : 'Your infrastructure, connected.'
          : ar
            ? 'عنوان جديد لفكرتك.'
            : 'Give your idea an address.',
    description:
      service.id === 'hosting'
        ? ar
          ? 'مواقعك ونطاقاتك وشهاداتك، في مكان واحد.'
          : 'Your sites, domains and certificates, together.'
        : service.id === 'compute'
          ? ar
            ? 'أدر خوادمك ومواردك من لوحة واحدة.'
            : 'Keep your servers and resources in one place.'
          : ar
            ? 'ابحث عن نطاقك وأدر سجلات DNS بسهولة.'
            : 'Find your domain and make it your own.',
    label: ar ? 'استكشف الخدمة' : 'Explore service',
    href: `${base}${service.href}`,
  }));

  return (
    <div className="nzc-dash-layout">
      {statusColumn}
      <div className="nzc-dashboard">
        <header className="nzc-home-welcome">
          <h1>{t(locale, 'home.title', { name })}</h1>
          <span>
            {s.org.name} <Badge>{t(locale, `org.type.${s.org.type}`)}</Badge>
          </span>
        </header>
        <DashboardSlider ar={ar} slides={slides} />

        <section
          className="nzc-home-bento"
          aria-label={ar ? 'نظرة عامة على مساحتك' : 'Your workspace overview'}
        >
          <div className="nzc-home-overview">
            <div className="nzc-home-overview-head">
              <h2>{ar ? 'مساحتك، بنظرة واحدة' : 'Your workspace at a glance'}</h2>
              <Icon name="projects" size={18} />
            </div>
            <div
              className="nzc-home-orbit"
              role="img"
              aria-label={`${services.length} ${ar ? 'خدمات متاحة' : 'available services'}`}
            >
              <div>
                <span>{ar ? 'خدمات متاحة' : 'Available services'}</span>
                <strong>{services.length}</strong>
              </div>
            </div>
            <div className="nzc-home-overview-foot">
              <span>
                <i />
                {ar ? 'البناء والإطلاق والإدارة' : 'Build. Launch. Manage.'}
              </span>
              <span>{s.org.name}</span>
            </div>
          </div>
          {featuredServices.map((service) => (
            <a
              key={service.id}
              className="nzc-home-service"
              data-service={service.id}
              href={`${base}${service.href}`}
            >
              <div className="nzc-home-service-top">
                <span className="nzc-home-service-symbol">
                  <Icon name={service.icon} size={19} />
                </span>
                <Icon name="arrow" size={17} />
              </div>
              <div>
                <h2>
                  {service.id === 'compute' ? (ar ? 'السحابة' : 'Cloud') : t(locale, service.label)}
                </h2>
                <p>{slides.find((slide) => slide.id === service.id)?.description}</p>
              </div>
              <div className="nzc-home-service-bottom">
                <span>
                  {service.id === 'domains'
                    ? '.com / .sa'
                    : service.id === 'compute'
                      ? ar
                        ? 'مواردك السحابية'
                        : 'Your cloud workspace'
                      : ar
                        ? 'موقعك التالي'
                        : 'Your next website'}
                </span>
                <span className="nzc-home-service-open">
                  <Icon name="arrow" size={15} />
                </span>
              </div>
            </a>
          ))}
          {services.some((service) => service.id === 'builder') && (
            <a className="nzc-home-build" href={`${base}/builder/projects`}>
              <div>
                <span>{ar ? 'من الفكرة إلى الواقع' : 'FROM IDEA TO LAUNCH'}</span>
                <h2>{ar ? 'ماذا ستبني اليوم؟' : 'What will you build today?'}</h2>
              </div>
              <span className="nzc-home-service-open">
                <Icon name="code" size={22} />
              </span>
            </a>
          )}
        </section>

        <div className="nzc-stats">
          {balance && (
            <StatTile
              icon="wallet"
              featured
              label={t(locale, 'dash.stat.wallet')}
              href={`${base}/billing/payments#wallet`}
              value={
                wallet ? (
                  <Ltr>{formatMinor(wallet.balanceMinor, wallet.currency, locale)}</Ltr>
                ) : (
                  '—'
                )
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
                  <a href={`${base}/settings/organization#audit`}>
                    {t(locale, 'dash.activity.all')}
                  </a>
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
    </div>
  );
}
