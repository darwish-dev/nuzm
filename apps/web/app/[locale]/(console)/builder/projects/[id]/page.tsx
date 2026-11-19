import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { NotEnabledState } from '../../../../../../components/BuilderParts';
import { WebAppWorkspace } from '../../../../../../components/WebAppWorkspace';
import { MobileWorkspace } from '../../../../../../components/MobileWorkspace';
import { Workspace } from '../../../../../../components/BuilderWorkspace';
import { APP_BUILDER_FLAG } from '../../../../../../lib/appbuilder';
import { latestWebappRun } from '../../../../../../lib/appworkspace';
import { appTab, appTabsFor } from '../../../../../../lib/webapp-workspace';
import type { Message, Page_, ProjectDetail, Run, Session } from '../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../lib/builder-view';
import { isUuid, one, unwrapCall } from '../../../../../../lib/compute';
import { MOBILE_FLAG, workspaceTab } from '../../../../../../lib/mobile';
import { MobileUnavailable } from '../../../../../../lib/mobile-view';
import { flagEnabled } from '../../../../../../lib/services';

/**
 * The builder workspace, one route for every project type. A website (UI-M09-03): chat and run timeline, sandboxed preview, outline and inspector, code and diff. A web
 * app (UI-M10-02/06): the same shell with the live agent graph of the build, its approvals and the former app pages as panels. A mobile app: the same shell with the
 * design request and live run, a phone preview, the Flutter files, the spec, builds, signing and releases. `?tab=` picks the panel of the web-app and mobile modes.
 */
export default async function ProjectWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  const sp = await searchParams;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.title.workspace');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    async () => {
      const detail = await unwrapCall(g.c.get<ProjectDetail>(`/v1/builder/projects/${id}`));
      // the conversation and the latest run are context: if they cannot be read (no `ai:read`), the workspace still opens
      const runs = await g.c.get<Page_<Run>>('/v1/ai/runs', {
        query: { projectId: id, limit: 20 },
      });
      const sessions = await g.c.get<Page_<Session>>('/v1/ai/sessions', { query: { limit: 100 } });
      const session =
        (sessions.response.ok ? sessions.data?.items : undefined)?.find(
          (s) => s.projectId === id,
        ) ?? null;
      const msgs = session
        ? await g.c.get<Page_<Message>>(`/v1/ai/sessions/${session.id}/messages`, {
            query: { limit: 100 },
          })
        : null;
      const items = runs.response.ok ? (runs.data?.items ?? []) : [];
      return {
        app: detail.type === 'webapp',
        mobile: detail.type === 'mobile',
        detail,
        session,
        messages: msgs?.response.ok ? (msgs.data?.items ?? []) : [],
        // a web app's latest run is its newest build (a `test-fix` run is not the build)
        run: detail.type === 'webapp' ? latestWebappRun(items) : (items[0] ?? null),
      };
    },
    (d) =>
      d.app ? (
        flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG) ? (
          <WebAppWorkspace
            locale={locale}
            initial={{
              id: d.detail.id,
              name: d.detail.name,
              dataRegion: d.detail.dataRegion,
              headVersionId: d.detail.headVersionId ?? null,
              headSeq: d.detail.headSeq ?? null,
              lastDeployment: d.detail.lastDeployment ?? null,
            }}
            session={d.session}
            messages={d.messages}
            initialRun={d.run}
            initialTab={appTab(sp.tab)}
            allowedTabs={appTabsFor(g.s.can)}
            mfaFactorId={g.s.me.mfaFactorId ?? null}
            can={{
              ai: g.s.can('ai:write'),
              describe: g.s.can('builder:write') && g.s.can('ai:write'),
              approve: g.s.can('ai:approve'),
              write: g.s.can('builder:write'),
              sandbox: g.s.can('sandbox:use'),
              test: g.s.can('builder:test'),
              run: g.s.can('ai:run'),
              export: g.s.can('builder:export'),
              deployWrite: g.s.can('deploy:write'),
              sites: g.s.can('hosting:site:read'),
            }}
          />
        ) : (
          <NotEnabledState locale={locale} />
        )
      ) : d.mobile ? (
        flagEnabled(g.s.me.featureFlags, MOBILE_FLAG) ? (
          <MobileWorkspace
            locale={locale}
            initial={{
              id: d.detail.id,
              name: d.detail.name,
              versionId: d.detail.versionId ?? null,
              versionSeq: d.detail.versionSeq ?? null,
              manifest: (d.detail as unknown as { manifest?: unknown }).manifest ?? null,
            }}
            session={d.session}
            messages={d.messages}
            initialRun={d.run}
            initialTab={workspaceTab(sp.tab)}
            startRelease={one(sp.new) === '1'}
            userId={g.s.me.id}
            can={{
              ai: g.s.can('ai:write'),
              describe: g.s.can('builder:write') && g.s.can('ai:write'),
              build: g.s.can('mobile:build'),
              signing: g.s.can('mobile:signing'),
              release: g.s.can('mobile:release'),
            }}
          />
        ) : (
          <MobileUnavailable locale={locale} />
        )
      ) : (
        <>
          <Workspace
            locale={locale}
            initial={d.detail}
            session={d.session}
            messages={d.messages}
            initialRun={d.run}
            canWrite={g.s.can('builder:write')}
            canAi={g.s.can('ai:write')}
            links={[
              { key: 'versions', perm: 'builder:read' },
              { key: 'seo', perm: 'builder:read' },
              { key: 'forms', perm: 'builder:read' },
              { key: 'cms', perm: 'builder:read' },
              { key: 'deployments', perm: 'deploy:read' },
            ]
              .filter((x) => g.s.can(x.perm))
              .map((x) => ({
                key: x.key,
                href: `/${locale}/builder/projects/${id}/${x.key}`,
                label: t(locale, `bld.tab.${x.key}` as 'bld.tab.versions'),
              }))}
          />
        </>
      ),
  );
  return (
    <>
      <h1 className="nz-sr">{t(locale, 'bld.title.workspace')}</h1>
      {body}
    </>
  );
}
