import type { ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, PageTitle } from '@nuzm/ui';
import { GUIDES, doc } from '../../lib/docs-content';
import { REF } from '../../lib/api-docs';
import { pick } from '../../lib/site-content';
import './console-docs.css';

/** Where the documentation lives inside the console. The public website keeps its own copy at `/<locale>/docs`. */
export const CONSOLE_DOCS = '/documentation';

/**
 * The website documentation, inside the console: the same guides and API reference (the same content modules as the public `/docs` pages), drawn in the
 * console's own frame and colors so a member reads them without leaving the dashboard. Links stay inside the console copy; the website version is one
 * click away.
 */
export function ConsoleDocsFrame({
  locale,
  path,
  sitePath,
  crumb,
  title,
  lead,
  children,
}: {
  locale: Locale;
  /** the page inside the console copy, `/documentation/guides/errors` (marks the open page in the side list) */
  path: string;
  /** the same page on the public website, without the locale: `/docs/guides/errors` */
  sitePath: string;
  crumb?: { label: string; href: string };
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  const link = (href: string, label: string) => (
    <a key={href} href={href} aria-current={path === href ? 'page' : undefined}>
      {label}
    </a>
  );
  const inReference = path.startsWith(`${CONSOLE_DOCS}/reference`);
  return (
    <div className="cdoc">
      <nav className="cdoc-side" aria-label={t(locale, 'cdoc.nav')}>
        <p className="cdoc-side-title">{doc('guidesNav', locale)}</p>
        {link(CONSOLE_DOCS, doc('docs', locale))}
        {GUIDES.map((g) => link(`${CONSOLE_DOCS}/guides/${g.slug}`, pick(g.title, locale)))}
        <p className="cdoc-side-title">{doc('reference', locale)}</p>
        {link(`${CONSOLE_DOCS}/reference`, doc('apiRef', locale))}
        <details open={inReference}>
          <summary>
            {doc('endpointsTitle', locale)}
            <Icon name="chevron" size={14} />
          </summary>
          {REF.tags.map((x) => link(`${CONSOLE_DOCS}/reference/${x.name}`, x.title))}
        </details>
        <p className="cdoc-side-title">{doc('downloads', locale)}</p>
        <a href={`/${locale}/docs/openapi.json`} download="nuzm-openapi.json">
          {doc('downloadOpenapi', locale)}
        </a>
        <a href={`/${locale}/docs/postman.json`} download="nuzm-postman-collection.json">
          {doc('downloadPostman', locale)}
        </a>
      </nav>
      <div className="cdoc-main">
        <div className="cdoc-head">
          <div>
            {crumb ? (
              <a className="cdoc-crumb" href={crumb.href}>
                <Icon name="book" size={14} />
                {crumb.label}
              </a>
            ) : (
              <span className="cdoc-crumb">
                <Icon name="book" size={14} />
                {t(locale, 'cdoc.title')}
              </span>
            )}
            <PageTitle>{title}</PageTitle>
            {lead && <p className="cdoc-lead">{lead}</p>}
          </div>
          <a
            className="cdoc-web"
            href={`/${locale}${sitePath}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(locale, 'cdoc.onWebsite')}
            <Icon name="external" size={14} />
          </a>
        </div>
        <div className="doc-content">{children}</div>
      </div>
    </div>
  );
}
