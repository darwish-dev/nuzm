import type { ReactNode } from 'react';
import { Icon } from '@nuzm/ui';
import { locales, type Locale } from '@nuzm/i18n';
import { BrandWordmark } from '../BrandLogo';
import { DocsSearch, type SearchEntry } from '../docs/DocsSearch';
import { DocsToc, type TocItem } from '../docs/DocsToc';
import { HelpfulRating } from '../docs/HelpfulRating';
import { ThemeToggle } from '../docs/ThemeToggle';
import { DocsSidebar } from '../docs/DocsParts';
import { GUIDES, doc } from '../../lib/docs-content';
import { REF } from '../../lib/api-docs';
import { pick, site } from '../../lib/site-content';

/**
 * A documentation page, laid out like a documentation site rather than a marketing page: a slim top bar (a back arrow to the website, the logo, search), the
 * guides and the API areas on one side, the page in the middle, and "On this page" with the helpfulness rating on the other. The Nuzm identity is the landing
 * page's own (its colors, fonts and buttons).
 */
export function DocsFrame({
  locale,
  path,
  mode,
  crumb,
  title,
  lead,
  art,
  toc = [],
  children,
}: {
  locale: Locale;
  /** the page's address without the locale, `/docs/guides/errors` */
  path: string;
  mode: 'dark' | 'light';
  crumb?: { label: string; href: string };
  title: string;
  lead?: string;
  /** an illustration shown beside the title (the documentation home) */
  art?: string;
  toc?: TocItem[];
  children: ReactNode;
}) {
  const other = locales.find((l) => l !== locale) ?? 'en';
  const entries: SearchEntry[] = [
    ...GUIDES.map((g) => ({
      title: pick(g.title, locale),
      sub: pick(g.summary, locale),
      href: `/${locale}/docs/guides/${g.slug}`,
      kind: doc('kindGuide', locale),
    })),
    ...REF.operations.map((o) => ({
      title: o.summary || o.id,
      sub: `${o.method} ${o.path}`,
      href: `/${locale}/docs/reference/${o.tag}#${o.id}`,
      kind: REF.tags.find((t) => t.name === o.tag)?.title ?? o.tag,
    })),
  ];
  return (
    <div className="landing doc-app" data-mode={mode}>
      <a className="skip-link" href="#main">
        {site('skip', locale)}
      </a>
      <header className="doc-top">
        <a
          className="doc-back"
          href={`/${locale}`}
          aria-label={doc('backToSite', locale)}
          title={doc('backToSite', locale)}
        >
          <Icon name="arrow" size={18} />
        </a>
        <a className="brand doc-brand" href={`/${locale}/docs`} aria-label={doc('docs', locale)}>
          <BrandWordmark />
          <span>{doc('docs', locale)}</span>
        </a>
        <DocsSearch
          entries={entries}
          labels={{
            placeholder: doc('searchPlaceholder', locale),
            empty: doc('searchEmpty', locale),
            results: doc('searchResults', locale),
          }}
        />
        <a className="doc-lang" href={`/${other}${path}`} lang={other} hrefLang={other}>
          {site('language', locale)}
        </a>
      </header>
      <div className="doc-body">
        <DocsSidebar locale={locale} path={path} />
        <main id="main" className="doc-main">
          {crumb && (
            <a className="doc-crumb" href={crumb.href}>
              {crumb.label}
            </a>
          )}
          <div className={art ? 'doc-head doc-head-art' : 'doc-head'}>
            <div>
              <h1>{title}</h1>
              {lead && <p className="doc-lead">{lead}</p>}
            </div>
            {art && <img className="doc-art" src={art} alt="" width={380} height={290} />}
          </div>
          <div className="doc-content">{children}</div>
        </main>
        <aside className="doc-aside">
          <DocsToc items={toc} title={doc('onThisPage', locale)} />
          <HelpfulRating
            page={path}
            locale={locale}
            labels={{
              question: doc('rateQuestion', locale),
              good: doc('rateGood', locale),
              okay: doc('rateOkay', locale),
              bad: doc('rateBad', locale),
              thanks: doc('rateThanks', locale),
            }}
          />
        </aside>
      </div>
      <ThemeToggle
        initial={mode}
        labels={{
          light: doc('themeLight', locale),
          dark: doc('themeDark', locale),
          group: doc('themeGroup', locale),
        }}
      />
    </div>
  );
}
