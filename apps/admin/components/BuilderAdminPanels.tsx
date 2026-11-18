import { formatDateTime, formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Badge, Banner, EmptyState, Ltr, Table } from '@nuzm/ui';
import { anyFlag, shortId, stateTone, type AdminRunRow } from '../lib/builder-admin';

/** UI-M10-18: read-only run oversight. Metadata only (kind, state, budget, usage, region, flags): there is no prompt, output or file content to show. */
export function AdminRunsTable({ locale, rows }: { locale: Locale; rows: AdminRunRow[] }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm10.adm.runs.empty')}
        body={t(locale, 'm10.adm.runs.emptyBody')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm10.adm.runs.title')}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'i',
          header: t(locale, 'm10.adm.col.run'),
          render: (r) => <Ltr>{shortId(r.id)}</Ltr>,
        },
        {
          key: 'o',
          header: t(locale, 'm10.adm.col.org'),
          render: (r) => <Ltr>{shortId(r.orgId)}</Ltr>,
        },
        { key: 'k', header: t(locale, 'm10.adm.col.kind'), render: (r) => <Ltr>{r.kind}</Ltr> },
        {
          key: 's',
          header: t(locale, 'm10.adm.col.state'),
          render: (r) => (
            <>
              <Badge tone={stateTone(r.state)}>
                {tDynamic(locale, `m10.run.state.${r.state}`, r.state)}
              </Badge>
              {r.reason && (
                <>
                  {' '}
                  <span className="nz-muted">
                    {tDynamic(locale, `m10.run.reason.${r.reason}`, r.reason)}
                  </span>
                </>
              )}
            </>
          ),
        },
        {
          key: 'b',
          header: t(locale, 'm10.adm.col.budget'),
          render: (r) =>
            r.budget ? (
              <Ltr>{`${r.budget.maxTokens} tok · ${formatMinor(String(r.budget.maxCostMinor), 'SAR', locale)} · ${r.budget.maxMinutes} min`}</Ltr>
            ) : (
              '—'
            ),
        },
        {
          key: 'u',
          header: t(locale, 'm10.adm.col.usage'),
          render: (r) =>
            r.usage ? (
              <Ltr>{`${r.usage.tokens} tok · ${formatMinor(String(r.usage.costMinor), 'SAR', locale)} · ${r.usage.steps} steps`}</Ltr>
            ) : (
              '—'
            ),
        },
        {
          key: 'r',
          header: t(locale, 'field.region'),
          render: (r) => <Ltr>{r.dataRegion || '—'}</Ltr>,
        },
        {
          key: 'f',
          header: t(locale, 'm10.adm.col.flags'),
          render: (r) =>
            anyFlag(r) ? (
              <>
                {r.flags.budgetBreach && (
                  <Badge tone="danger">{t(locale, 'm10.adm.flag.budgetBreach')}</Badge>
                )}{' '}
                {r.flags.deniedApproval && (
                  <Badge tone="warn">{t(locale, 'm10.adm.flag.deniedApproval')}</Badge>
                )}{' '}
                {r.flags.escalated && (
                  <Badge tone="warn">{t(locale, 'm10.adm.flag.escalated')}</Badge>
                )}
              </>
            ) : (
              <span className="nz-muted">{t(locale, 'm10.adm.flag.none')}</span>
            ),
        },
        {
          key: 'c',
          header: t(locale, 'm10.adm.col.created'),
          render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
        },
      ]}
    />
  );
}

/** UI-M10-19: sandbox nodes of the resource inventory (read via `/v1/admin/resources`). There is NO kill button: the force-kill action waits for its spec change. */
export function AdminSandboxNodes({
  locale,
  rows,
}: {
  locale: Locale;
  rows: Schemas['CloudResource'][];
}) {
  return (
    <>
      <Banner tone="warn">{t(locale, 'm10.adm.sbx.m05')}</Banner>
      <Banner tone="warn">{t(locale, 'm10.adm.sbx.noKill')}</Banner>
      {rows.length === 0 ? (
        <EmptyState
          title={t(locale, 'm10.adm.sbx.empty')}
          body={t(locale, 'm10.adm.sbx.emptyBody')}
        />
      ) : (
        <Table
          caption={t(locale, 'm10.adm.sbx.title')}
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'i',
              header: t(locale, 'm10.adm.col.node'),
              render: (r) => <Ltr>{shortId(r.id)}</Ltr>,
            },
            {
              key: 'o',
              header: t(locale, 'm10.adm.col.org'),
              render: (r) => <Ltr>{shortId(r.orgId)}</Ltr>,
            },
            { key: 'k', header: t(locale, 'm10.adm.col.kind'), render: (r) => <Ltr>{r.kind}</Ltr> },
            {
              key: 's',
              header: t(locale, 'm10.adm.col.state'),
              render: (r) => (
                <Badge
                  tone={r.state === 'ACTIVE' ? 'success' : r.state === 'FAILED' ? 'danger' : 'warn'}
                >
                  {r.state}
                </Badge>
              ),
            },
            {
              key: 'd',
              header: t(locale, 'm10.adm.col.drift'),
              render: (r) => <Ltr>{r.driftState}</Ltr>,
            },
            {
              key: 'r',
              header: t(locale, 'field.region'),
              render: (r) => <Ltr>{r.dataRegion}</Ltr>,
            },
            {
              key: 'l',
              header: t(locale, 'm10.adm.col.lastSeen'),
              render: (r) => (r.lastSeenAt ? formatDateTime(r.lastSeenAt, locale) : '—'),
            },
          ]}
        />
      )}
    </>
  );
}
