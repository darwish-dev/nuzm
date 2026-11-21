'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import { BrandWordmark } from '../BrandLogo';

export interface MenuService {
  slug: string;
  icon: IconName;
  name: string;
  tagline: string;
}

/**
 * The header of the public pages. It is the landing page's own header (logo, quiet links, gradient button) with one addition: a Services menu that lists every
 * service page. The menu is a native <details>, so it works from the keyboard and without scripts; Escape closes it. The language link keeps the visitor on
 * the same page in the other language.
 */
export function SiteHeader({
  locale,
  otherLocale,
  services,
  labels,
}: {
  locale: string;
  otherLocale: { code: string; label: string; href: string };
  services: MenuService[];
  labels: {
    home: string;
    nav: string;
    services: string;
    allServices: string;
    login: string;
    start: string;
    menu: string;
    closeMenu: string;
    developers: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu.current?.open) menu.current.open = false;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <header className="site-header wrap svc-header">
      <a href={`/${locale}`} aria-label={labels.home} className="brand">
        <BrandWordmark />
      </a>
      <nav className={open ? 'main-nav is-open' : 'main-nav'} aria-label={labels.nav}>
        <details className="svc-menu" ref={menu}>
          <summary>
            {labels.services}
            <Icon name="chevron" size={12} />
          </summary>
          <div className="svc-menu-panel">
            {services.map((s) => (
              <a key={s.slug} href={`/${locale}/services/${s.slug}`} onClick={() => setOpen(false)}>
                <span className="svc-menu-icon">
                  <Icon name={s.icon} size={18} />
                </span>
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.tagline}</small>
                </span>
              </a>
            ))}
            <a className="svc-menu-all" href={`/${locale}/services`} onClick={() => setOpen(false)}>
              {labels.allServices}
              <Icon name="arrow" size={14} />
            </a>
          </div>
        </details>
        {services.slice(0, 4).map((s) => (
          <a key={s.slug} className="svc-nav-link" href={`/${locale}/services/${s.slug}`}>
            {s.name}
          </a>
        ))}
        <a className="svc-nav-link svc-nav-dev" href={`/${locale}/docs`}>
          {labels.developers}
        </a>
      </nav>
      <div className="header-actions">
        <a
          href={otherLocale.href}
          className="login-link svc-lang"
          lang={otherLocale.code}
          hrefLang={otherLocale.code}
        >
          {otherLocale.label}
        </a>
        <a href={`/${locale}/login`} className="login-link">
          {labels.login}
        </a>
        <a href={`/${locale}/register`} className="button button-white">
          {labels.start} <Icon name="sparkle" size={15} />
        </a>
        <button
          type="button"
          className="menu-toggle"
          aria-label={open ? labels.closeMenu : labels.menu}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'close' : 'menu'} size={22} />
        </button>
      </div>
    </header>
  );
}
