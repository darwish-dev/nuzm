import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { unwrap } from '@nuzm/sdk';
import { AppDeployments, type AppDeployment } from '../../../../../../../components/AppDeployments';
import { BuilderTabs } from '../../../../../../../components/BuilderBits';
import {
  BuilderTabs as AppTabs,
  NotEnabledState,
} from '../../../../../../../components/BuilderParts';
import { APP_BUILDER_FLAG } from '../../../../../../../lib/appbuilder';
import { flagEnabled } from '../../../../../../../lib/services';
import { DeploymentsPanel } from '../../../../../../../components/BuilderDeployments';
import type {
  Deployment,
  HostingSiteRef,
  Page_,
  ProjectDetail,
} from '../../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../../lib/compute';

/** UI-M09-08: publish to a hosting site (two-step human approval), deployments, logs, smoke results, rollback. */
export default async function Deployments({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'deploy:read', 'bld.tab.deployments');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    async () => {
      const project = await unwrapCall(g.c.get<ProjectDetail>(`/v1/builder/projects/${id}`));
      const deployments = await unwrapCall(
        g.c.get<Page_<Deployment>>('/v1/deployments', { query: { projectId: id, limit: 20 } }),
      );
      // the hosting sites feed the target selector; hosting may be off or not readable for this member: the form then explains it
      let sites: HostingSiteRef[] = [];
      if (g.s.can('hosting:site:read')) {
        try {
          const r = await unwrap(
            g.s.api.GET('/v1/hosting/sites', { params: { query: { limit: 100 } } }),
          );
          sites = r.items.map((x) => ({
            id: x.id,
            name: x.name,
            status: x.status,
            primaryDomain: x.primaryDomain ?? null,
          }));
        } catch {
          sites = [];
        }
      }
      return { project, deployments, sites };
    },
    (d) =>
      d.project.type === 'webapp' ? (
        flagEnabled(g.s.me.featureFlags, APP_BUILDER_FLAG) ? (
          <>
            <AppTabs locale={locale} id={id} current="deployments" />
            <AppDeployments
              locale={locale}
              projectId={id}
              versionId={d.project.headVersionId}
              headSeq={d.project.headSeq}
              initial={d.deployments.items as unknown as AppDeployment[]}
              sites={d.sites}
              canWrite={g.s.can('deploy:write')}
            />
          </>
        ) : (
          <NotEnabledState locale={locale} />
        )
      ) : (
        <>
          <BuilderTabs locale={locale} projectId={id} current="deployments" can={g.s.can} />
          <DeploymentsPanel
            locale={locale}
            projectId={id}
            projectName={d.project.name}
            headSeq={d.project.versionSeq}
            initial={d.deployments.items}
            sites={d.sites}
            canWrite={g.s.can('deploy:write')}
          />
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.tab.deployments')}</PageTitle>
      {body}
    </>
  );
}
