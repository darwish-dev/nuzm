import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../components/BuilderBits';
import { Workspace } from '../../../../../../components/BuilderWorkspace';
import type { Message, Page_, ProjectDetail, Run, Session } from '../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../lib/compute';

/** UI-M09-03: the builder workspace (chat and run timeline, sandboxed preview, outline and inspector, code and diff). */
export default async function ProjectWorkspace({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.title.workspace');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    async () => {
      const detail = await unwrapCall(g.c.get<ProjectDetail>(`/v1/builder/projects/${id}`));
      // the conversation and the latest run are context: if they cannot be read (no `ai:read`), the workspace still opens
      const runs = await g.c.get<Page_<Run>>('/v1/ai/runs', { query: { projectId: id, limit: 1 } });
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
      return {
        detail,
        session,
        messages: msgs?.response.ok ? (msgs.data?.items ?? []) : [],
        run: runs.response.ok ? (runs.data?.items[0] ?? null) : null,
      };
    },
    (d) => (
      <Workspace
        locale={locale}
        initial={d.detail}
        session={d.session}
        messages={d.messages}
        initialRun={d.run}
        canWrite={g.s.can('builder:write')}
        canAi={g.s.can('ai:write')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.title.workspace')}</PageTitle>
      <BuilderTabs locale={locale} projectId={id} current="workspace" can={g.s.can} />
      {body}
    </>
  );
}
