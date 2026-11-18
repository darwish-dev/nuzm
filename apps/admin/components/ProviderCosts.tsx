import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, Table } from '@nuzm/ui';
import { bpsToPercent, reportCell } from '../lib/finance';
import {
  costSummary,
  formatCost,
  isNegativeMinor,
  isUnattributed,
  runSkipped,
  runVariance,
  shortId,
  type ProviderCostDto,
  type ProviderCostPage,
} from '../lib/providers';

/** Totals per currency (never summed across currencies) and the count of records nobody owns. */
export function CostTotals({
  locale,
  totals,
}: {
  locale: Locale;
  totals: ProviderCostPage['totals'];
}) {
  const s = costSummary(totals);
  return (
    <section aria-label={t(locale, 'm05.adm.cost.totals')}>
      {s.unattributed > 0 && (
        <Banner tone="danger">
          {t(locale, 'm05.adm.cost.unattributedWarn', { count: s.unattributed })}
        </Banner>
      )}
      <dl>
        {totals.map((x) => (
          <div key={x.currency} className="nz-row">
            <dt className="nz-muted" style={{ minInlineSize: '12rem' }}>
              <Ltr>{x.currency}</Ltr>
            </dt>
            <dd style={{ margin: 0 }}>
              <Ltr>{formatCost(x.costMinor, x.currency)}</Ltr>{' '}
              <span className="nz-muted">
                {t(locale, 'm05.adm.cost.records', { count: x.records })}
              </span>
              {x.unattributed > 0 && (
                <>
                  {' '}
                  <Badge tone="danger">
                    {t(locale, 'm05.adm.cost.unattributed', { count: x.unattributed })}
                  </Badge>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Provider cost records as captured (API or bill import). Records with no organization or resource are highlighted as variance. */
export function CostsTable({ locale, rows }: { locale: Locale; rows: ProviderCostDto[] }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.cost.empty.title')}
        body={t(locale, 'm05.adm.cost.empty.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm05.adm.cost.title')}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'p',
          header: t(locale, 'm05.adm.col.provider'),
          render: (r) => <Ltr>{r.providerKey}</Ltr>,
        },
        {
          key: 'per',
          header: t(locale, 'm05.adm.cost.col.period'),
          icon: 'calendar',
          render: (r) => (
            <Ltr>
              {r.periodStart} → {r.periodEnd}
            </Ltr>
          ),
        },
        {
          key: 'm',
          header: t(locale, 'm05.adm.cost.col.meter'),
          icon: 'tag',
          render: (r) => <Ltr>{r.meterOrSku}</Ltr>,
        },
        {
          key: 'q',
          header: t(locale, 'm05.adm.cost.col.quantity'),
          icon: 'tag',
          render: (r) => <Ltr>{r.quantity}</Ltr>,
        },
        {
          key: 'c',
          header: t(locale, 'm05.adm.cost.col.cost'),
          icon: 'tag',
          render: (r) => <Ltr>{formatCost(r.costMinor, r.currency)}</Ltr>,
        },
        {
          key: 'src',
          header: t(locale, 'm05.adm.cost.col.source'),
          icon: 'tag',
          render: (r) => t(locale, `m05.adm.cost.source.${r.source}`),
        },
        {
          key: 'a',
          header: t(locale, 'm05.adm.cost.col.attribution'),
          icon: 'tag',
          render: (r) =>
            isUnattributed(r) ? (
              <Badge tone="danger">{t(locale, 'm05.adm.cost.unattributedShort')}</Badge>
            ) : (
              <span title={r.orgId ?? ''}>
                <Ltr>{r.orgId ? shortId(r.orgId) : ''}</Ltr>
              </span>
            ),
        },
        {
          key: 'w',
          header: t(locale, 'm05.adm.cost.col.captured'),
          icon: 'tag',
          render: (r) => formatDateTime(r.capturedAt, locale),
        },
      ]}
    />
  );
}

export interface Rc04Run {
  id: string;
  periodFrom: string;
  periodTo: string;
  status: string;
  itemsChecked: number;
  breaksCount: number;
  openBreaks: number;
  summary?: unknown;
  createdAt: string;
}

/** RC-04 results (provider cost vs ledger and bills). A run with breaks is a variance; an open one is highlighted. A skipped comparison says so. */
export function Rc04Table(p: { locale: Locale; rows: Rc04Run[]; linkRuns: boolean }) {
  if (p.rows.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.rc4.empty.title')}
        body={t(p.locale, 'm05.adm.rc4.empty.body')}
      />
    );
  return (
    <Table
      caption={t(p.locale, 'm05.adm.rc4.title')}
      rows={p.rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'per',
          header: t(p.locale, 'm05.adm.cost.col.period'),
          icon: 'calendar',
          render: (r) => {
            const label = (
              <Ltr>
                {r.periodFrom} → {r.periodTo}
              </Ltr>
            );
            return p.linkRuns ? (
              <a href={`/${p.locale}/billing/reconciliations/${r.id}`}>{label}</a>
            ) : (
              label
            );
          },
        },
        {
          key: 's',
          header: t(p.locale, 'm05.adm.col.status'),
          icon: 'pulse',
          render: (r) => (
            <span>
              <Badge
                tone={
                  r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warn'
                }
              >
                {tDynamic(p.locale, `af.rc.status.${r.status}`, r.status)}
              </Badge>
              {runSkipped(r.summary) && (
                <>
                  {' '}
                  <Badge tone="warn">{t(p.locale, 'm05.adm.rc4.skipped')}</Badge>
                </>
              )}
            </span>
          ),
        },
        {
          key: 'c',
          header: t(p.locale, 'af.rc.col.checked'),
          render: (r) => <Ltr>{String(r.itemsChecked)}</Ltr>,
        },
        {
          key: 'b',
          header: t(p.locale, 'af.rc.col.breaks'),
          render: (r) => <Ltr>{String(r.breaksCount)}</Ltr>,
        },
        {
          key: 'v',
          header: t(p.locale, 'm05.adm.rc4.variance'),
          render: (r) => {
            const v = runVariance(r);
            return (
              <Badge tone={v === 'open' ? 'danger' : v === 'resolved' ? 'warn' : 'success'}>
                {t(p.locale, `m05.adm.rc4.variance.${v}`, { count: r.openBreaks })}
              </Badge>
            );
          },
        },
        {
          key: 'w',
          header: t(p.locale, 'field.when'),
          icon: 'calendar',
          render: (r) => formatDateTime(r.createdAt, p.locale),
        },
      ]}
    />
  );
}

export interface MarginReport {
  from: string;
  to: string;
  columns: { key: string; label: string; kind: string }[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  notes: string[];
}

/** Margin view: revenue against provider cost accruals. A negative margin is highlighted. Money is rendered from integer minor units. */
export function MarginPanel({ locale, r }: { locale: Locale; r: MarginReport }) {
  if (r.rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.margin.empty.title')}
        body={t(locale, 'm05.adm.margin.empty.body')}
      />
    );
  const currency = (row: Record<string, unknown>) =>
    typeof row.currency === 'string' ? row.currency : 'SAR';
  return (
    <>
      <p className="nz-muted">{t(locale, 'af.rp.period', { from: r.from, to: r.to })}</p>
      <Table
        caption={t(locale, 'm05.adm.margin.title')}
        rows={r.rows.map((row, i) => ({ row, i }))}
        rowKey={(x) => `${x.i}`}
        columns={r.columns.map((c) => ({
          key: c.key,
          header: tDynamic(locale, `af.rp.col.${c.key}`, c.label),
          render: (x: { row: Record<string, unknown> }) => {
            const v = x.row[c.key];
            const cell = reportCell(c.key, c.kind, v);
            if (cell.kind === 'money') {
              const neg = isNegativeMinor(cell.minor);
              return (
                <span>
                  <Ltr>{formatCost(cell.minor, currency(x.row))}</Ltr>
                  {neg && /margin/i.test(c.key) && (
                    <>
                      {' '}
                      <Badge tone="danger">{t(locale, 'm05.adm.margin.negative')}</Badge>
                    </>
                  )}
                </span>
              );
            }
            if (cell.kind === 'bps') return <Ltr>{bpsToPercent(cell.value)}%</Ltr>;
            return <Ltr>{cell.kind === 'bool' ? String(cell.value) : cell.value}</Ltr>;
          },
        }))}
      />
      {r.notes.length > 0 && (
        <ul lang="en" dir="ltr">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}
