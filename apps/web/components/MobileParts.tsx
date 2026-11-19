import type { ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Ltr } from '@nuzm/ui';
import type { BuilderProblem } from '../lib/builder';
import { mobileProblemKey, missingLabel } from '../lib/mobile';

/** Section links of one mobile project (UI-M10-13..17). The signing tab is listed only for a member who holds `mobile:signing`. */
export function MobileTabs({
  locale,
  projectId,
  current,
  can,
}: {
  locale: Locale;
  projectId: string;
  current: 'preview' | 'builds' | 'signing' | 'releases';
  can: (permission: string) => boolean;
}) {
  const base = `/${locale}/mobile/${projectId}`;
  const tabs = [
    { key: 'preview', href: `${base}/preview`, perm: 'builder:read' },
    { key: 'builds', href: `${base}/builds`, perm: 'mobile:build' },
    { key: 'signing', href: `${base}/signing`, perm: 'mobile:signing' },
    { key: 'releases', href: `${base}/releases`, perm: 'mobile:release' },
  ] as const;
  return (
    <nav aria-label={t(locale, 'mobile.tab.label')} className="nz-row">
      <a className="nz-btn" data-variant="secondary" href={`/${locale}/mobile/new`}>
        {t(locale, 'mobile.back')}
      </a>
      {tabs
        .filter((x) => can(x.perm))
        .map((x) => (
          <a
            key={x.key}
            className="nz-btn"
            data-variant={x.key === current ? 'primary' : 'secondary'}
            href={x.href}
            aria-current={x.key === current ? 'page' : undefined}
          >
            {t(locale, `mobile.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}

/** A failed call as a localized message (by code, never the raw server text), the checklist items it names, and the trace id for support. */
export function MobileProblem({
  locale,
  problem,
  items = [],
  children,
}: {
  locale: Locale;
  problem: BuilderProblem;
  items?: string[];
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="nz-error-text">
      <strong>{t(locale, mobileProblemKey(problem))}</strong>
      {items.length > 0 && <MissingList locale={locale} items={items} />}
      {children}
      {problem.traceId && (
        <p className="nz-muted">{t(locale, 'state.error.trace', { traceId: problem.traceId })}</p>
      )}
    </div>
  );
}

/** The checklist items that are missing, named in the user's language (an unknown item is shown as its id). */
export function MissingList({ locale, items }: { locale: Locale; items: string[] }) {
  if (items.length === 0) return <p>{t(locale, 'mobile.releases.nothingMissing')}</p>;
  return (
    <ul aria-label={t(locale, 'mobile.releases.missing')}>
      {items.map((i) => (
        <li key={i}>{missingLabel(locale, i)}</li>
      ))}
    </ul>
  );
}

/** The permanent statement of what a release record is: it prepares, the person submits. */
export function NoSubmitNotice({ locale }: { locale: Locale }) {
  return <Banner tone="warn">{t(locale, 'mobile.releases.noSubmit')}</Banner>;
}

export const Mono = ({ children }: { children: ReactNode }) => <Ltr>{children}</Ltr>;
