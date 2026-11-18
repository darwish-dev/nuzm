import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** Presentational pieces of the dual-level navigation. The current page comes from the caller (server-computed), never from client state. */

export interface RailItem {
  id: string;
  href: string;
  /** Accessible name AND tooltip. */
  label: string;
  icon: IconName;
  current: boolean;
  /** Small count shown on the icon (unread notifications). */
  badge?: number;
}

function RailLink({ item }: { item: RailItem }) {
  return (
    <a
      className="nzc-rail-link"
      href={item.href}
      aria-label={item.badge ? `${item.label} (${item.badge})` : item.label}
      aria-current={item.current ? 'page' : undefined}
      data-tip={item.label}
    >
      <Icon name={item.icon} />
      {item.badge ? (
        <span className="nzc-dot" aria-hidden="true">
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      ) : null}
    </a>
  );
}

/** Narrow icon-only primary rail: the categories on top and, optionally, pinned utilities at the bottom. The brand and the account live in the top bar. */
export function PrimaryRail({
  label,
  items,
  utilities = [],
}: {
  label: string;
  items: RailItem[];
  /** Optional icons pinned to the bottom of the rail. */
  utilities?: RailItem[];
}) {
  return (
    <nav className="nzc-rail" aria-label={label}>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <RailLink item={i} />
          </li>
        ))}
      </ul>
      <span className="nzc-grow" />
      <ul>
        {utilities.map((i) => (
          <li key={i.id}>
            <RailLink item={i} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface SideItem {
  id: string;
  href?: string;
  label: string;
  current?: boolean;
  /** An item with children is an expandable group (native <details>: keyboard and screen-reader friendly, no script). */
  children?: SideItem[];
}
export interface SideGroup {
  id: string;
  title?: string;
  items: SideItem[];
}

function SideLink({ item }: { item: SideItem }) {
  if (item.children && item.children.length > 0) {
    const open = item.children.some((c) => c.current);
    return (
      <details open={open}>
        <summary>
          <span>{item.label}</span>
          <Icon name="chevron" size={16} />
        </summary>
        <ul>
          {item.children.map((c) => (
            <li key={c.id}>
              <SideLink item={c} />
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <a href={item.href} aria-current={item.current ? 'page' : undefined}>
      {item.label}
    </a>
  );
}

/** Wide contextual sidebar for the selected category. */
export function ContextSidebar({
  title,
  label,
  groups,
}: {
  title: string;
  label: string;
  groups: SideGroup[];
}) {
  return (
    <aside className="nzc-side">
      <nav aria-label={label}>
        <h2>{title}</h2>
        {groups.map((g) => (
          <div className="nzc-group" key={g.id}>
            {g.title && <p className="nzc-group-title">{g.title}</p>}
            <ul>
              {g.items.map((i) => (
                <li key={i.id}>
                  <SideLink item={i} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** Dashboard stat tile: a label, one prominent figure and a line of context. A link when `href` is given. */
export function StatTile({
  label,
  value,
  sub,
  icon,
  href,
  featured,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: IconName;
  href?: string;
  /** The one highlighted tile of a row (the glowing gradient card). */
  featured?: boolean;
}) {
  const inner = (
    <>
      <span className="nzc-stat-label">
        {icon && <Icon name={icon} size={16} />}
        {label}
      </span>
      <span className="nzc-stat-value">{value}</span>
      {sub && <span className="nzc-stat-sub">{sub}</span>}
    </>
  );
  return href ? (
    <a className="nzc-stat" href={href} data-featured={featured || undefined}>
      {inner}
    </a>
  ) : (
    <div className="nzc-stat" data-featured={featured || undefined}>
      {inner}
    </div>
  );
}
