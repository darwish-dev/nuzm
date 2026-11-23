import type { ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import type { AttentionItem, StatusRow } from '../lib/dashboard-status';

const MAX_ROWS = 4;

function Card({
  id,
  icon,
  title,
  count,
  href,
  locale,
  rows,
  capped,
  emptyText,
}: {
  id: string;
  icon: IconName;
  title: string;
  count: number;
  href: string;
  locale: Locale;
  rows: StatusRow[];
  /** more exist than were loaded: the count is a lower bound */
  capped?: boolean;
  emptyText: string;
}) {
  return (
    <section className="nzc-status-card" aria-labelledby={`ds-${id}`} data-kind={id}>
      <header>
        <span className="nzc-status-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <h2 id={`ds-${id}`}>{title}</h2>
        <span className="nzc-status-count">
          {count}
          {capped ? '+' : ''}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="nzc-status-empty">{emptyText}</p>
      ) : (
        <ul>
          {rows.slice(0, MAX_ROWS).map((r) => (
            <li key={r.id}>
              <a href={r.href}>
                <span className="nzc-status-dot" data-tone={r.tone} aria-hidden="true" />
                <bdi dir="auto" className="nzc-status-name">
                  {r.name}
                </bdi>
                <small>{r.detail}</small>
              </a>
            </li>
          ))}
        </ul>
      )}
      <a className="nzc-status-all" href={href}>
        {count > MAX_ROWS ? t(locale, 'ds.more', { n: count - MAX_ROWS }) : t(locale, 'ds.viewAll')}
        <Icon name="arrow" size={14} />
      </a>
    </section>
  );
}

/**
 * The dashboard's start-side column: what needs attention, then the member's current servers, domains and websites with a few rows each. A card whose
 * module the member cannot reach (or whose list failed to load) is `null` and not drawn.
 */
export function DashboardStatus({
  locale,
  base,
  attention,
  servers,
  domains,
  sites,
  layout = 'column',
  activity,
}: {
  locale: Locale;
  base: string;
  /** `row`: the resources side by side under the welcome, and the attention card only when something needs attention */
  layout?: 'column' | 'row';
  /** a recent-activity card drawn last, beside the resources (row layout) */
  activity?: ReactNode;
  attention: AttentionItem[];
  servers: { count: number; capped?: boolean; rows: StatusRow[] } | null;
  domains: { count: number; capped?: boolean; rows: StatusRow[] } | null;
  sites: { count: number; capped?: boolean; rows: StatusRow[] } | null;
}) {
  return (
    <section className="nzc-status" data-layout={layout} aria-label={t(locale, 'ds.title')}>
      <p className="nzc-status-title" aria-hidden="true">
        {t(locale, 'ds.title')}
      </p>
      {(layout === 'column' || attention.length > 0) && (
        <section className="nzc-status-card nzc-status-attention" aria-labelledby="ds-attention">
          <header>
            <span className="nzc-status-icon" aria-hidden="true">
              <Icon name="bell" size={18} />
            </span>
            <h2 id="ds-attention">{t(locale, 'ds.attention')}</h2>
            <span
              className="nzc-status-count"
              data-alert={attention.length > 0 ? 'true' : undefined}
            >
              {attention.length}
            </span>
          </header>
          {attention.length === 0 ? (
            <p className="nzc-status-empty nzc-status-ok">
              <Icon name="check" size={16} /> {t(locale, 'ds.attention.none')}
            </p>
          ) : (
            <ul>
              {attention.map((a) => (
                <li key={a.id}>
                  <a href={a.href}>
                    <span className="nzc-status-dot" data-tone={a.tone} aria-hidden="true" />
                    <span className="nzc-status-text">{a.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {servers && (
        <Card
          id="servers"
          icon="cloud"
          title={t(locale, 'ds.servers')}
          count={servers.count}
          href={`${base}/compute/instances`}
          locale={locale}
          rows={servers.rows}
          capped={servers.capped}
          emptyText={t(locale, 'ds.empty.servers')}
        />
      )}
      {domains && (
        <Card
          id="domains"
          icon="globe"
          title={t(locale, 'ds.domains')}
          count={domains.count}
          href={`${base}/domains`}
          locale={locale}
          rows={domains.rows}
          capped={domains.capped}
          emptyText={t(locale, 'ds.empty.domains')}
        />
      )}
      {sites && (
        <Card
          id="sites"
          icon="hosting"
          title={t(locale, 'ds.sites')}
          count={sites.count}
          href={`${base}/hosting/sites`}
          locale={locale}
          rows={sites.rows}
          capped={sites.capped}
          emptyText={t(locale, 'ds.empty.sites')}
        />
      )}
      {activity}
    </section>
  );
}
