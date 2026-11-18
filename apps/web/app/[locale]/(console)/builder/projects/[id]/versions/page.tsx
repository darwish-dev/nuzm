import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import { VersionsPanel } from '../../../../../../../components/BuilderVersions';
import type { Page_, Version } from '../../../../../../../lib/builder';
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
    () =>
      unwrapCall(
        g.c.get<Page_<Version>>(`/v1/builder/projects/${id}/versions`, { query: { limit: 50 } }),
      ),
    (initial) => (
      <VersionsPanel
        locale={locale}
        projectId={id}
        initial={initial}
        canWrite={g.s.can('builder:write')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.versions')}</PageTitle>
      <BuilderTabs locale={locale} projectId={id} current="versions" can={g.s.can} />
      {body}
    </>
  );
}
