'use client';
import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { landingText } from '../../lib/landing-text';
import { site } from '../../lib/site-content';
import { BrandWordmark } from '../BrandLogo';

/**
 * THE footer of the public website: the home page's own, used unchanged on the home page and on every services page (one design, one source). `home` is true on
 * the home page, where the in-page anchors stay `#agents`; everywhere else they lead to the home page's sections. The appearance switch belongs to the page
 * that renders the footer (`dark` and `onToggleTheme`).
 */
export function SiteFooter({
  locale,
  home = false,
  langHref,
  dark,
  onToggleTheme,
}: {
  locale: Locale;
  home?: boolean;
  /** the same page in the other language */
  langHref: string;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const d = landingText(locale);
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const at = (id: string) => (home ? `#${id}` : `/#${id}`);
  return (
    <footer className="site-footer">
      <div className="footer-horizon" aria-hidden="true" />
      <div className="wrap footer-inner">
        <div className="footer-invitation">
          <span className="eyebrow">{d.footEyebrow}</span>
          <h2>
            {d.footTitle1}
            <br />
            <em>{d.footTitle2}</em>
          </h2>
        </div>
        <div className="footer-links">
          <div className="footer-brand">
            <a href="/" className="brand" aria-label={site('home', locale)}>
              <BrandWordmark />
            </a>
            <p>
              {d.footBrand1}
              <br />
              {d.footBrand2}
            </p>
          </div>
          <div>
            <h3>{d.footExploreTitle}</h3>
            <a href={at('agents')}>{d.footExplore[0]}</a>
            <a href="/automation/workflows">{d.footExplore[1]}</a>
            <a href="/builder/projects">{d.footExplore[2]}</a>
            <a href={at('integrations')}>{d.footExplore[3]}</a>
          </div>
          <div>
            <h3>{d.footBuildTitle}</h3>
            <a href="/services/cloud">{d.footBuild[0]}</a>
            <a href="/services/domains">{d.footBuild[1]}</a>
            <a href="/services/hosting">{d.footBuild[2]}</a>
            <a href="/services/ai-builder">{d.footBuild[3]}</a>
            <a href="/services">{d.footBuild[4]}</a>
          </div>
          <div>
            <h3>{d.footWorkspaceTitle}</h3>
            <a href="/designs">{d.footDesigns}</a>
            <a href="/login">{d.footLogin}</a>
            <a href="/register">{d.footStart}</a>
            <a href={langHref} lang={other} hrefLang={other}>
              {site('language', locale)}
            </a>
            <button
              type="button"
              className="theme-button"
              onClick={onToggleTheme}
              aria-label={dark ? d.themeLight : d.themeDark}
            >
              <Icon name={dark ? 'sun' : 'moon'} size={16} />
              {dark ? d.themeLight : d.themeDark}
            </button>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} {locale === 'ar' ? 'نظم' : 'Nuzm'}. {d.rights}
          </span>
          <span>{d.built}</span>
          <a href="#main">
            {d.top} <Icon name="send" size={13} />
          </a>
        </div>
        <div className="footer-wordmark" aria-hidden="true">
          nuzm<span>®</span>
        </div>
      </div>
    </footer>
  );
}
