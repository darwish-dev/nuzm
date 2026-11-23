import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { BuilderStart } from '../components/BuilderStart';
import { ProjectCards } from '../components/BuilderProjects';
import { FilterableProjects } from '../components/ProjectList';
import { APP_BUILDER_FLAG } from './appbuilder';
import { MOBILE_FLAG } from './mobile';
import { AI_STUDIO_FLAG } from './ai-studio';
import { applyFilter, filterOf, type ProjectFilter } from './appworkspace';
import { one, unwrapCall } from './compute';
import type { Credits, Page_, Project } from './builder';
import { builderGuard, builderView } from './builder-view';
import { flagEnabled } from './services';

/**
 * UI-M09-01/02 + UI-M10-01 (merged): "Start a project". One prompt box (the project type, the first AI run and the workspace follow from it, no wizard), then the
 * organization's existing projects, filterable by type. `/builder/projects` shows every type; `/builder/apps` is the same screen for web apps (the App builder
 * navigation entry, shown only while `app_builder.enabled` is on) with the web-app tile preselected. A person who can read but not write sees only the list.
 */
export async function ProjectsScreen({
  params,
  searchParams,
  fixed,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  /** the page is the web-app entry: the filter is `webapp` and the app tile is preselected */
  fixed?: 'webapp';
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.start.title');
  if (!g.ok) return g.denied;
  const appsOn = flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG);
  const mobileOn = flagEnabled(g.s.me.featureFlags, MOBILE_FLAG);
  const filter: ProjectFilter = fixed ?? filterOf(one(sp.type));
  // the Mobile apps entry (`?type=mobile`) opens the start screen with the Mobile tile selected, the web-app entry with the web-app tile
  const startType =
    fixed === 'webapp' && appsOn
      ? 'webapp'
      : filter === 'mobile' && mobileOn
        ? 'mobile'
        : 'website';
  const canCreate = g.s.can('builder:write');
  const canRun = canCreate && g.s.can('ai:write');
  const body = await builderView(
    locale,
    async () => {
      const page = await unwrapCall(
        g.c.get<Page_<Project>>('/v1/builder/projects', {
          query: { limit: 24, cursor: one(sp.cursor) || undefined },
        }),
      );
      // the balance is informational: a failure to read it must not block the screen
      let wallet: Credits | null = null;
      if (canRun) {
        const r = await g.c.get<Credits>('/v1/ai/credits');
        wallet = r.response.ok ? (r.data ?? null) : null;
      }
      return { page, wallet };
    },
    ({ page, wallet }) => {
      // the web-app entry has no filter row: its list is fixed. Everywhere else the list filters in place on the client (no reload).
      const list = fixed ? (
        <ProjectCards
          locale={locale}
          items={applyFilter(page.items, filter)}
          nextCursor={page.nextCursor}
          canCreate={canCreate}
          canDelete={canCreate}
          mfaFactorId={g.s.me.mfaFactorId ?? null}
          filtered={filter !== 'all'}
        />
      ) : (
        <FilterableProjects
          locale={locale}
          items={page.items}
          nextCursor={page.nextCursor}
          canCreate={canCreate}
          canDelete={canCreate}
          mfaFactorId={g.s.me.mfaFactorId ?? null}
          appsEnabled={appsOn}
          mobileEnabled={mobileOn}
          initial={filter}
        />
      );
      // a filter or a page of results means the person is browsing their projects: open that tab
      const browsing = filter !== 'all' || Boolean(one(sp.cursor));
      return canCreate ? (
        <BuilderStart
          locale={locale}
          credits={wallet}
          canRun={canRun}
          appsEnabled={appsOn}
          mobileEnabled={mobileOn}
          key={startType}
          initialType={startType}
          projects={list}
          projectCount={page.items.length}
          initialTab={browsing || page.items.length > 0 ? 'projects' : 'examples'}
          githubEnabled={flagEnabled(g.s.me.featureFlags, AI_STUDIO_FLAG)}
        />
      ) : (
        <div className="bl-readonly">{list}</div>
      );
    },
  );
  return (
    <>
      {/* full screen: the console's sidebar and top bar step aside (see `.bfs-float`); the only chrome is a floating way out at the bottom */}
      <a className="bfs-float" href={`/console`}>
        <Icon name="close" size={16} />
        {t(locale, 'bld.ws.exit')}
      </a>
      {/* the heading stays for screen readers and the page title, but is not drawn */}
      <h1 className="nz-sr">{t(locale, fixed ? 'm10a.apps.title' : 'bld.start.title')}</h1>
      {body}
    </>
  );
}
