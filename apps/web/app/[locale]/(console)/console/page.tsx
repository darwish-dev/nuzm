import { DashboardStatus } from '../../../../components/DashboardStatus';
import { notFound, redirect } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, Icon, Ltr } from '@nuzm/ui';
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
} from '../../../../lib/dashboard-status';
import { unwrapCall, type Instance, type Paged } from '../../../../lib/compute';
import { serverCompute } from '../../../../lib/compute-server';
import { requireSession } from '../../../../lib/server';
import { flagEnabled, visibleServices } from '../../../../lib/services';

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
  if (!s.org) redirect(`/orgs/new`);

  // the dashboard is deliberately simple: no money or usage figures here (the balance and AI credits are in the top bar). Spending and notifications
  // are read only to raise an attention item when they need one.
  const [summary, limits, notes, audit] = await Promise.all([
    s.can('usage:read') ? safe(unwrap(s.api.GET('/v1/usage/summary', {}))) : null,
    s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/spending-limits', {}))) : null,
    safe(unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 1 } } }))),
    s.can('audit:read')
      ? safe(unwrap(s.api.GET('/v1/audit-logs', { params: { query: { limit: 6 } } })))
      : null,
  ]);

  const base = '';
  const cap = limits?.items.find((l) => l.scope === 'org') ?? null;
  const spent =
    summary?.totalMinor && cap && summary.currency === cap.currency
      ? BigInt(summary.totalMinor)
      : 0n;
  const capPercent =
    cap && BigInt(cap.monthlyCapMinor) > 0n
      ? Number((spent * 100n) / BigInt(cap.monthlyCapMinor))
      : null;
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

  const ar = locale === 'ar';
  const builder = services.find((x) => x.id === 'builder');
  const activity = (action: string) =>
    (
      ({
        'domain.quote.residency_blocked': ar
          ? 'سياسة الإقامة منعت عرض سعر النطاق'
          : 'Domain quote blocked by residency policy',
        'compliance.residency.evaluate_denied': ar
          ? 'رُفض طلب الإقامة'
          : 'Residency policy check denied',
        'builder.preview.created': ar ? 'تم إنشاء معاينة الموقع' : 'Website preview created',
        'ai.session.created': ar ? 'بدأت جلسة ذكاء اصطناعي' : 'AI session started',
        'builder.project.created': ar ? 'تم إنشاء مشروع' : 'Project created',
      }) as Record<string, string>
    )[action] ?? action;

  // recent activity sits in the top row beside the resources and what needs attention
  const activityCard = audit && (
    <section className="nzc-status-card nzc-status-activity" aria-labelledby="ds-activity">
      <header>
        <span className="nzc-status-icon" aria-hidden="true">
          <Icon name="pulse" size={18} />
        </span>
        <h2 id="ds-activity">{t(locale, 'dash.activity.title')}</h2>
      </header>
      {audit.items.length === 0 ? (
        <p className="nzc-status-empty">{t(locale, 'state.empty.body')}</p>
      ) : (
        <ul>
          {audit.items.slice(0, 5).map((e) => (
            <li key={e.id}>
              <span className="nzc-status-dot" data-tone="neutral" aria-hidden="true" />
              <span className="nzc-status-text">
                <Ltr>{activity(e.action)}</Ltr>
                <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt, locale)}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
      <a className="nzc-status-all" href={`${base}/settings/organization#audit`}>
        {t(locale, 'dash.activity.all')}
        <Icon name="arrow" size={14} />
      </a>
    </section>
  );
  const statusColumn = (
    <DashboardStatus
      locale={locale}
      base={base}
      layout="row"
      activity={activityCard}
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

  /**
   * One simple column: a welcome, the builder invitation, then one row of cards: what needs attention, the member's resources and recent activity. No balance, usage or counters (they live in the top bar and in Billing).
   */
  return (
    <div className="nzc-home">
      <header className="nzc-home-welcome">
        <h1>{t(locale, 'home.title', { name })}</h1>
        <span>
          {s.org.name} <Badge>{t(locale, `org.type.${s.org.type}`)}</Badge>
        </span>
      </header>

      {builder && (
        <a className="nzc-home-start" href={`${base}${builder.href}`}>
          <span className="nzc-home-start-text">
            <small>{ar ? 'من الفكرة إلى الإطلاق' : 'From idea to launch'}</small>
            <strong>{ar ? 'ماذا ستبني اليوم؟' : 'What will you build today?'}</strong>
            <span>{t(locale, builder.desc)}</span>
          </span>
          <span className="nzc-home-start-go">
            <span className="nzc-home-start-mark" aria-hidden="true">
              <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={33} height={26} />
            </span>
            <strong>Nuzm AI</strong>
            <span className="nzc-home-start-arrow" aria-hidden="true">
              <Icon name="arrow" size={18} />
            </span>
          </span>
        </a>
      )}

      {statusColumn}
    </div>
  );
}
