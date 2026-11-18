import { notFound } from 'next/navigation';
import { ApiError, unwrap, type Schemas } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, Ltr, PageTitle } from '@nuzm/ui';
import {
  DatabaseTabs,
  Fact,
  OperationNote,
  StatusBadge,
} from '../../../../../components/DataParts';
import { databaseTone } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-03: one database. Only the vault REFERENCE of the connection secret is shown; the one-time reveal (PA-15) is not approved and is a disabled control. */
export default async function DatabaseOverview({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'data:db:read', 'm8.dbd.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  const body = await view(
    locale,
    async () => {
      try {
        return await unwrap(s.api.GET('/v1/databases/{id}', { params: { path: { id } } }));
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) notFound();
        throw e;
      }
    },
    (d: Schemas['Database']) => {
      const windowEnds = d.rotation?.windowEndsAt ?? null;
      return (
        <>
          <PageTitle>{d.name}</PageTitle>
          <DatabaseTabs locale={locale} id={d.id} current="overview" />
          {d.status === 'provisioning' && (
            <OperationNote locale={locale} operationId={d.operationId} banner />
          )}
          {d.status === 'deleting' && (
            <OperationNote locale={locale} operationId={d.operationId} banner />
          )}
          {d.status === 'unknown' && <Banner tone="warn">{t(locale, 'm8.dbd.reconciling')}</Banner>}
          {d.status === 'failed' && <Banner tone="danger">{t(locale, 'm8.dbd.failed')}</Banner>}
          {d.rotation && (d.rotation.state === 'pending' || d.rotation.state === 'window') && (
            <Banner tone="warn">
              {windowEnds
                ? t(locale, 'm8.dbd.rotationWindow', { time: formatDateTime(windowEnds, locale) })
                : t(locale, 'm8.dbd.rotationActive')}
            </Banner>
          )}
          <Card aria-label={t(locale, 'm8.dbd.title')}>
            <dl>
              <Fact label={t(locale, 'field.status')}>
                <StatusBadge
                  locale={locale}
                  prefix="m8.db.status"
                  value={d.status}
                  tone={databaseTone(d.status)}
                />
              </Fact>
              <Fact label={t(locale, 'm8.db.col.engine')}>
                {tDynamic(locale, `m8.engine.${d.engine}`, d.engine)} {d.version}
              </Fact>
              <Fact label={t(locale, 'm8.dbd.endpoint')}>
                {d.endpoint ? (
                  <Ltr>{`${d.endpoint.host}:${d.endpoint.port}`}</Ltr>
                ) : (
                  t(locale, 'm8.dbd.noEndpoint')
                )}
              </Fact>
              <Fact label={t(locale, 'm8.dbd.tls')}>
                <Badge tone="success">{t(locale, 'm8.dbd.tlsRequired')}</Badge>
              </Fact>
              <Fact label={t(locale, 'm8.dbn.network')}>
                {d.network.access === 'private' ? (
                  t(locale, 'm8.dbn.net.private')
                ) : (
                  <>
                    {t(locale, 'm8.dbn.net.allowlist')}:{' '}
                    <Ltr>{(d.network.allowCidrs ?? []).join(', ') || '—'}</Ltr>
                  </>
                )}
              </Fact>
              <Fact label={t(locale, 'field.region')}>{d.dataRegion}</Fact>
              <Fact label={t(locale, 'm8.dbd.backupPolicy')}>
                {d.backupPolicy.enabled
                  ? t(locale, 'm8.dbd.backupOn', {
                      hours: d.backupPolicy.intervalHours,
                      days: d.backupPolicy.retentionDays,
                    })
                  : t(locale, 'm8.dbd.backupOff')}
              </Fact>
              <Fact label={t(locale, 'field.created')}>{formatDateTime(d.createdAt, locale)}</Fact>
            </dl>
          </Card>
          <Card aria-label={t(locale, 'm8.dbd.credential')} style={{ marginBlockStart: 16 }}>
            <h2 className="nz-h2">{t(locale, 'm8.dbd.credential')}</h2>
            <p>
              {t(locale, 'm8.dbd.vaultRef')}: {d.vaultRef ? <Ltr>{d.vaultRef}</Ltr> : '—'}
            </p>
            <p className="nz-muted">{t(locale, 'm8.dbd.vaultHelp')}</p>
            <p>
              <Button variant="secondary" disabled aria-describedby="db-reveal-note">
                {t(locale, 'm8.dbd.reveal')}
              </Button>
            </p>
            <p id="db-reveal-note" className="nz-muted">
              {t(locale, 'm8.dbd.revealPending')}
            </p>
          </Card>
          <Card aria-label={t(locale, 'm8.dbd.bindings')} style={{ marginBlockStart: 16 }}>
            <h2 className="nz-h2">{t(locale, 'm8.dbd.bindings')}</h2>
            <p className="nz-muted">{t(locale, 'm8.dbd.bindingsNone')}</p>
          </Card>
        </>
      );
    },
  );
  return body;
}
