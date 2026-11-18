import { notFound } from 'next/navigation';
import { ApiError, unwrap, type Schemas } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Button, Icon, Ltr, PageTitle } from '@nuzm/ui';
import { OperationNote, StatusBadge } from '../../../../../components/DataParts';
import {
  ActionLink,
  ActionPanel,
  ActionRow,
  OverviewLayout,
  SidePanel,
  SpecTiles,
  SummaryCard,
} from '../../../../../components/Overview';
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
          <a className="nzc-back" href={`/${locale}/databases`}>
            <Icon name="chevron" size={16} />
            {t(locale, 'm8.db.title')}
          </a>
          <PageTitle>{t(locale, 'm8.dbd.title')}</PageTitle>
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
          <OverviewLayout
            sideLabel={t(locale, 'm8.dbd.ov.summary')}
            main={
              <>
                <ActionPanel
                  id="db-manage"
                  title={t(locale, 'm8.dbd.ov.title', { name: d.name })}
                  sub={t(locale, 'm8.dbd.ov.sub')}
                >
                  <ActionRow
                    icon="cloud"
                    featured
                    title={t(locale, 'm8.dbd.tab.backups')}
                    desc={t(locale, 'm8.dbd.ov.backups')}
                    action={
                      <ActionLink
                        href={`/${locale}/databases/${d.id}/backups`}
                        label={t(locale, 'm8.dbd.ov.open')}
                        primary
                      />
                    }
                  />
                  <ActionRow
                    icon="panel"
                    title={t(locale, 'm8.dbd.tab.settings')}
                    desc={t(locale, 'm8.dbd.ov.settings')}
                    action={
                      <ActionLink
                        href={`/${locale}/databases/${d.id}/settings`}
                        label={t(locale, 'm8.dbd.ov.open')}
                      />
                    }
                  />
                  <ActionRow
                    icon="key"
                    title={t(locale, 'm8.dbd.credential')}
                    desc={
                      <>
                        {t(locale, 'm8.dbd.vaultHelp')}{' '}
                        <span id="db-reveal-note">{t(locale, 'm8.dbd.revealPending')}</span>
                      </>
                    }
                    action={
                      <Button variant="secondary" disabled aria-describedby="db-reveal-note">
                        {t(locale, 'm8.dbd.reveal')}
                      </Button>
                    }
                  />
                  <ActionRow
                    icon="hosting"
                    title={t(locale, 'm8.dbd.bindings')}
                    desc={t(locale, 'm8.dbd.bindingsNone')}
                  />
                </ActionPanel>
              </>
            }
            side={
              <>
                <SummaryCard
                  name={<Ltr>{d.name}</Ltr>}
                  badges={
                    <StatusBadge
                      locale={locale}
                      prefix="m8.db.status"
                      value={d.status}
                      tone={databaseTone(d.status)}
                    />
                  }
                  gauge={
                    <SpecTiles
                      items={[
                        {
                          value: `${tDynamic(locale, `m8.engine.${d.engine}`, d.engine)} ${d.version}`,
                          caption: t(locale, 'm8.dbd.ov.engine'),
                        },
                        {
                          value: d.backupPolicy.enabled ? `${d.backupPolicy.intervalHours}h` : '—',
                          caption: t(locale, 'm8.dbd.ov.backupEvery'),
                        },
                        {
                          value: d.backupPolicy.enabled ? `${d.backupPolicy.retentionDays}d` : '—',
                          caption: t(locale, 'm8.dbd.ov.kept'),
                        },
                      ]}
                    />
                  }
                  rows={[
                    {
                      icon: 'lock',
                      label: t(locale, 'm8.dbd.tls'),
                      value: <Badge tone="success">{t(locale, 'm8.dbd.tlsRequired')}</Badge>,
                    },
                    {
                      icon: 'shield',
                      label: t(locale, 'm8.dbn.network'),
                      value:
                        d.network.access === 'private'
                          ? t(locale, 'm8.dbn.net.private')
                          : t(locale, 'm8.dbn.net.allowlist'),
                    },
                    {
                      icon: 'pin',
                      label: t(locale, 'field.region'),
                      value: <Ltr>{d.dataRegion}</Ltr>,
                    },
                    {
                      icon: 'calendar',
                      label: t(locale, 'field.created'),
                      value: formatDateTime(d.createdAt, locale),
                    },
                  ]}
                />
                <SidePanel title={t(locale, 'm8.dbd.endpoint')}>
                  {d.endpoint ? (
                    <ul className="nzc-ns-list">
                      <li>{`${d.endpoint.host}:${d.endpoint.port}`}</li>
                    </ul>
                  ) : (
                    <p className="nz-muted" style={{ margin: 0 }}>
                      {t(locale, 'm8.dbd.noEndpoint')}
                    </p>
                  )}
                  {d.network.access !== 'private' && (d.network.allowCidrs ?? []).length > 0 && (
                    <ul className="nzc-ns-list" style={{ marginBlockStart: 8 }}>
                      {(d.network.allowCidrs ?? []).map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                </SidePanel>
                <SidePanel title={t(locale, 'm8.dbd.credential')}>
                  <p className="nz-muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                    {t(locale, 'm8.dbd.vaultRef')}: {d.vaultRef ? <Ltr>{d.vaultRef}</Ltr> : '—'}
                  </p>
                </SidePanel>
              </>
            }
          />
        </>
      );
    },
  );
  return body;
}
