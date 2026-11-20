import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import { CmsPanel } from '../../../../../../../components/BuilderCms';
import type { CmsCollection } from '../../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../../lib/compute';
import { redirectToStudio } from '../../../../../../../lib/app-redirect';

/** UI-M09-07: CMS collections and items. */
export default async function Cms({ params }: { params: Promise<{ locale: string; id: string }> }) {
  await redirectToStudio(params, 'cms');
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.tab.cms');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    () =>
      unwrapCall(g.c.get<{ items: CmsCollection[] }>(`/v1/builder/projects/${id}/cms-collections`)),
    (d) => (
      <CmsPanel
        locale={locale}
        projectId={id}
        initial={d.items}
        canWrite={g.s.can('builder:write')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.cms')}</PageTitle>
      <BuilderTabs locale={locale} projectId={id} current="cms" can={g.s.can} />
      {body}
    </>
  );
}
