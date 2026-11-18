import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, PageTitle } from '@nuzm/ui';
import { ProjectCards } from '../../../../../components/BuilderProjects';
import { one, unwrapCall } from '../../../../../lib/compute';
import type { Page_, Project } from '../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../lib/builder-view';

/** UI-M09-01: the organization's website projects. */
export default async function Projects({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.title.projects');
  if (!g.ok) return g.denied;
  const canCreate = g.s.can('builder:write');
  const body = await builderView(
    locale,
    () =>
      unwrapCall(
        g.c.get<Page_<Project>>('/v1/builder/projects', {
          query: { limit: 24, cursor: one(sp.cursor) || undefined },
        }),
      ),
    (page) => (
      <ProjectCards
        locale={locale}
        items={page.items}
        nextCursor={page.nextCursor}
        canCreate={canCreate}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.title.projects')}</PageTitle>
      {canCreate && (
        <p>
          <ButtonLink href={`/${locale}/builder/new`}>
            {t(locale, 'bld.projects.create')}
          </ButtonLink>
        </p>
      )}
      {body}
    </>
  );
}
