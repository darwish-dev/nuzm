import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MobileBuilds } from '../../../../../../components/MobileBuilds';
import { MobileTabs } from '../../../../../../components/MobileParts';
import { unwrapCall } from '../../../../../../lib/compute';
import { manifestView, type MobileBuild } from '../../../../../../lib/mobile';
import { mobileGuard, mobileView } from '../../../../../../lib/mobile-view';

/** UI-M10-14: builds, artifacts, logs and minutes of a mobile project; iOS and signed release builds say what they are waiting for. */
export default async function MobileBuildsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'mobile:build', 'mobile.title.builds');
  if (!m.ok) return m.node;
  const { locale, id, g } = m;
  return mobileView(
    locale,
    async () => {
      const project = await unwrapCall(
        g.c.get<{ id: string; name: string; type: string; manifest?: unknown }>(
          `/v1/builder/projects/${id}`,
        ),
      );
      const list = await unwrapCall(
        g.c.get<{ items: MobileBuild[] }>('/v1/mobile/builds', { query: { projectId: id } }),
      );
      return { project, list };
    },
    ({ project, list }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <MobileTabs locale={locale} projectId={id} current="builds" can={g.s.can} />
        <h2 className="nz-h2">{t(locale, 'mobile.title.builds')}</h2>
        <MobileBuilds
          locale={locale}
          projectId={id}
          initial={list.items}
          hasProject={manifestView(project.manifest).fileCount > 0}
          canBuild={g.s.can('mobile:build')}
        />
      </>
    ),
  );
}
