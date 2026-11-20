import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import { SeoPanel } from '../../../../../../../components/BuilderSeo';
import type { ProjectDetail } from '../../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../../lib/compute';
import { redirectToStudio } from '../../../../../../../lib/app-redirect';

/** UI-M09-05: SEO score report and the editing of site and page SEO. */
export default async function Seo({ params }: { params: Promise<{ locale: string; id: string }> }) {
  await redirectToStudio(params, 'seo');
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.tab.seo');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    () => unwrapCall(g.c.get<ProjectDetail>(`/v1/builder/projects/${id}`)),
    (detail) => <SeoPanel locale={locale} initial={detail} canWrite={g.s.can('builder:write')} />,
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.seo')}</PageTitle>
      <BuilderTabs locale={locale} projectId={id} current="seo" can={g.s.can} />
      {body}
    </>
  );
}
