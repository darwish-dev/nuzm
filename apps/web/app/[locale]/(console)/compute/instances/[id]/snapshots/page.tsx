import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { InstanceNav } from '../../../../../../../components/ComputeInstanceDetail';
import { SnapshotsPanel } from '../../../../../../../components/ComputeSnapshots';
import { supportsSnapshot, unwrapCall, type Instance } from '../../../../../../../lib/compute';
import { computeView } from '../../../../../../../lib/compute-view';
import { serverCompute } from '../../../../../../../lib/compute-server';
import { isUuid } from '../../../../../../../lib/compute';
import { requireSession } from '../../../../../../../lib/server';

/** UI-M05-06: snapshots, only when the instance supports them (otherwise an empty state). */
export default async function InstanceSnapshots({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const s = await requireSession(locale);
  if (!s.org)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const title = <PageTitle>{t(locale, 'm05.web.snap.title')}</PageTitle>;
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
  const body = await computeView(
    locale,
    () => unwrapCall(c.get<Instance>(`/v1/compute/instances/${id}`)),
    (instance) => (
      <>
        <InstanceNav locale={locale} instance={instance} current="snapshots" />
        <SnapshotsPanel
          locale={locale}
          instanceId={instance.id}
          status={instance.status}
          supported={supportsSnapshot(instance.capabilities)}
          canAct={s.can('compute:instance:act')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      </>
    ),
  );
  return (
    <>
      {title}
      {body}
    </>
  );
}
