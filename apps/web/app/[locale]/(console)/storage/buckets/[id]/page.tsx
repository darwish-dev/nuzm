import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, Ltr, Meter, PageTitle } from '@nuzm/ui';
import { Fact, OperationNote, StatusBadge } from '../../../../../../components/DataParts';
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
          <PageTitle>{bucket.name}</PageTitle>
          {bucket.public && (
            <Banner tone="danger">
              <strong>{t(locale, 'm8.stb.publicBanner')}</strong>{' '}
              {t(locale, 'm8.stb.publicWarning')}
            </Banner>
          )}
          {(bucket.status === 'provisioning' || bucket.status === 'deleting') && (
            <OperationNote locale={locale} operationId={bucket.operationId} banner />
          )}
          <Card aria-label={t(locale, 'm8.stb.title')}>
            <dl>
              <Fact label={t(locale, 'field.status')}>
                <StatusBadge
                  locale={locale}
                  prefix="m8.st.status"
                  value={bucket.status}
                  tone={bucket.status === 'active' ? 'success' : 'warn'}
                />{' '}
                <Badge tone={bucket.public ? 'danger' : 'success'}>
                  {bucket.public ? t(locale, 'm8.st.public') : t(locale, 'm8.st.private')}
                </Badge>
              </Fact>
              <Fact label={t(locale, 'm8.st.col.bucketName')}>
                <Ltr>{bucket.bucketName}</Ltr>
              </Fact>
              <Fact label={t(locale, 'm8.stb.endpoint')}>
                {bucket.endpoint ? <Ltr>{bucket.endpoint}</Ltr> : '—'}
              </Fact>
              <Fact label={t(locale, 'field.region')}>{bucket.dataRegion}</Fact>
              <Fact label={t(locale, 'm8.stn.versioning')}>
                {bucket.versioning ? t(locale, 'm8.c.yes') : t(locale, 'm8.c.no')}
              </Fact>
              <Fact label={t(locale, 'field.created')}>
                {formatDateTime(bucket.createdAt, locale)}
              </Fact>
            </dl>
          </Card>

          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm8.stb.usage')}
          </h2>
          <Card aria-label={t(locale, 'm8.stb.usage')}>
            <dl>
              <Fact label={t(locale, 'm8.stb.usage.stored')}>
                {formatBytes(stored) ? <Ltr>{formatBytes(stored)!}</Ltr> : na}
                {bucket.quotaBytes ? (
                  <>
                    {' / '}
                    <Ltr>{formatBytes(bucket.quotaBytes)!}</Ltr>
                  </>
                ) : (
                  <> · {t(locale, 'm8.st.noQuota')}</>
                )}
              </Fact>
              <Fact label={t(locale, 'm8.stb.usage.requests')}>
                {requests === null ? na : <Ltr>{String(requests)}</Ltr>}
              </Fact>
              <Fact label={t(locale, 'm8.stb.usage.egress')}>
                {formatBytes(egress) ? <Ltr>{formatBytes(egress)!}</Ltr> : na}
              </Fact>
            </dl>
            {pct !== null && (
              <Meter label={t(locale, 'm8.st.usageMeter', { name: bucket.name })} percent={pct} />
            )}
            <p className="nz-muted">
              {u.at
                ? t(locale, 'm8.stb.usage.at', { time: formatDateTime(u.at, locale) })
                : t(locale, 'm8.stb.usage.none')}
            </p>
          </Card>

          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm8.stb.credentials')}
          </h2>
          <Card aria-label={t(locale, 'm8.stb.credentials')}>
            <p>
              {t(locale, 'm8.dbd.vaultRef')}:{' '}
              {bucket.credentialVaultRef ? <Ltr>{bucket.credentialVaultRef}</Ltr> : '—'}
            </p>
            <p className="nz-muted">{t(locale, 'm8.stb.credentialsHelp')}</p>
            <p>
              <Button variant="secondary" disabled aria-describedby="bk-reveal-note">
                {t(locale, 'm8.dbd.reveal')}
              </Button>
            </p>
            <p id="bk-reveal-note" className="nz-muted">
              {t(locale, 'm8.dbd.revealPending')}
            </p>
          </Card>

          <div style={{ marginBlockStart: 16 }}>
            <PolicyEditor
              key={`p-${policy.etag}`}
              locale={locale}
              bucketId={bucket.id}
              policy={policy.policy as PolicyDoc}
              etag={policy.etag}
              canAdmin={s.can('data:storage:admin')}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          </div>
          <div style={{ marginBlockStart: 16 }}>
            <LifecycleEditor
              locale={locale}
              bucketId={bucket.id}
              rules={lifecycle.rules}
              caps={lifecycle.capabilities}
              canWrite={s.can('data:storage:write')}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          </div>
          <div style={{ marginBlockStart: 16 }}>
            <SignedUrlTool
              locale={locale}
              bucketId={bucket.id}
              canWrite={s.can('data:storage:write')}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          </div>
          {s.can('data:storage:write') && (
            <div style={{ marginBlockStart: 16 }}>
              <DeleteBucket
                locale={locale}
                bucket={bucket}
                canAdmin={s.can('data:storage:admin')}
                mfaFactorId={s.me.mfaFactorId ?? null}
              />
            </div>
          )}
        </>
      );
    },
  );
}
