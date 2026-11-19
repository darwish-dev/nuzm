import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MobileTabs } from '../../../../../../components/MobileParts';
import { MobileReleases } from '../../../../../../components/MobileReleases';
import { unwrapCall } from '../../../../../../lib/compute';
import type { MobileRelease } from '../../../../../../lib/mobile';
import { mobileGuard, mobileView } from '../../../../../../lib/mobile-view';

/** UI-M10-16: release-preparation records of a mobile project. */
export default async function MobileReleasesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'mobile:release', 'mobile.title.releases');
  if (!m.ok) return m.node;
  const { locale, id, g } = m;
  return mobileView(
    locale,
    async () => {
      const project = await unwrapCall(
        g.c.get<{ id: string; name: string }>(`/v1/builder/projects/${id}`),
      );
      const list = await unwrapCall(
        g.c.get<{ items: MobileRelease[] }>('/v1/mobile/releases', { query: { projectId: id } }),
      );
      return { project, list };
    },
    ({ project, list }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <MobileTabs locale={locale} projectId={id} current="releases" can={g.s.can} />
        <h2 className="nz-h2">{t(locale, 'mobile.title.releases')}</h2>
        <MobileReleases
          locale={locale}
          projectId={id}
          items={list.items}
          canCreate={g.s.can('mobile:release')}
        />
      </>
    ),
  );
}
