import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../../components/BuilderParts';
import { RunViewer } from '../../../../../../../../components/RunViewer';
import { isUuid } from '../../../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../../../lib/builder-gate';

/** UI-M10-06: agent run viewer (steps, redacted tool calls, live budget meter, pending approvals, cancel). Polls while the run is live. */
export default async function RunPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; runId: string }>;
}) {
  const g = await bgate(params, 'ai:read', 'm10.run.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id, runId } = await params;
  if (!isUuid(id) || !isUuid(runId)) notFound();
  return bview(
    locale,
    () => unwrap(s.api.GET('/v1/ai/runs/{id}', { params: { path: { id: runId } } })),
    (run) => (
      <>
        <PageTitle>{t(locale, 'm10.run.title')}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="overview" />
        <RunViewer
          locale={locale}
          projectId={id}
          initial={run}
          canApprove={s.can('ai:approve')}
          canRun={s.can('ai:run')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
