import type { ReactNode } from 'react';
import { locales, type Locale } from '@nuzm/i18n';
import { doc } from '../../lib/docs-content';
import { SERVICES, pick, site } from '../../lib/site-content';
import { FrameFooter } from './FrameFooter';
import { SiteHeader } from './SiteHeader';

/**
 * The frame of every public page: the landing page's own look (its sky, header, buttons and footer, so the identity is the same), a Services menu, and the
 * same page in the other language one click away. `path` is the page's address without the locale (`/services/hosting`).
 */
export function SiteFrame({
  locale,
  path,
  mode,
  hero,
  children,
}: {
  locale: Locale;
  path: string;
  mode: 'dark' | 'light';
  hero: ReactNode;
  children: ReactNode;
}) {
  const other = locales.find((l) => l !== locale) ?? 'en';
  return (
    <div className="landing svc-site" data-mode={mode}>
      <a className="skip-link" href="#main">
        {site('skip', locale)}
      </a>
      <div className="svc-topbar">
        <SiteHeader
          locale={locale}
          otherLocale={{
            code: other,
            label: site('language', locale),
            href: `/${other}${path}`,
          }}
          services={SERVICES.map((s) => ({
            slug: s.slug,
            icon: s.icon,
            name: pick(s.name, locale),
            tagline: pick(s.tagline, locale),
          }))}
          labels={{
            home: site('home', locale),
            nav: site('nav', locale),
            services: site('services', locale),
            allServices: site('allServices', locale),
            login: site('login', locale),
            start: site('start', locale),
            menu: site('menu', locale),
            closeMenu: site('closeMenu', locale),
            developers: doc('developers', locale),
          }}
        />
      </div>
      <main id="main">
        <section className="hero svc-hero">
          <div className="sky" aria-hidden="true">
            <div className="horizon" />
            <div className="star-field" />
          </div>
          <div className="svc-hero-body wrap">{hero}</div>
        </section>
        {children}
      </main>
      <FrameFooter locale={locale} initial={mode} langHref={`/${other}${path}`} />
    </div>
  );
}
