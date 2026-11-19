import { notFound } from 'next/navigation';
import { PageTitle } from '@nuzm/ui';
import { MobileOverview } from '../../../../../../components/MobilePreview';
import { MobileTabs } from '../../../../../../components/MobileParts';
import { isUuid, unwrapCall } from '../../../../../../lib/compute';
import type { Page_, Run } from '../../../../../../lib/builder';
import { mobileGuard, mobileView } from '../../../../../../lib/mobile-view';

/** UI-M10-13: the generated design of a mobile project. States plainly that a web preview is not available yet and that a preview is not a guarantee of device behaviour. */
export default async function MobilePreviewPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'builder:read', 'mobile.title.overview');
  if (!m.ok) return m.node;
  const { locale, id, g } = m;
  if (!isUuid(id)) notFound();
  const body = await mobileView(
    locale,
    async () => {
      const project = await unwrapCall(
        g.c.get<{ id: string; name: string; type: string; manifest?: unknown }>(
          `/v1/builder/projects/${id}`,
        ),
      );
      if (project.type !== 'mobile') notFound();
      // the latest design request is context: a member who cannot read runs still sees the project
      const runs = g.s.can('ai:read')
        ? await g.c.get<Page_<Run>>('/v1/ai/runs', { query: { projectId: id, limit: 1 } })
        : null;
      return { project, run: runs?.response.ok ? (runs.data?.items[0] ?? null) : null };
    },
    ({ project, run }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <MobileTabs locale={locale} projectId={id} current="preview" can={g.s.can} />
        <MobileOverview
          locale={locale}
          manifest={project.manifest}
          run={
            run
              ? {
                  id: run.id,
                  state: run.state,
                  createdAt: typeof run.createdAt === 'string' ? run.createdAt : undefined,
                }
              : null
          }
        />
      </>
    ),
  );
  return body;
}
