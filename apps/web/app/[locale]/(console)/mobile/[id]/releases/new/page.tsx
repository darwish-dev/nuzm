import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MobileTabs } from '../../../../../../../components/MobileParts';
import { ReleaseWizard } from '../../../../../../../components/MobileReleaseWizard';
import { unwrapCall } from '../../../../../../../lib/compute';
import {
  declaredPermissions,
  manifestView,
  type MobileBuild,
} from '../../../../../../../lib/mobile';
import { mobileGuard, mobileView } from '../../../../../../../lib/mobile-view';

/** UI-M10-17: release-preparation wizard. Saves a draft or a prepared record; owner approval has no endpoint yet and nothing here submits to a store. */
export default async function NewMobileRelease({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'mobile:release', 'mobile.title.releaseNew');
  if (!m.ok) return m.node;
  const { locale, id, g } = m;
  return mobileView(
    locale,
    async () => {
      const project = await unwrapCall(
        g.c.get<{ id: string; name: string; manifest?: unknown }>(`/v1/builder/projects/${id}`),
      );
      const builds = g.s.can('mobile:build')
        ? await unwrapCall(
            g.c.get<{ items: MobileBuild[] }>('/v1/mobile/builds', { query: { projectId: id } }),
          )
        : { items: [] as MobileBuild[] };
      return { project, builds };
    },
    ({ project, builds }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <MobileTabs locale={locale} projectId={id} current="releases" can={g.s.can} />
        <h2 className="nz-h2">{t(locale, 'mobile.title.releaseNew')}</h2>
        <ReleaseWizard
          locale={locale}
          projectId={id}
          builds={builds.items}
          declared={declaredPermissions(manifestView(project.manifest))}
        />
      </>
    ),
  );
}
