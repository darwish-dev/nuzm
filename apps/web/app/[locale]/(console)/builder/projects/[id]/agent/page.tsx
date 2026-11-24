import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderLifecycleScreen } from '../../../../../../../components/BuilderLifecycleScreen';
import { isUuid } from '../../../../../../../lib/appbuilder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';

/**
 * PHASE-2 S05: the builder agent of a web-app project (start from a brief, watch the 18 steps, cancel, follow the deployment approval). Behind the organization flags
 * `builder_tools.enabled` and `builder_lifecycle.enabled` (default OFF): when off the form says so. `?run=<id>` reopens a run.
 */
export default async function BuilderAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const g = await bgate(params, 'builder:read', 'bt.lc.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  const { run } = await searchParams;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
    (project) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <h2 className="nz-h2">{t(locale, 'bt.lc.title')}</h2>
        <BuilderLifecycleScreen
          locale={locale}
          projectId={id}
          canRun={s.can('ai:write') && s.can('builder:write')}
          initialRunId={run && isUuid(run) ? run : null}
        />
      </>
    ),
  );
}
