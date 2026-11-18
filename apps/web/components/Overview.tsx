import type { ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';

/**
 * The building blocks of a resource's detail page (the domain page's layout, shared by websites, servers and databases):
 * a main column of action panels and a side column with a summary card and smaller panels. Presentational only (no hooks),
 * so both server pages and client components can use them.
 */

export function OverviewLayout({
  main,
  side,
  sideLabel,
}: {
  main: ReactNode;
  side: ReactNode;
  sideLabel: string;
}) {
  return (
    <div className="nzc-ov">
      <div className="nzc-ov-main">{main}</div>
      <aside className="nzc-ov-side" aria-label={sideLabel}>
        {side}
      </aside>
    </div>
  );
}

/** A ring gauge: `percent` filled, a big value in the middle and a small caption under it. */
export function Ring({
  percent,
  value,
  caption,
  label,
  tone = 'accent',
}: {
  percent: number;
  value: ReactNode;
  caption?: string;
  /** What the ring means, for assistive technology. */
  label: string;
  tone?: 'accent' | 'warn' | 'danger';
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, percent / 100));
  return (
    <div
      className="nzc-ring"
      role="img"
      aria-label={label}
      style={{ ['--ring' as string]: `var(--nzc-${tone})` }}
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
        <span>
          <strong>{value}</strong>
          {caption}
        </span>
      </span>
    </div>
  );
}

export interface SummaryRow {
  icon: IconName;
  label: string;
  value: ReactNode;
}

/** The side column's first card: name (with an optional external link), badges, an optional gauge block, then label/value rows. */
export function SummaryCard({
  name,
  link,
  linkLabel,
  badges,
  gauge,
  rows,
  children,
}: {
  name: ReactNode;
  link?: string;
  linkLabel?: string;
  badges?: ReactNode;
  /** A ring (or tiles) with its text: shown above the rows. */
  gauge?: ReactNode;
  rows: SummaryRow[];
  children?: ReactNode;
}) {
  return (
    <section className="nzc-panel">
      <div className="nzc-side-name">
        <strong>
          <span dir="auto">{name}</span>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" aria-label={linkLabel}>
              <Icon name="external" size={16} />
            </a>
          )}
        </strong>
        {badges && <span className="nzc-side-badges">{badges}</span>}
      </div>
      {gauge && <div className="nzc-expiry">{gauge}</div>}
      <dl className="nzc-side-rows">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>
              <Icon name={r.icon} size={16} />
              {r.label}
            </dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}

/** A smaller side card: a title, an optional link on the other side, then its content. */
export function SidePanel({
  title,
  link,
  linkLabel,
  children,
}: {
  title: string;
  link?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="nzc-panel">
      <div className="nzc-panel-head">
        <h3>{title}</h3>
        {link && linkLabel && <a href={link}>{linkLabel}</a>}
      </div>
      {children}
    </section>
  );
}

/** A main-column panel: a title, a line under it, then rows. */
export function ActionPanel({
  id,
  title,
  sub,
  children,
}: {
  id: string;
  title: ReactNode;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section className="nzc-panel" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {sub && <p className="nzc-panel-sub">{sub}</p>}
      <div className="nzc-actions">{children}</div>
    </section>
  );
}

/** One row of an action panel: icon, title and description, then the control (a link, a button, or a "not available" badge). */
export function ActionRow({
  icon,
  title,
  desc,
  action,
  featured,
  tone,
}: {
  icon: IconName;
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  featured?: boolean;
  tone?: 'warn' | 'danger';
}) {
  return (
    <div className="nzc-action" data-featured={featured || undefined} data-tone={tone}>
      <span className="nzc-action-icon">
        <Icon name={icon} size={22} />
      </span>
      <span>
        <span className="nzc-action-title">{title}</span>
        {desc && <span className="nzc-action-desc">{desc}</span>}
      </span>
      {action ?? <span />}
    </div>
  );
}

/** The "Get started →" style link of an action row. */
export function ActionLink({
  href,
  label,
  primary,
}: {
  href: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <a className="nz-btn" data-variant={primary ? 'primary' : 'secondary'} href={href}>
      {label}
      <Icon name="arrow" size={16} />
    </a>
  );
}

/** Small spec tiles (vCPU, memory, disk): a value with its caption. */
export function SpecTiles({ items }: { items: { value: ReactNode; caption: string }[] }) {
  return (
    <div className="nzc-spec-tiles">
      {items.map((x) => (
        <div key={x.caption}>
          <strong>{x.value}</strong>
          <span>{x.caption}</span>
        </div>
      ))}
    </div>
  );
}
