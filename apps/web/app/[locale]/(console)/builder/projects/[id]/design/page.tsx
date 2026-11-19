import { notFound } from 'next/navigation';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import {
  AccessPanel,
  ApiPanel,
  DataModelPanel,
  NoBuildYet,
  NotAnApp,
} from '../../../../../../../components/AppBlueprint';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { isUuid } from '../../../../../../../lib/appbuilder';
import { loadBuilt } from '../../../../../../../lib/appworkspace-server';
import { agate, bview } from '../../../../../../../lib/builder-gate';
import type { Project } from '../../../../../../../lib/builder';
import { unwrapCall } from '../../../../../../../lib/compute';

/** UI-M10-02: what the database, backend and security agents generated: schema and migrations, REST API, and the role × entity access matrix. */
export default async function DesignPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await agate(params, 'builder:read', 'm10a.design.title');
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
      const roles = built?.api?.rbac.length ? built.api.rbac : (built?.spec?.roles ?? []);
      return (
        <>
          <PageTitle>{project.name}</PageTitle>
          <BuilderTabs locale={locale} id={id} current="design" />
          <h2 className="nz-h2">{t(locale, 'm10a.design.title')}</h2>
          {!built ? (
            <NoBuildYet locale={locale} />
          ) : (
            <>
              <nav aria-label={t(locale, 'm10a.design.jump')} className="nz-row">
                <a href="#m10a-data">{t(locale, 'm10a.data.title')}</a>
                <a href="#m10a-api">{t(locale, 'm10a.api.title')}</a>
                <a href="#m10a-access">{t(locale, 'm10a.access.title')}</a>
              </nav>
              <section aria-labelledby="m10a-data">
                <h2 className="nz-h2" id="m10a-data">
                  {t(locale, 'm10a.data.title')}
                </h2>
                {built.schema ? (
                  <DataModelPanel locale={locale} schema={built.schema} spec={built.spec} />
                ) : (
                  <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>
                )}
              </section>
              <section aria-labelledby="m10a-api">
                <h2 className="nz-h2" id="m10a-api">
                  {t(locale, 'm10a.api.title')}
                </h2>
                {built.api ? (
                  <ApiPanel locale={locale} api={built.api} />
                ) : (
                  <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>
                )}
              </section>
              <section aria-labelledby="m10a-access">
                <h2 className="nz-h2" id="m10a-access">
                  {t(locale, 'm10a.access.title')}
                </h2>
                {roles.length > 0 ? (
                  <AccessPanel
                    locale={locale}
                    roles={roles}
                    entities={built.spec?.entities.map((e) => e.name) ?? []}
                  />
                ) : (
                  <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>
                )}
              </section>
            </>
          )}
        </>
      );
    },
  );
}
