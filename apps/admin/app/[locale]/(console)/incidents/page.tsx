import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, PageTitle, Select, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../components/M12Tabs';
import { IncidentOpenForm } from '../../../../components/OpsPanels';
import { gate } from '../../../../lib/gate';
import {
  INCIDENT_STATUSES,
  SEVERITIES,
  incidentSeverityTone,
  incidentStatusTone,
  shortId,
} from '../../../../lib/ops';
import { view } from '../../../../lib/view';

/** UI-M12-05: incidents: filter, list, open. Incident records carry ids and component keys, never personal data. */
export default async function Incidents({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; severity?: string; cursor?: string }>;
}) {
  const g = await gate(params, 'admin:ops:read', 'm12.inc.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const status = (INCIDENT_STATUSES as readonly string[]).includes(q.status ?? '')
    ? (q.status as (typeof INCIDENT_STATUSES)[number])
    : undefined;
  const severity = (SEVERITIES as readonly string[]).includes(q.severity ?? '')
    ? (q.severity as (typeof SEVERITIES)[number])
    : undefined;
  const canManage = s.can('admin:ops:manage');
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/incidents', {
          params: { query: { limit: 50, status, severity, cursor: q.cursor || undefined } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm12.inc.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'm12.inc.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 't',
                header: t(locale, 'm12.inc.col.title'),
                render: (r) => (
                  <a href={`/${locale}/incidents/${r.id}`}>{r.title ?? shortId(r.id)}</a>
                ),
              },
              {
                key: 'sv',
                header: t(locale, 'm12.inc.col.severity'),
                render: (r) => (
                  <Badge tone={incidentSeverityTone(r.severity)}>
                    {tDynamic(locale, `m12.inc.sev.${r.severity}`, r.severity)}
                  </Badge>
                ),
              },
              {
                key: 'st',
                header: t(locale, 'm12.inc.col.status'),
                render: (r) => (
                  <Badge tone={incidentStatusTone(r.status)}>
                    {tDynamic(locale, `m12.inc.status.${r.status}`, r.status)}
                  </Badge>
                ),
              },
              {
                key: 'c',
                header: t(locale, 'm12.inc.col.components'),
                render: (r) =>
                  r.components && r.components.length > 0 ? (
                    <Ltr>{r.components.join(', ')}</Ltr>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'o',
                header: t(locale, 'm12.inc.col.opened'),
                render: (r) => (r.openedAt ? formatDateTime(r.openedAt, locale) : '—'),
              },
            ]}
          />
        )}
        {data.nextCursor && (
          <p>
            <a
              href={`/${locale}/incidents?${new URLSearchParams({
                ...(status ? { status } : {}),
                ...(severity ? { severity } : {}),
                cursor: data.nextCursor,
              }).toString()}`}
            >
              {t(locale, 'action.loadMore')}
            </a>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.inc.title')}</PageTitle>
      <OpsTabs locale={locale} current="incidents" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.inc.help')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'm12.inc.filter')}>
        <Field id="if-status" label={t(locale, 'm12.inc.col.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'm12.any')}</option>
              {INCIDENT_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `m12.inc.status.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="if-sev" label={t(locale, 'm12.inc.col.severity')}>
          {(x) => (
            <Select {...x} name="severity" defaultValue={severity ?? ''}>
              <option value="">{t(locale, 'm12.any')}</option>
              {SEVERITIES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `m12.inc.sev.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
      {canManage ? (
        <IncidentOpenForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      ) : (
        <p className="nz-muted">{t(locale, 'm12.readOnly')}</p>
      )}
    </>
  );
}
