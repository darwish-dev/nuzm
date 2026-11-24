import { notFound } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { BenchmarksDashboard } from '../../../../../components/benchmarks-dashboard';
import { parseOverview } from '../../../../../lib/benchmarks';
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
      if (r.status === 404) return parseOverview(null);
      if (!r.ok) throw new Error(`benchmarks overview: ${r.status}`);
      return parseOverview(await r.json());
    },
    (overview) => (
      <BenchmarksDashboard
        locale={locale}
        overview={overview}
        canRecord={s.can('admin:ai:manage')}
      />
    ),
  );
  return (
    <>
      <PageTitle>{bt(locale, 'title')}</PageTitle>
      {body}
    </>
  );
}
