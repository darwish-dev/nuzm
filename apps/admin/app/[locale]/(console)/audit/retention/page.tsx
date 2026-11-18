import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { GovernanceTabs } from '../../../../../components/M12Tabs';
import { RetentionForm } from '../../../../../components/GovernancePanels';
import { gate } from '../../../../../lib/gate';
import { readDryRun, readLegalHolds, readRetentionPolicies, shortId } from '../../../../../lib/ops';
import { view } from '../../../../../lib/view';

/**
 * UI-M12-14: audit retention. Reads the retention classes, the minimum (a proposal until D-34), the active legal holds and the DRY RUN of what a
 * policy would archive minus anything held. Archival of the hash-chained audit log is not available (ADR-055 PROPOSED): nothing is archived or deleted.
 */
export default async function AuditRetention({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'admin:compliance:read', 'm12.ret.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const canManage = s.can('admin:compliance:manage');
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/audit-retention', {})),
    (r) => {
      const policies = readRetentionPolicies(r.policies);
      const holds = readLegalHolds(r.legalHolds);
      const dry = readDryRun(r.preview);
      const min = r.minimumRetainDays ?? null;
      const count = (n: number | null) =>
        n === null ? t(locale, 'm12.health.notMeasured') : <Ltr>{String(n)}</Ltr>;
      return (
        <>
          <Banner tone="warn">{t(locale, 'm12.ret.noArchival')}</Banner>
          <div className="nz-grid">
            <Card aria-labelledby="rt-min">
              <h2 className="nz-h2" id="rt-min">
                {t(locale, 'm12.ret.minimum')}
              </h2>
              <p>
                {min === null
                  ? t(locale, 'm12.health.notMeasured')
                  : t(locale, 'm12.ret.days', { days: min })}
              </p>
              <p className="nz-muted">{t(locale, 'm12.ret.minimumNote')}</p>
              <p>
                {t(locale, 'm12.ret.region')}:{' '}
                {r.archiveTargetRegion ? (
                  <Ltr>{r.archiveTargetRegion}</Ltr>
                ) : (
                  t(locale, 'm12.ret.regionNone')
                )}
              </p>
            </Card>
            <Card aria-labelledby="rt-dry">
              <h2 className="nz-h2" id="rt-dry">
                {t(locale, 'm12.ret.dryRun')}
              </h2>
              {dry === null ? (
                <p>{t(locale, 'm12.ret.dryRunNone')}</p>
              ) : (
                <ul>
                  <li>
                    {t(locale, 'm12.ret.dry.archive')}: {count(dry.archiveCandidates)}
                  </li>
                  <li>
                    {t(locale, 'm12.ret.dry.held')}: {count(dry.heldCandidates)}
                  </li>
                  <li>
                    {t(locale, 'm12.ret.dry.eligible')}: {count(dry.eligibleToArchive)}
                  </li>
                  <li>
                    {t(locale, 'm12.ret.dry.expiry')}: {count(dry.expiryCandidates)}
                  </li>
                  {dry.archiveCutoff && (
                    <li>
                      {t(locale, 'm12.ret.dry.cutoff')}: {formatDateTime(dry.archiveCutoff, locale)}
                    </li>
                  )}
                </ul>
              )}
              <p className="nz-muted">{t(locale, 'm12.ret.dryRunNote')}</p>
            </Card>
          </div>
          <h2 className="nz-h2">{t(locale, 'm12.ret.policies')}</h2>
          {policies.length === 0 ? (
            <EmptyState
              title={t(locale, 'm12.ret.noPolicies')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <Table
              caption={t(locale, 'm12.ret.policies')}
              rows={policies}
              rowKey={(p) => p.id}
              columns={[
                {
                  key: 'c',
                  header: t(locale, 'm12.ret.col.class'),
                  render: (p) => <Ltr>{p.dataClass}</Ltr>,
                },
                {
                  key: 'v',
                  header: t(locale, 'm12.pol.col.version'),
                  render: (p) => <Ltr>{String(p.version)}</Ltr>,
                },
                {
                  key: 'r',
                  header: t(locale, 'm12.ret.col.retain'),
                  render: (p) => <Ltr>{String(p.retainDays)}</Ltr>,
                },
                {
                  key: 'a',
                  header: t(locale, 'm12.ret.col.archive'),
                  render: (p) => <Ltr>{String(p.archiveAfterDays)}</Ltr>,
                },
                { key: 'b', header: t(locale, 'm12.ret.col.basis'), render: (p) => p.basis || '—' },
                {
                  key: 's',
                  header: t(locale, 'm12.ret.col.status'),
                  render: (p) => (
                    <Badge tone={p.status === 'approved' ? 'success' : 'warn'}>
                      {tDynamic(locale, `m12.ret.status.${p.status}`, p.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'd',
                  header: t(locale, 'm12.ret.col.doc'),
                  render: (p) => (p.documentRef ? <Ltr>{p.documentRef}</Ltr> : '—'),
                },
              ]}
            />
          )}
          <h2 className="nz-h2">{t(locale, 'm12.ret.holds')}</h2>
          {holds.length === 0 ? (
            <p>{t(locale, 'm12.ret.noHolds')}</p>
          ) : (
            <Table
              caption={t(locale, 'm12.ret.holds')}
              rows={holds}
              rowKey={(h) => h.id}
              columns={[
                {
                  key: 'i',
                  header: t(locale, 'm12.ret.col.hold'),
                  render: (h) => <Ltr>{shortId(h.id)}</Ltr>,
                },
                {
                  key: 'o',
                  header: t(locale, 'm12.ar.col.org'),
                  render: (h) => (h.orgId ? <Ltr>{h.orgId}</Ltr> : t(locale, 'm12.ret.allOrgs')),
                },
                {
                  key: 'd',
                  header: t(locale, 'm12.ret.col.dataset'),
                  render: (h) =>
                    h.dataset ? <Ltr>{h.dataset}</Ltr> : t(locale, 'm12.ret.allDatasets'),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (h) => tDynamic(locale, `m12.ret.hold.${h.status}`, h.status),
                },
              ]}
            />
          )}
          {canManage ? (
            <RetentionForm
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              minimumDays={min}
              policies={policies.map((p) => ({ dataClass: p.dataClass, version: p.version }))}
            />
          ) : (
            <p className="nz-muted">{t(locale, 'm12.readOnly')}</p>
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.ret.title')}</PageTitle>
      <GovernanceTabs locale={locale} current="retention" can={s.can} />
      <p className="nz-muted">{t(locale, 'm12.ret.help')}</p>
      {body}
    </>
  );
}
