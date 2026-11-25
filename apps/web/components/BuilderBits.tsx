import type { ReactNode } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Ltr } from '@nuzm/ui';
import {
  deployTone,
  problemKey,
  runTone,
  type BuilderProblem,
  type Diff,
  type Risk,
} from '../lib/builder';

/** Section links of one builder project (UI-M09-03..08); the deployments tab is listed only for a member who may read deployments. */
export function BuilderTabs({
  locale,
  projectId,
  current,
  can,
}: {
  locale: Locale;
  projectId: string;
  current: 'workspace' | 'versions' | 'seo' | 'forms' | 'cms' | 'deployments';
  can: (permission: string) => boolean;
}) {
  const base = `/builder/projects/${projectId}`;
  const tabs = [
    { key: 'workspace', href: base, perm: 'builder:read' },
    { key: 'versions', href: `${base}/versions`, perm: 'builder:read' },
    { key: 'seo', href: `${base}/seo`, perm: 'builder:read' },
    { key: 'forms', href: `${base}/forms`, perm: 'builder:read' },
    { key: 'cms', href: `${base}/cms`, perm: 'builder:read' },
    { key: 'deployments', href: `${base}/deployments`, perm: 'deploy:read' },
  ] as const;
  return (
    <nav aria-label={t(locale, 'bld.nav.label')} className="nz-row">
      <a className="nz-btn" data-variant="secondary" href={`/builder/projects`}>
        {t(locale, 'bld.nav.allProjects')}
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
            {t(locale, `bld.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}

/** A problem mapped to a localized message by its code (never the raw server text), the validation issues of an invalid edit, and the trace id for support. */
export function ProblemNote({
  locale,
  problem,
  children,
}: {
  locale: Locale;
  problem: BuilderProblem;
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="nz-error-text">
      <strong>{t(locale, problemKey(problem))}</strong>
      {problem.issues.length > 0 && (
        <ul>
          {problem.issues.map((i, n) => (
            <li key={`${i.path}-${n}`}>
              <Ltr>{i.path || '—'}</Ltr> <bdi dir="auto">{i.message}</bdi>
            </li>
          ))}
        </ul>
      )}
      {children}
      {problem.traceId && (
        <p className="nz-muted">{t(locale, 'state.error.trace', { traceId: problem.traceId })}</p>
      )}
    </div>
  );
}

export function RiskList({ locale, risks }: { locale: Locale; risks: Risk[] }) {
  if (risks.length === 0) return null;
  return (
    <div>
      <h4 className="nz-h2">{t(locale, 'bld.diff.risks')}</h4>
      <ul className="bld-list">
        {risks.map((r, i) => (
          <li key={`${r.code}-${i}`}>
            <Badge tone="warn">
              {tDynamic(locale, `bld.risk.${r.code}`, r.code, { count: r.count })}
            </Badge>
            {r.detail ? (
              <span className="nz-muted">
                {' '}
                <bdi dir="ltr" lang="en">
                  {r.detail}
                </bdi>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const MAX_TEXT_ROWS = 20;

/** The safe diff of a change set or of two versions: structural changes and the rendered-text changes (shown as text, never as markup). */
export function DiffView({ locale, diff }: { locale: Locale; diff: Diff }) {
  if (diff.structural.length === 0 && diff.text.length === 0)
    return <p className="nz-muted">{t(locale, 'bld.diff.none')}</p>;
  const shown = diff.text.slice(0, MAX_TEXT_ROWS);
  return (
    <div>
      {diff.structural.length > 0 && (
        <>
          <h4 className="nz-h2">{t(locale, 'bld.diff.structural')}</h4>
          <ul className="bld-list">
            {diff.structural.map((d, i) => (
              <li key={`${d.kind}-${d.pageId ?? ''}-${d.sectionId ?? ''}-${i}`}>
                <Badge>{tDynamic(locale, `bld.diff.kind.${d.kind}`, d.kind)}</Badge>{' '}
                {d.pageId ? (
                  <Ltr>{d.sectionId ? `${d.pageId} / ${d.sectionId}` : d.pageId}</Ltr>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {shown.length > 0 && (
        <>
          <h4 className="nz-h2">{t(locale, 'bld.diff.text')}</h4>
          <ul className="bld-list">
            {shown.map((c, i) => (
              <li key={`${c.path}-${c.locale}-${i}`}>
                <Ltr>{`${c.path} (${c.locale})`}</Ltr>
                <div>
                  <span className="nz-muted">{t(locale, 'bld.diff.before')}</span>{' '}
                  <bdi dir="auto">{c.before ?? '—'}</bdi>
                </div>
                <div>
                  <span className="nz-muted">{t(locale, 'bld.diff.after')}</span>{' '}
                  <bdi dir="auto">{c.after ?? '—'}</bdi>
                </div>
              </li>
            ))}
          </ul>
          {diff.text.length > shown.length && (
            <p className="nz-muted">
              {t(locale, 'bld.diff.more', { count: diff.text.length - shown.length })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export const RunBadge = ({ locale, state }: { locale: Locale; state: string }) => (
  <Badge tone={runTone(state)}>{tDynamic(locale, `bld.run.state.${state}`, state)}</Badge>
);
export const DeployBadge = ({ locale, state }: { locale: Locale; state: string }) => (
  <Badge tone={deployTone(state)}>{tDynamic(locale, `bld.dep.state.${state}`, state)}</Badge>
);

/** Date-time in the page language, or a dash. */
export const when = (iso: string | null | undefined, locale: Locale): string =>
  iso ? formatDateTime(iso, locale) : '—';

export const ReadOnlyBanner = ({ locale }: { locale: Locale }) => (
  <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>
);
