import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { Deployments } from '../../../../../../../components/BuilderDeployments';
import { isUuid } from '../../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';

/** UI-M10-09: deployments: list, detail, logs, health gate, create (approvals listed on 403) and rollback behind a confirmation. */
export default async function DeploymentsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await bgate(params, 'deploy:read', 'm10.dep.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => ({
      project: await unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
      list: await unwrap(s.api.GET('/v1/deployments', { params: { query: { projectId: id } } })),
    }),
    ({ project, list }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="deployments" />
        <Deployments
          locale={locale}
          projectId={id}
          initial={list.items}
          versions={(project.versions ?? []).filter(
            (v): v is typeof v & { id: string } => typeof v.id === 'string',
          )}
          headVersionId={project.headVersionId ?? null}
          canCreate={s.can('deploy:create')}
          canRoll={s.can('deploy:rollback')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
