'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import { BrandWordmark } from '../BrandLogo';
import { ServiceMegaMenu } from './ServiceMegaMenu';

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
  const builderMenu = useRef<HTMLDetailsElement>(null);
  const header = useRef<HTMLElement>(null);
  const closeMenus = () => {
    if (menu.current) menu.current.open = false;
    if (builderMenu.current) builderMenu.current.open = false;
    setOpen(false);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeMenus();
    };
    const outside = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) closeMenus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', outside);
    };
  }, []);
  return (
    <header ref={header} className="site-header wrap svc-header">
      <a href={`/?lang=${locale}`} aria-label={labels.home} className="brand">
        <BrandWordmark />
      </a>
      <nav className={open ? 'main-nav is-open' : 'main-nav'} aria-label={labels.nav}>
        <details
          className="svc-menu"
          ref={menu}
          onToggle={(e) => {
            if (e.currentTarget.open && builderMenu.current) builderMenu.current.open = false;
          }}
        >
          <summary>
            {labels.services}
            <Icon name="chevron" size={12} />
          </summary>
          <ServiceMegaMenu services={services} locale={locale} close={closeMenus} />
        </details>
        <details
          className="svc-menu builder-menu"
          ref={builderMenu}
          onToggle={(e) => {
            if (e.currentTarget.open && menu.current) menu.current.open = false;
          }}
        >
          <summary>
            {locale === 'ar' ? 'منشئ الذكاء الاصطناعي' : 'AI Builder'}
            <Icon name="chevron" size={12} />
          </summary>
          <ServiceMegaMenu services={services} locale={locale} builders close={closeMenus} />
        </details>
        {(
          [
            ['blog', 'المدونة', 'Blog'],
            ['academy', 'الأكاديمية', 'Academy'],
            ['community', 'المجتمع', 'Community'],
          ] as const
        ).map(([path, ar, en]) => (
          <a key={path} className="svc-nav-link" href={`/${locale}/${path}`}>
            {locale === 'ar' ? ar : en}
          </a>
        ))}
        <a className="svc-nav-link svc-nav-dev" href={`/${locale}/docs`}>
          {locale === 'ar' ? 'التوثيق' : 'Documentation'}
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
