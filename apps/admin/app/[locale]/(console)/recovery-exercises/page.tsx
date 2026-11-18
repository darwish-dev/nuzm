import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../components/M12Tabs';
import { RecoveryExerciseForm } from '../../../../components/OpsPanels';
import { gate } from '../../../../lib/gate';
import { formatDuration, shortId } from '../../../../lib/ops';
import { view } from '../../../../lib/view';

/**
 * UI-M12-09: DR exercise records. Measured, never estimated: the RTO is the difference of the two recorded timestamps and the result follows
 * from the targets the API stored with the record (D-30 proposals, accepted 2026-11-15). Append-only.
 */
export default async function RecoveryExercises({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const g = await gate(params, 'admin:ops:read', 'm12.dr.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const canManage = s.can('admin:ops:manage');
  const dur = (sec: number | undefined, target: number | undefined) =>
    sec === undefined ? (
      '—'
    ) : (
      <>
        <Ltr>{formatDuration(sec)}</Ltr>
        {target !== undefined && (
          <div className="nz-muted">
            {t(locale, 'm12.dr.target')} <Ltr>{formatDuration(target)}</Ltr>
          </div>
        )}
      </>
    );
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/recovery-exercises', {
          params: { query: { limit: 50, cursor: q.cursor || undefined } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm12.dr.none')} body={t(locale, 'm12.dr.noneBody')} />
        ) : (
          <Table
            caption={t(locale, 'm12.dr.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'sc',
                header: t(locale, 'm12.dr.col.scope'),
                render: (r) => tDynamic(locale, `m12.dr.scope.${r.scope}`, r.scope),
              },
              {
                key: 'env',
                header: t(locale, 'm12.dr.col.env'),
                render: (r) =>
                  r.environment
                    ? tDynamic(locale, `m12.dr.env.${r.environment}`, r.environment)
                    : '—',
              },
              {
                key: 'st',
                header: t(locale, 'm12.dr.col.started'),
                render: (r) => (r.startedAt ? formatDateTime(r.startedAt, locale) : '—'),
              },
              {
                key: 're',
                header: t(locale, 'm12.dr.col.restored'),
                render: (r) => (r.restoredAt ? formatDateTime(r.restoredAt, locale) : '—'),
              },
              {
                key: 'rto',
                header: t(locale, 'm12.dr.col.rto'),
                render: (r) => dur(r.rtoSeconds, r.targetRtoSeconds),
              },
              {
                key: 'rpo',
                header: t(locale, 'm12.dr.col.rpo'),
                render: (r) => dur(r.rpoSeconds, r.targetRpoSeconds),
              },
              {
                key: 'res',
                header: t(locale, 'm12.dr.col.result'),
                render: (r) => (
                  <Badge tone={r.result === 'pass' ? 'success' : 'danger'}>
                    {t(locale, r.result === 'pass' ? 'm12.dr.result.pass' : 'm12.dr.result.fail')}
                  </Badge>
                ),
              },
              {
                key: 'ev',
                header: t(locale, 'm12.dr.col.evidence'),
                render: (r) =>
                  r.evidenceRefs && r.evidenceRefs.length > 0 ? (
                    <Ltr>{r.evidenceRefs.join(', ')}</Ltr>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'no',
                header: t(locale, 'm12.dr.col.notes'),
                render: (r) => r.notes ?? '—',
              },
              {
                key: 'by',
                header: t(locale, 'm12.dr.col.by'),
                render: (r) => (r.recordedBy ? <Ltr>{shortId(r.recordedBy)}</Ltr> : '—'),
              },
            ]}
          />
        )}
        {data.nextCursor && (
          <p>
            <a href={`/${locale}/recovery-exercises?cursor=${encodeURIComponent(data.nextCursor)}`}>
              {t(locale, 'action.loadMore')}
            </a>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.dr.title')}</PageTitle>
      <OpsTabs locale={locale} current="exercises" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.dr.help')}</Banner>
      {body}
      {canManage ? (
        <RecoveryExerciseForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      ) : (
        <p className="nz-muted">{t(locale, 'm12.readOnly')}</p>
      )}
    </>
  );
}
