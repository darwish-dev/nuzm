import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, Banner, Button, Icon, Ltr, OnOff, PageTitle } from '@nuzm/ui';
import { OperationNote, StatusBadge } from '../../../../../../components/DataParts';
import {
  OverviewLayout,
  Ring,
  SidePanel,
  SummaryCard,
} from '../../../../../../components/Overview';
import {
  DeleteBucket,
  LifecycleEditor,
  PolicyEditor,
  SignedUrlTool,
} from '../../../../../../components/StoragePanels';
import { bucketUsage, formatBytes, usagePercent, type PolicyDoc } from '../../../../../../lib/data';
import { gate } from '../../../../../../lib/gate';
import { view } from '../../../../../../lib/view';

/** UI-M08-07: one bucket: policy, lifecycle, signed URLs, credential guidance (reveal blocked, PA-15), usage and deletion. */
export default async function BucketDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'data:storage:read', 'm8.stb.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  return view(
    locale,
    async () => {
      try {
        const bucket = await unwrap(
          s.api.GET('/v1/storage/buckets/{id}', { params: { path: { id } } }),
        );
        const policy = await unwrap(
          s.api.GET('/v1/storage/buckets/{id}/access-policy', { params: { path: { id } } }),
        );
        const lifecycle = await unwrap(
          s.api.GET('/v1/storage/buckets/{id}/lifecycle', { params: { path: { id } } }),
        );
        return { bucket, policy, lifecycle };
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    ({ bucket, policy, lifecycle }) => {
      const u = bucketUsage(bucket.usage);
      const stored = u.bytes;
      const requests = u.requests;
      const egress = u.egress;
      const pct = usagePercent(stored, bucket.quotaBytes);
      const na = t(locale, 'm8.c.unavailable');
      return (
        <>
          <a className="nzc-back" href={`/storage/buckets`}>
            <Icon name="chevron" size={16} />
            {t(locale, 'm8.st.title')}
          </a>
          <PageTitle>{t(locale, 'm8.stb.title')}</PageTitle>
          {bucket.public && (
            <Banner tone="danger">
              <strong>{t(locale, 'm8.stb.publicBanner')}</strong>{' '}
              {t(locale, 'm8.stb.publicWarning')}
            </Banner>
          )}
          {(bucket.status === 'provisioning' || bucket.status === 'deleting') && (
            <OperationNote locale={locale} operationId={bucket.operationId} banner />
          )}
          <OverviewLayout
            sideLabel={t(locale, 'm8.stb.title')}
            main={
              <>
                <PolicyEditor
                  key={`p-${policy.etag}`}
                  locale={locale}
                  bucketId={bucket.id}
                  policy={policy.policy as PolicyDoc}
                  etag={policy.etag}
                  canAdmin={s.can('data:storage:admin')}
                  mfaFactorId={s.me.mfaFactorId ?? null}
                />
                <LifecycleEditor
                  locale={locale}
                  bucketId={bucket.id}
                  rules={lifecycle.rules}
                  caps={lifecycle.capabilities}
                  canWrite={s.can('data:storage:write')}
                  mfaFactorId={s.me.mfaFactorId ?? null}
                />
                <SignedUrlTool
                  locale={locale}
                  bucketId={bucket.id}
                  canWrite={s.can('data:storage:write')}
                  mfaFactorId={s.me.mfaFactorId ?? null}
                />
                {s.can('data:storage:write') && (
                  <DeleteBucket
                    locale={locale}
                    bucket={bucket}
                    canAdmin={s.can('data:storage:admin')}
                    mfaFactorId={s.me.mfaFactorId ?? null}
                  />
                )}
              </>
            }
            side={
              <>
                <SummaryCard
                  name={<Ltr>{bucket.name}</Ltr>}
                  badges={
                    <>
                      <StatusBadge
                        locale={locale}
                        prefix="m8.st.status"
                        value={bucket.status}
                        tone={bucket.status === 'active' ? 'success' : 'warn'}
                      />
                      <Badge tone={bucket.public ? 'danger' : 'success'}>
                        {bucket.public ? t(locale, 'm8.st.public') : t(locale, 'm8.st.private')}
                      </Badge>
                    </>
                  }
                  gauge={
                    <>
                      <Ring
                        percent={pct ?? 0}
                        value={pct === null ? '—' : `${Math.round(pct)}%`}
                        caption={t(locale, 'm8.stb.usage.stored')}
                        label={t(locale, 'm8.st.usageMeter', { name: bucket.name })}
                        tone={
                          pct !== null && pct >= 90
                            ? 'danger'
                            : pct !== null && pct >= 75
                              ? 'warn'
                              : 'accent'
                        }
                      />
                      <dl style={{ margin: 0 }} aria-label={t(locale, 'm8.stb.usage')}>
                        <dt>{t(locale, 'm8.stb.usage.stored')}</dt>
                        <dd style={{ fontSize: 15 }}>
                          {formatBytes(stored) ? <Ltr>{formatBytes(stored)!}</Ltr> : na}
                          {bucket.quotaBytes ? (
                            <>
                              {' / '}
                              <Ltr>{formatBytes(bucket.quotaBytes)!}</Ltr>
                            </>
                          ) : null}
                        </dd>
                        <dt>{t(locale, 'm8.stb.usage.egress')}</dt>
                        <dd style={{ fontSize: 15 }}>
                          {formatBytes(egress) ? <Ltr>{formatBytes(egress)!}</Ltr> : na}
                        </dd>
                      </dl>
                    </>
                  }
                  rows={[
                    {
                      icon: 'tag',
                      label: t(locale, 'm8.st.col.bucketName'),
                      value: <Ltr>{bucket.bucketName}</Ltr>,
                    },
                    {
                      icon: 'globe',
                      label: t(locale, 'm8.stb.endpoint'),
                      value: bucket.endpoint ? <Ltr>{bucket.endpoint}</Ltr> : '—',
                    },
                    {
                      icon: 'pulse',
                      label: t(locale, 'm8.stb.usage.requests'),
                      value: requests === null ? na : <Ltr>{String(requests)}</Ltr>,
                    },
                    {
                      icon: 'refresh',
                      label: t(locale, 'm8.stn.versioning'),
                      value: (
                        <OnOff on={!!bucket.versioning}>
                          {bucket.versioning ? t(locale, 'm8.c.yes') : t(locale, 'm8.c.no')}
                        </OnOff>
                      ),
                    },
                    {
                      icon: 'pin',
                      label: t(locale, 'field.region'),
                      value: <Ltr>{bucket.dataRegion}</Ltr>,
                    },
                    {
                      icon: 'calendar',
                      label: t(locale, 'field.created'),
                      value: formatDateTime(bucket.createdAt, locale),
                    },
                  ]}
                >
                  <p className="nz-muted" style={{ margin: '14px 0 0', fontSize: 12.5 }}>
                    {u.at
                      ? t(locale, 'm8.stb.usage.at', { time: formatDateTime(u.at, locale) })
                      : t(locale, 'm8.stb.usage.none')}
                  </p>
                </SummaryCard>
                <SidePanel title={t(locale, 'm8.stb.credentials')}>
                  <p className="nz-muted" style={{ marginBlockStart: 0, overflowWrap: 'anywhere' }}>
                    {t(locale, 'm8.dbd.vaultRef')}:{' '}
                    {bucket.credentialVaultRef ? <Ltr>{bucket.credentialVaultRef}</Ltr> : '—'}
                  </p>
                  <p className="nz-muted">{t(locale, 'm8.stb.credentialsHelp')}</p>
                  <Button variant="secondary" disabled aria-describedby="bk-reveal-note">
                    {t(locale, 'm8.dbd.reveal')}
                  </Button>
                  <p id="bk-reveal-note" className="nz-muted" style={{ marginBlockEnd: 0 }}>
                    {t(locale, 'm8.dbd.revealPending')}
                  </p>
                </SidePanel>
              </>
            }
          />
        </>
      );
    },
  );
}
