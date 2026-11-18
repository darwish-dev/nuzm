import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../../components/M12Tabs';
import { IncidentUpdatePanel } from '../../../../../components/OpsPanels';
import { gate } from '../../../../../lib/gate';
import {
  incidentSeverityTone,
  incidentStatusTone,
  readTimeline,
  shortId,
} from '../../../../../lib/ops';
import { view } from '../../../../../lib/view';

/**
 * UI-M12-06: one incident. There is no GET-by-id endpoint: the detail is derived from the list response, which carries each incident's timeline
 * (latest 50 updates). An incident outside the 200 newest is reported as not found here; open it from the list filters instead.
 */
export default async function IncidentDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gate(params, 'admin:ops:read', 'm12.inc.detail.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  const canManage = s.can('admin:ops:manage');
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/incidents', { params: { query: { limit: 200 } } })),
    (data) => {
      const one = data.items.find((i) => i.id === id);
      if (!one)
        return (
          <EmptyState
            title={t(locale, 'm12.inc.notFound')}
            body={t(locale, 'm12.inc.notFoundBody')}
          />
        );
      const timeline = readTimeline(one.timeline);
      const drafts = timeline.filter((e) => e.kind === 'comms_draft');
      return (
        <>
          <Card aria-label={one.title ?? shortId(one.id)}>
            <h2 className="nz-h2">{one.title ?? shortId(one.id)}</h2>
            <p>
              <Badge tone={incidentSeverityTone(one.severity)}>
                {tDynamic(locale, `m12.inc.sev.${one.severity}`, one.severity)}
              </Badge>{' '}
              <Badge tone={incidentStatusTone(one.status)}>
                {tDynamic(locale, `m12.inc.status.${one.status}`, one.status)}
              </Badge>
            </p>
            {one.summary && <p>{one.summary}</p>}
            <p>
              {t(locale, 'm12.inc.col.components')}:{' '}
              {one.components && one.components.length > 0 ? (
                <Ltr>{one.components.join(', ')}</Ltr>
              ) : (
                '—'
              )}
            </p>
            <p>
              {t(locale, 'm12.inc.col.opened')}:{' '}
              {one.openedAt ? formatDateTime(one.openedAt, locale) : '—'}
              {one.resolvedAt
                ? ` · ${t(locale, 'm12.inc.resolvedAt', { time: formatDateTime(one.resolvedAt, locale) })}`
                : ''}
            </p>
            <p>
              {t(locale, 'm12.inc.breach')}:{' '}
              {one.breachCaseId ? (
                <a href={`/${locale}/compliance/breach-cases?id=${one.breachCaseId}`}>
                  <Ltr>{one.breachCaseId}</Ltr>
                </a>
              ) : (
                t(locale, 'm12.inc.breach.none')
              )}
            </p>
          </Card>
          <h2 className="nz-h2">{t(locale, 'm12.inc.timeline')}</h2>
          {timeline.length === 0 ? (
            <EmptyState title={t(locale, 'm12.none')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'm12.inc.timeline')}
              rows={timeline}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'at',
                  header: t(locale, 'field.when'),
                  render: (r) => formatDateTime(r.at, locale),
                },
                {
                  key: 'k',
                  header: t(locale, 'm12.inc.col.kind'),
                  render: (r) => tDynamic(locale, `m12.inc.kind.${r.kind}`, r.kind),
                },
                {
                  key: 'd',
                  header: t(locale, 'm12.inc.col.detail'),
                  render: (r) =>
                    r.statusTo
                      ? tDynamic(locale, `m12.inc.status.${r.statusTo}`, r.statusTo)
                      : r.severityTo
                        ? tDynamic(locale, `m12.inc.sev.${r.severityTo}`, r.severityTo)
                        : (r.body ?? '—'),
                },
                {
                  key: 'by',
                  header: t(locale, 'field.actor'),
                  render: (r) => <Ltr>{shortId(r.author)}</Ltr>,
                },
              ]}
            />
          )}
          <h2 className="nz-h2">{t(locale, 'm12.inc.comms.title')}</h2>
          <p className="nz-muted">{t(locale, 'm12.inc.comms.help')}</p>
          {drafts.length === 0 ? (
            <p>{t(locale, 'm12.inc.comms.none')}</p>
          ) : (
            drafts.map((d) => (
              <Card key={d.id} aria-label={t(locale, 'm12.inc.comms.title')}>
                <p className="nz-muted">{formatDateTime(d.at, locale)}</p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{d.body}</p>
              </Card>
            ))
          )}
          {canManage ? (
            <IncidentUpdatePanel
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              id={one.id}
              status={one.status}
              severity={one.severity}
              breachCaseId={one.breachCaseId ?? null}
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
      <PageTitle>{t(locale, 'm12.inc.detail.title')}</PageTitle>
      <OpsTabs locale={locale} current="incidents" can={s.can} />
      <p>
        <a href={`/${locale}/incidents`}>{t(locale, 'm12.inc.back')}</a>
      </p>
      <Banner tone="warn">{t(locale, 'm12.inc.help')}</Banner>
      {body}
    </>
  );
}
