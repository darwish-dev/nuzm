import { notFound } from 'next/navigation';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { AppSpecPanel, NoBuildYet, NotAnApp } from '../../../../../../../components/AppBlueprint';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { isUuid } from '../../../../../../../lib/appbuilder';
import { loadBuilt } from '../../../../../../../lib/appworkspace-server';
import { agate, bview } from '../../../../../../../lib/builder-gate';
import type { Project } from '../../../../../../../lib/builder';
import { unwrapCall } from '../../../../../../../lib/compute';
import { redirectWebapp } from '../../../../../../../lib/app-redirect';

/** UI-M10-02: the application spec of a web-app project (entities, roles, pages, API settings, non-functional requirements), from the newest build run. */
export default async function SpecPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await redirectWebapp(params, 'spec');
  const g = await agate(params, 'builder:read', 'm10a.spec.title');
  if (!g.ok) return g.node;
  const { locale, c } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => ({
      project: await unwrapCall(c.get<Project>(`/v1/builder/projects/${id}`)),
      built: await loadBuilt(c, id),
    }),
    ({ project, built }) => {
      if (project.type !== 'webapp') return <NotAnApp locale={locale} projectId={id} />;
      return (
        <>
          <PageTitle>{project.name}</PageTitle>
          <BuilderTabs locale={locale} id={id} current="spec" />
          <h2 className="nz-h2">{t(locale, 'm10a.spec.title')}</h2>
          {built?.spec ? (
            <>
              <p className="nz-muted">
                {t(locale, 'm10a.spec.from', { run: built.run.id.slice(0, 8) })}
              </p>
              <AppSpecPanel locale={locale} spec={built.spec} />
            </>
          ) : (
            <NoBuildYet locale={locale} />
          )}
        </>
      );
    },
  );
}
