import type { ReactNode } from 'react';
import { Icon } from '@nuzm/ui';
import { locales, type Locale } from '@nuzm/i18n';
import { doc } from '../../lib/docs-content';
import { SERVICES, pick, site } from '../../lib/site-content';
import { BrandWordmark } from '../BrandLogo';
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
  const year = new Date().getFullYear();
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
      <footer className="site-footer">
        <div className="footer-horizon" aria-hidden="true" />
        <div className="wrap footer-inner">
          <div className="footer-invitation">
            <span className="eyebrow">{site('ctaEyebrow', locale)}</span>
            <h2>{site('ctaTitle', locale)}</h2>
            <p className="svc-cta-text">{site('ctaText', locale)}</p>
            <a className="button button-blue" href={`/${locale}/register`}>
              {site('start', locale)} <Icon name="sparkle" size={16} />
            </a>
          </div>
          <div className="footer-links svc-footer-links">
            <div className="footer-brand">
              <a href={`/${locale}`} className="brand" aria-label={site('home', locale)}>
                <BrandWordmark />
              </a>
              <p>{site('footerTagline', locale)}</p>
            </div>
            <div>
              <h3>{site('footerServices', locale)}</h3>
              {SERVICES.map((s) => (
                <a key={s.slug} href={`/${locale}/services/${s.slug}`}>
                  {pick(s.name, locale)}
                </a>
              ))}
            </div>
            <div>
              <h3>{site('footerAccount', locale)}</h3>
              <a href={`/${locale}/login`}>{site('login', locale)}</a>
              <a href={`/${locale}/register`}>{site('start', locale)}</a>
              <a href={`/${locale}/docs`}>{doc('developers', locale)}</a>
              <a href={`/${other}${path}`} lang={other} hrefLang={other}>
                {site('language', locale)}
              </a>
            </div>
          </div>
          <div className="footer-bottom">
            <span>
              © {year} Nuzm. {site('rights', locale)}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
