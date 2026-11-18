import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, PageTitle, Select, Table } from '@nuzm/ui';
import { AlertActions, AlertDefineForm } from '../../../../components/OpsPanels';
import { OpsTabs } from '../../../../components/M12Tabs';
import { gate } from '../../../../lib/gate';
import { ALERT_STATES, alertSeverityTone, alertStateTone, readRule } from '../../../../lib/ops';
import { view } from '../../../../lib/view';

/** UI-M12-07: alert rules and their state. A rule whose metric is not measured is not evaluated: its state stays as it was, never "ok". */
export default async function Alerts({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string; cursor?: string }>;
}) {
  const g = await gate(params, 'admin:ops:read', 'm12.al.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const state = (ALERT_STATES as readonly string[]).includes(q.state ?? '')
    ? (q.state as (typeof ALERT_STATES)[number])
    : undefined;
  const canManage = s.can('admin:ops:manage');
  const factor = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/alerts', {
          params: { query: { limit: 100, state, cursor: q.cursor || undefined } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm12.al.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'm12.al.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'k',
                header: t(locale, 'm12.al.col.rule'),
                render: (r) => (
                  <>
                    {r.title ?? ''} <Ltr>{r.ruleKey}</Ltr>
                  </>
                ),
              },
              {
                key: 'sv',
                header: t(locale, 'm12.al.col.severity'),
                render: (r) =>
                  r.severity ? (
                    <Badge tone={alertSeverityTone(r.severity)}>
                      {tDynamic(locale, `m12.al.sev.${r.severity}`, r.severity)}
                    </Badge>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'st',
                header: t(locale, 'm12.al.col.state'),
                render: (r) => (
                  <>
                    <Badge tone={alertStateTone(r.state)}>
                      {tDynamic(locale, `m12.al.state.${r.state}`, r.state)}
                    </Badge>
                    {r.stateSince && (
                      <div className="nz-muted">{formatDateTime(r.stateSince, locale)}</div>
                    )}
                    {r.state === 'silenced' && r.silencedUntil && (
                      <div>
                        {t(locale, 'm12.al.silencedUntil', {
                          time: formatDateTime(r.silencedUntil, locale),
                        })}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'rule',
                header: t(locale, 'm12.al.col.rule2'),
                render: (r) => {
                  const rule = readRule(r.rule);
                  return rule ? <Ltr>{`${rule.metric} ${rule.op} ${rule.threshold}`}</Ltr> : '—';
                },
              },
              {
                key: 'v',
                header: t(locale, 'm12.al.col.lastValue'),
                render: (r) =>
                  r.lastValue === null || r.lastValue === undefined ? (
                    t(locale, 'm12.health.notMeasured')
                  ) : (
                    <>
                      <Ltr>{String(r.lastValue)}</Ltr>
                      {r.lastEvaluatedAt && (
                        <div className="nz-muted">{formatDateTime(r.lastEvaluatedAt, locale)}</div>
                      )}
                    </>
                  ),
              },
              {
                key: 'o',
                header: t(locale, 'm12.al.col.owner'),
                render: (r) => (r.ownerRole ? <Ltr>{r.ownerRole}</Ltr> : '—'),
              },
              {
                key: 'rb',
                header: t(locale, 'm12.al.col.runbook'),
                render: (r) => (r.runbookUrl ? <Ltr>{r.runbookUrl}</Ltr> : '—'),
              },
              ...(canManage
                ? [
                    {
                      key: 'a',
                      header: t(locale, 'm12.al.col.actions'),
                      render: (r: { ruleKey: string; state: string }) => (
                        <AlertActions
                          locale={locale}
                          mfaFactorId={factor}
                          ruleKey={r.ruleKey}
                          state={r.state}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {data.nextCursor && (
          <p>
            <a
              href={`/${locale}/alerts?${new URLSearchParams({
                ...(state ? { state } : {}),
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
      <PageTitle>{t(locale, 'm12.al.title')}</PageTitle>
      <OpsTabs locale={locale} current="alerts" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.al.help')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'm12.al.filter')}>
        <Field id="af-state" label={t(locale, 'm12.al.col.state')}>
          {(x) => (
            <Select {...x} name="state" defaultValue={state ?? ''}>
              <option value="">{t(locale, 'm12.any')}</option>
              {ALERT_STATES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `m12.al.state.${v}`)}
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
        <AlertDefineForm locale={locale} mfaFactorId={factor} />
      ) : (
        <p className="nz-muted">{t(locale, 'm12.readOnly')}</p>
      )}
    </>
  );
}
