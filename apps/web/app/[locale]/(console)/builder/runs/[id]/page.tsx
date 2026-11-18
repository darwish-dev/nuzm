import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { RunDetail } from '../../../../../../components/BuilderRunDetail';
import type { Run } from '../../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../../lib/builder-view';
import { isUuid, unwrapCall } from '../../../../../../lib/compute';

/** UI-M09-09: run detail (events, approvals, cost, artifacts). */
export default async function RunPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const g = await builderGuard(locale, 'ai:read', 'bld.title.run');
  if (!g.ok) return g.denied;
  const body = await builderView(
    locale,
    () => unwrapCall(g.c.get<Run>(`/v1/ai/runs/${id}`)),
    (run) => <RunDetail locale={locale} run={run} canWrite={g.s.can('ai:write')} />,
  );
  return (
    <>
      <PageTitle>{t(locale, 'bld.title.run')}</PageTitle>
      {body}
    </>
  );
}
