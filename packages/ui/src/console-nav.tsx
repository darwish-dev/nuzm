import type { ReactNode } from 'react';
import { CountUp, RailTips } from './client';
import { Icon, type IconName } from './icons';

/** Presentational pieces of the two-level navigation (icon rail + in-page section tabs). The current page comes from the caller (server-computed), never from client state. */

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
      <RailTips />
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
  /** An item with children is a dropdown tab (native <details>: keyboard and screen-reader friendly, no script needed to open it). */
  children?: SideItem[];
}
export interface SideGroup {
  id: string;
  title?: string;
  items: SideItem[];
}

function TabLink({ item }: { item: SideItem }) {
  const kids = item.children ?? [];
  // a group of one is just a tab
  if (kids.length === 1) return <TabLink item={kids[0]!} />;
  if (kids.length > 1) {
    const active = kids.find((c) => c.current);
    return (
      <details className="nzc-tab-menu">
        <summary className="nzc-tab" data-current={active ? 'true' : undefined}>
          <span>{item.label}</span>
          <Icon name="chevron" size={14} />
        </summary>
        <ul>
          {kids.map((c) => (
            <li key={c.id}>
              <a href={c.href} aria-current={c.current ? 'page' : undefined}>
                {c.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return (
    <a className="nzc-tab" href={item.href} aria-current={item.current ? 'page' : undefined}>
      {item.label}
    </a>
  );
}

/**
 * The selected category's pages as tabs at the top of the page content. Groups are separated by a divider; an item with several
 * children opens a small menu. Renders nothing when the category has no pages for this user.
 */
export function SectionTabs({ label, groups }: { label: string; groups: SideGroup[] }) {
  const items = groups.flatMap((g) => g.items.map((i) => ({ group: g.id, item: i })));
  // a single page needs no tabs
  if (items.length === 0 || (items.length === 1 && !items[0]!.item.children?.length)) return null;
  return (
    <nav className="nzc-tabs" aria-label={label}>
      <ul>
        {items.map(({ group, item }, n) => (
          <li
            key={`${group}:${item.id}`}
            data-group-start={n > 0 && items[n - 1]!.group !== group ? 'true' : undefined}
          >
            <TabLink item={item} />
          </li>
        ))}
      </ul>
    </nav>
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
      <span className="nzc-stat-value">
        {typeof value === 'string' && /^\d{1,9}$/.test(value) ? (
          <CountUp value={Number(value)} />
        ) : (
          value
        )}
      </span>
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
