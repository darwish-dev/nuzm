import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { AppVersions } from '../../../../../../../components/AppBlueprint';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import { BuilderTabs as AppTabs } from '../../../../../../../components/BuilderParts';
import { VersionsPanel } from '../../../../../../../components/BuilderVersions';
import type { Page_, Project, Version } from '../../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../../lib/compute';

/** UI-M09-04: version history, compare, restore, named snapshots. */
export default async function Versions({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.tab.versions');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    async () => ({
      project: await unwrapCall(g.c.get<Project>(`/v1/builder/projects/${id}`)),
      versions: await unwrapCall(
        g.c.get<Page_<Version>>(`/v1/builder/projects/${id}/versions`, { query: { limit: 50 } }),
      ),
    }),
    ({ project, versions }) =>
      project.type === 'webapp' ? (
        <>
          <AppTabs locale={locale} id={id} current="versions" />
          <AppVersions locale={locale} projectId={id} versions={versions.items} />
        </>
      ) : (
        <>
          <BuilderTabs locale={locale} projectId={id} current="versions" can={g.s.can} />
          <VersionsPanel
            locale={locale}
            projectId={id}
            initial={versions}
            canWrite={g.s.can('builder:write')}
          />
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.versions')}</PageTitle>
      {body}
    </>
  );
}
