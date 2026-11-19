import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { BuilderTabs } from '../../../../../../../components/BuilderParts';
import { TestRuns } from '../../../../../../../components/BuilderTests';
import { isUuid } from '../../../../../../../lib/appbuilder';
import { bgate, bview } from '../../../../../../../lib/builder-gate';
import { redirectWebapp } from '../../../../../../../lib/app-redirect';

/** UI-M10-08: test runs, structured results, re-run and "Ask AI to fix" (a `test-fix` run). */
export default async function Tests({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await redirectWebapp(params, 'tests');
  const g = await bgate(params, 'builder:read', 'm10.tst.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => ({
      project: await unwrap(s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } })),
      runs: await unwrap(
        s.api.GET('/v1/builder/projects/{projectId}/test-runs', {
          params: { path: { projectId: id } },
        }),
      ),
    }),
    ({ project, runs }) => (
      <>
        <PageTitle>{project.name}</PageTitle>
        <BuilderTabs locale={locale} id={id} current="tests" />
        <h2 className="nz-h2">{t(locale, 'm10.tst.title')}</h2>
        <TestRuns
          locale={locale}
          projectId={id}
          initial={runs.items}
          canTest={s.can('builder:test')}
          canRun={s.can('ai:run')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
}
