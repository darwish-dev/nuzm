import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { ComputeTabs } from '../../../../../../../components/ComputeBits';
import { InstanceNav } from '../../../../../../../components/ComputeInstanceDetail';
import { MetricsPanel } from '../../../../../../../components/ComputeMetrics';
import {
  isMetricWindow,
  one,
  readSeries,
  supportsMetrics,
  unwrapCall,
  windowRange,
  type Instance,
} from '../../../../../../../lib/compute';
import { computeView } from '../../../../../../../lib/compute-view';
import { serverCompute } from '../../../../../../../lib/compute-server';
import { isUuid } from '../../../../../../../lib/privacy';
import { requireSession } from '../../../../../../../lib/server';

/** UI-M05-05: metrics when the provider exposes them; otherwise the "unsupported" empty state (never an error page). */
export default async function InstanceMetrics({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  const sp = await searchParams;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const s = await requireSession(locale);
  if (!s.org)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const title = <PageTitle>{t(locale, 'm05.web.metrics.title')}</PageTitle>;
  if (!s.can('compute:instance:read'))
    return (
      <>
        {title}
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const win = isMetricWindow(one(sp.window)) ? (one(sp.window) as '1h' | '24h' | '7d') : '1h';
  const c = await serverCompute(s.org.orgId);
  const body = await computeView(
    locale,
    async () => {
      const instance = await unwrapCall(c.get<Instance>(`/v1/compute/instances/${id}`));
      if (!supportsMetrics(instance.capabilities))
        return { instance, unsupported: true, series: [] };
      const r = await c.get<{ series: unknown }>(`/v1/compute/instances/${id}/metrics`, {
        query: windowRange(win, new Date()),
      });
      if (!r.response.ok && r.error?.code === 'unsupported_capability')
        return { instance, unsupported: true, series: [] };
      const data = await unwrapCall(Promise.resolve(r));
      return { instance, unsupported: false, series: readSeries(data.series) };
    },
    (d) => (
      <>
        <InstanceNav locale={locale} instance={d.instance} current="metrics" />
        <MetricsPanel locale={locale} unsupported={d.unsupported} series={d.series} window={win} />
      </>
    ),
  );
  return (
    <>
      {title}
      <ComputeTabs locale={locale} current="instances" can={s.can} />
      {body}
    </>
  );
}
