import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../../components/M12Tabs';
import { gate } from '../../../../../lib/gate';
import { healthTone, readHealth } from '../../../../../lib/ops';
import { view } from '../../../../../lib/view';

/** UI-M12-04: operational health. Anything the platform did not measure is shown as unknown / not measured, never as healthy. */
export default async function Health({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'admin:ops:read', 'm12.health.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const when = (iso: string | null) =>
    iso ? formatDateTime(iso, locale) : t(locale, 'm12.health.never');
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/operations/health', {})),
    (raw) => {
      const h = readHealth(raw);
      return (
        <>
          <p>
            <strong>{t(locale, 'm12.health.overall')}</strong>{' '}
            <Badge tone={healthTone(h.status)}>
              {tDynamic(locale, `m12.health.status.${h.status}`, h.status)}
            </Badge>{' '}
            {h.generatedAt && (
              <span className="nz-muted">
                {t(locale, 'm12.health.generated', { time: formatDateTime(h.generatedAt, locale) })}
              </span>
            )}
          </p>
          {h.components.length === 0 ? (
            <EmptyState title={t(locale, 'm12.none')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'm12.health.components')}
              rows={h.components}
              rowKey={(r) => r.key}
              columns={[
                {
                  key: 'k',
                  header: t(locale, 'm12.health.col.component'),
                  render: (r) => tDynamic(locale, `m12.health.comp.${r.key}`, r.key),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (r) => (
                    <Badge tone={healthTone(r.status)}>
                      {tDynamic(locale, `m12.health.status.${r.status}`, r.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'd',
                  header: t(locale, 'm12.health.col.detail'),
                  render: (r) =>
                    r.detail.length === 0 ? (
                      '—'
                    ) : (
                      <Ltr>{r.detail.map(([k, v]) => `${k}: ${v}`).join('; ')}</Ltr>
                    ),
                },
              ]}
            />
          )}
          <div className="nz-grid">
            <Card aria-labelledby="hl-queues">
              <h2 className="nz-h2" id="hl-queues">
                {t(locale, 'm12.health.queues')}
              </h2>
              <p>
                {t(locale, 'm12.health.outboxLag')}:{' '}
                {h.outboxLagSeconds === null ? (
                  t(locale, 'm12.health.notMeasured')
                ) : (
                  <Ltr>{`${h.outboxLagSeconds} ${t(locale, 'm12.unit.seconds')}`}</Ltr>
                )}
              </p>
              <p>{t(locale, 'm12.health.opsByState')}:</p>
              {h.operationsByState.length === 0 ? (
                <p className="nz-muted">{t(locale, 'm12.none')}</p>
              ) : (
                <ul>
                  {h.operationsByState.map(([k, v]) => (
                    <li key={k}>
                      <Ltr>{k}</Ltr>: <Ltr>{String(v)}</Ltr>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card aria-labelledby="hl-rec">
              <h2 className="nz-h2" id="hl-rec">
                {t(locale, 'm12.health.reconcilers')}
              </h2>
              <p>
                {t(locale, 'm12.health.finLast')}: {when(h.financialLastRunAt)}
              </p>
              <p>
                {t(locale, 'm12.health.techLast')}: {when(h.technicalLastRunAt)}
              </p>
              <p>
                {t(locale, 'm12.health.openBreaks')}:{' '}
                {h.openFinancialBreaks === null ? (
                  t(locale, 'm12.health.notMeasured')
                ) : (
                  <Ltr>{String(h.openFinancialBreaks)}</Ltr>
                )}
              </p>
            </Card>
            <Card aria-labelledby="hl-prov">
              <h2 className="nz-h2" id="hl-prov">
                {t(locale, 'm12.health.providers')}
              </h2>
              <p>
                {t(locale, 'm12.health.openProviderIncidents')}:{' '}
                {h.openProviderIncidents === null ? (
                  t(locale, 'm12.health.notMeasured')
                ) : (
                  <Ltr>{String(h.openProviderIncidents)}</Ltr>
                )}
              </p>
              <p>
                <a href={`/${locale}/provider-incidents`}>
                  {t(locale, 'm12.tab.providerIncidents')}
                </a>
              </p>
            </Card>
            <Card aria-labelledby="hl-alerts">
              <h2 className="nz-h2" id="hl-alerts">
                {t(locale, 'm12.health.alerts')}
              </h2>
              {(['firing', 'acknowledged', 'silenced'] as const).map((k) => (
                <p key={k}>
                  {t(locale, `m12.al.state.${k}`)}:{' '}
                  {h.alerts[k] === null ? (
                    t(locale, 'm12.health.notMeasured')
                  ) : (
                    <Ltr>{String(h.alerts[k])}</Ltr>
                  )}
                </p>
              ))}
              <p>
                <a href={`/${locale}/alerts`}>{t(locale, 'm12.tab.alerts')}</a>
              </p>
            </Card>
          </div>
          <h2 className="nz-h2">{t(locale, 'm12.health.probes')}</h2>
          {h.probes.length === 0 ? (
            <EmptyState
              title={t(locale, 'm12.health.noProbes')}
              body={t(locale, 'm12.health.noProbesBody')}
            />
          ) : (
            <Table
              caption={t(locale, 'm12.health.probes')}
              rows={h.probes}
              rowKey={(r) => r.key}
              columns={[
                {
                  key: 'k',
                  header: t(locale, 'm12.health.col.probe'),
                  render: (r) => <Ltr>{r.key}</Ltr>,
                },
                {
                  key: 'ok',
                  header: t(locale, 'm12.health.col.result'),
                  render: (r) => (
                    <Badge tone={r.ok ? 'success' : 'danger'}>
                      {t(locale, r.ok ? 'm12.health.probe.ok' : 'm12.health.probe.fail')}
                    </Badge>
                  ),
                },
                {
                  key: 'm',
                  header: t(locale, 'm12.health.col.mode'),
                  render: (r) => tDynamic(locale, `m12.health.mode.${r.mode}`, r.mode),
                },
                {
                  key: 'at',
                  header: t(locale, 'm12.health.col.ranAt'),
                  render: (r) => (r.ranAt ? formatDateTime(r.ranAt, locale) : '—'),
                },
              ]}
            />
          )}
          <h2 className="nz-h2">{t(locale, 'm12.health.slo')}</h2>
          {h.sloBurn.length === 0 ? (
            <EmptyState title={t(locale, 'm12.none')} body={t(locale, 'm12.health.sloNote')} />
          ) : (
            <Table
              caption={t(locale, 'm12.health.slo')}
              rows={h.sloBurn}
              rowKey={(r) => r.sloKey}
              columns={[
                {
                  key: 'k',
                  header: t(locale, 'm12.health.col.slo'),
                  render: (r) => <Ltr>{r.sloKey}</Ltr>,
                },
                {
                  key: 'o',
                  header: t(locale, 'm12.health.col.objective'),
                  render: (r) =>
                    r.objective === null ? '—' : <Ltr>{`${r.objective} ${r.unit}`}</Ltr>,
                },
                {
                  key: 'm',
                  header: t(locale, 'm12.health.col.measured'),
                  render: (r) =>
                    r.measured === null ? (
                      t(locale, 'm12.health.notMeasured')
                    ) : (
                      <Ltr>{`${r.measured} ${r.unit}`}</Ltr>
                    ),
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (r) => (
                    <Badge tone={healthTone(r.status)}>
                      {tDynamic(locale, `m12.health.slo.${r.status}`, r.status)}
                    </Badge>
                  ),
                },
              ]}
            />
          )}
          <p className="nz-muted">{t(locale, 'm12.health.sloNote')}</p>
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.health.title')}</PageTitle>
      <OpsTabs locale={locale} current="health" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.health.help')}</Banner>
      {body}
    </>
  );
}
