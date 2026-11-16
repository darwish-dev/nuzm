import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ProjectsPanel } from '../../../../components/ProjectPanels';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function Projects({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => ({
      projects: (await unwrap(s.api.GET('/v1/projects', { params: { query: { limit: 100 } } })))
        .items,
      workspaces: (await unwrap(s.api.GET('/v1/workspaces', { params: { query: { limit: 100 } } })))
        .items,
    }),
    (d) => (
      <ProjectsPanel
        locale={locale}
        items={d.projects}
        workspaces={d.workspaces}
        canWrite={s.can('project:create')}
        canDelete={s.can('project:delete')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'projects.title')}</PageTitle>
      {body}
    </>
  );
}
