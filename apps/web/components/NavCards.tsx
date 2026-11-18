import type { ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';

export interface NavCard {
  href: string;
  icon: IconName;
  title: string;
  desc: string;
  /** A short status line (a count, a state badge). */
  meta?: ReactNode;
  /** Shown but not clickable, with `meta` saying why (a feature that is not available yet). */
  disabled?: boolean;
}

/** A grid of cards that lead to the sections of a resource (a domain's DNS and contacts, a website's files and SSL, ...). */
export function NavCards({ label, items }: { label: string; items: NavCard[] }) {
  return (
    <nav className="nzc-navcards" aria-label={label}>
      {items.map((c) => {
        const inner = (
          <>
            <span className="nzc-navcard-icon">
              <Icon name={c.icon} size={20} />
            </span>
            <span className="nzc-navcard-body">
              <span className="nzc-navcard-title">{c.title}</span>
              <span className="nzc-navcard-desc">{c.desc}</span>
              {c.meta && <span className="nzc-navcard-meta">{c.meta}</span>}
            </span>
            {!c.disabled && (
              <span className="nzc-navcard-go" aria-hidden="true">
                <Icon name="chevron" size={16} />
              </span>
            )}
          </>
        );
        return c.disabled ? (
          <div key={c.href} className="nzc-navcard" aria-disabled="true">
            {inner}
          </div>
        ) : (
          <a key={c.href} className="nzc-navcard" href={c.href}>
            {inner}
          </a>
        );
      })}
    </nav>
  );
}
