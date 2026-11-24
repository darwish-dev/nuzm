import { notFound } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { AiAdminTabs } from '../../../../../components/AiAdminTabs';
import { BenchmarksDashboard } from '../../../../../components/benchmarks-dashboard';
import { parseOverview, parseScorecard, type ScorecardRow } from '../../../../../lib/benchmarks';
import { bt } from '../../../../../lib/benchmarks-text';
import { apiDownload, requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * Model benchmark dashboard (S-AG5). Data from `GET /v1/admin/ai/benchmarks` (CONTRACT-S03-1; the typed SDK has no such path until the Master applies it, so the page reads it with the
 * admin-realm session through `apiDownload`). A 404 or a disabled flag shows the "switched off" state; offline evidence is always labelled as not a model.
 */
export default async function AiBenchmarks({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai:read'))
    return (
      <>
        <PageTitle>{bt(locale, 'title')}</PageTitle>
        <ForbiddenState title={bt(locale, 'forbidden')} body={bt(locale, 'forbidden')} />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const r = await apiDownload('/v1/admin/ai/benchmarks');
      if (r.status === 404)
        return { overview: parseOverview(null), scorecard: [] as ScorecardRow[] };
      if (!r.ok) throw new Error(`benchmarks overview: ${r.status}`);
      const overview = parseOverview(await r.json());
      // the scorecard belongs to the latest stored run; its absence (or a failed read) leaves the rest of the page intact
      let scorecard: ScorecardRow[] = [];
      const latest = overview.runs[0];
      if (latest) {
        const d = await apiDownload(
          `/v1/admin/ai/benchmarks/runs/${encodeURIComponent(latest.id)}`,
        );
        if (d.ok) scorecard = parseScorecard(await d.json());
      }
      return { overview, scorecard };
    },
    ({ overview, scorecard }) => (
      <BenchmarksDashboard
        locale={locale}
        overview={overview}
        scorecard={scorecard}
        canRecord={s.can('admin:ai:manage')}
        canApprove={s.can('admin:ai:approve')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{bt(locale, 'title')}</PageTitle>
      <AiAdminTabs locale={locale} current="benchmarks" />
      {body}
    </>
  );
}
