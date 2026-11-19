import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AppRunProgress } from '../../../../../../components/AppProgress';
import { AppSummary } from '../../../../../../components/AppBlueprint';
import { BuilderTabs as AppTabs, NotEnabledState } from '../../../../../../components/BuilderParts';
import { MobileWorkspace } from '../../../../../../components/MobileWorkspace';
import { Workspace } from '../../../../../../components/BuilderWorkspace';
import { APP_BUILDER_FLAG } from '../../../../../../lib/appbuilder';
import { latestWebappRun } from '../../../../../../lib/appworkspace';
import type { Message, Page_, ProjectDetail, Run, Session } from '../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../lib/builder-view';
import { isUuid, one, unwrapCall } from '../../../../../../lib/compute';
import { MOBILE_FLAG, workspaceTab } from '../../../../../../lib/mobile';
import { MobileUnavailable } from '../../../../../../lib/mobile-view';
import { flagEnabled } from '../../../../../../lib/services';

/**
 * UI-M09-03 (website workspace: chat and run timeline, sandboxed preview, outline and inspector, code and diff) and UI-M10-02/06 (web-app workspace: the agent
 * graph of the build run, budget, approvals). A project of type `webapp` gets the app tabs, a project of type `mobile` the mobile mode of the same workspace (chat with
 * the design request and live run, a phone preview, the Flutter files, the spec, builds, signing and releases; `?tab=` picks the panel); everything else keeps the website
 * workspace.
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
      if (detail.type === 'webapp')
        return {
          app: true as const,
          mobile: false as const,
          detail,
          session,
          run: latestWebappRun(runs.response.ok ? (runs.data?.items ?? []) : []),
        };
      const msgs = session
        ? await g.c.get<Page_<Message>>(`/v1/ai/sessions/${session.id}/messages`, {
            query: { limit: 100 },
          })
        : null;
      return {
        app: false as const,
        mobile: detail.type === 'mobile',
        detail,
        session,
        messages: msgs?.response.ok ? (msgs.data?.items ?? []) : [],
        run: runs.response.ok ? (runs.data?.items[0] ?? null) : null,
      };
    },
    (d) =>
      d.app ? (
        flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG) ? (
          <>
            <AppTabs locale={locale} id={id} current="overview" />
            <AppSummary locale={locale} project={d.detail} />
            <AppRunProgress
              locale={locale}
              projectId={id}
              initialRun={d.run}
              sessionId={d.session?.id ?? null}
              canRun={g.s.can('builder:write') && g.s.can('ai:write')}
              canApprove={g.s.can('ai:approve')}
            />
          </>
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
