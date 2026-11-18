import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { ComputeTabs } from '../../../../../../components/ComputeBits';
import { InstanceDetail, InstanceNav } from '../../../../../../components/ComputeInstanceDetail';
import {
  unwrapCall,
  visibleActions,
  type Instance,
  type Offer,
  type OperationView,
  type Paged,
} from '../../../../../../lib/compute';
import { computeView } from '../../../../../../lib/compute-view';
import { serverCompute } from '../../../../../../lib/compute-server';
import { isUuid } from '../../../../../../lib/privacy';
import { requireSession } from '../../../../../../lib/server';

/** UI-M05-04: instance overview, capability-based actions, operation timeline. */
export default async function InstancePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const s = await requireSession(locale);
  if (!s.org)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const title = <PageTitle>{t(locale, 'm05.web.detail.title')}</PageTitle>;
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
  const c = await serverCompute(s.org.orgId);
  const canAct = s.can('compute:instance:act');
  const body = await computeView(
    locale,
    async () => {
      const got = await c.get<Instance>(`/v1/compute/instances/${id}`);
      const etag = got.response.headers.get('etag');
      const instance = await unwrapCall(Promise.resolve(got));
      // the timeline and the resize choices are extras: their failure never hides the instance
      const op = instance.operationId
        ? await c.get<OperationView>(`/v1/operations/${instance.operationId}`)
        : null;
      const offers =
        canAct && visibleActions(instance.capabilities).includes('resize') && s.can('offers:read')
          ? await c.get<Paged<Offer>>('/v1/offers', { query: { kind: 'compute', limit: 50 } })
          : null;
      return {
        instance,
        etag,
        operation: op?.response.ok ? (op.data ?? null) : null,
        offers: offers?.response.ok ? (offers.data?.items ?? []) : [],
      };
    },
    (d) => (
      <>
        <InstanceNav locale={locale} instance={d.instance} current="overview" />
        <InstanceDetail
          locale={locale}
          instance={d.instance}
          operation={d.operation}
          etag={d.etag}
          offers={d.offers}
          canAct={canAct}
          canDelete={s.can('compute:instance:delete')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
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
