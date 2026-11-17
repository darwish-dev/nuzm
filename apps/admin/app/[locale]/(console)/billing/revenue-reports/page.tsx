import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic, type Locale } from '@nuzm/i18n';
import {
  Badge,
  Bars,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  ForbiddenState,
  Input,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import {
  REPORTS,
  barRows,
  bpsToPercent,
  humanize,
  reportCell,
  validRange,
} from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

function show(
  locale: Locale,
  key: string,
  kind: string | undefined,
  value: unknown,
  currency: string,
) {
  const c = reportCell(key, kind, value);
  switch (c.kind) {
    case 'money':
      return <Ltr>{formatMinor(c.minor, currency, locale)}</Ltr>;
    case 'bps':
      return <Ltr>{bpsToPercent(c.value)}%</Ltr>;
    case 'bool':
      return (
        <Badge tone={c.value ? 'success' : 'danger'}>
          {t(locale, c.value ? 'af.rp.yes' : 'af.rp.no')}
        </Badge>
      );
    default:
      return <Ltr>{c.value}</Ltr>;
  }
}

/** UI-M03-21: report picker, table, chart of the first money column, CSV export, and the ledger-equality badge for every ledger-tied figure. */
export default async function RevenueReports({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ report?: string; from?: string; to?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const report = REPORTS.find((x) => x === q.report) ?? 'revenue';
  const from = q.from ?? '';
  const to = q.to ?? '';
  const ranged = from !== '' || to !== '';
  const rangeOk = !ranged || validRange(from, to);
  const allowed = s.can('admin:reports:read');
  const body = !allowed ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : !rangeOk ? (
    <p role="alert" className="nz-error-text">
      {t(locale, 'af.rp.invalid')}
    </p>
  ) : (
    await view(
      locale,
      async () => {
        const r = await unwrap(
          s.api.GET('/v1/admin/billing/revenue-reports', {
            params: { query: { report, ...(ranged ? { from, to } : {}), format: 'json' } },
          }),
        );
        if (typeof r === 'string') throw new Error('the API answered CSV for a JSON request');
        return r;
      },
      (r) => {
        const label = (key: string, fallback: string) =>
          tDynamic(locale, `af.rp.col.${key}`, fallback);
        const ledgerChecks = Object.entries(r.totals).filter(
          ([k, v]) => (k === 'matchesLedger' || k === 'reconciles') && typeof v === 'boolean',
        ) as [string, boolean][];
        const bars = barRows(r.columns, r.rows);
        const moneyCol = r.columns.find((c) => c.kind === 'money');
        const textCol = r.columns.find((c) => c.kind === 'text');
        const currency = (row: Record<string, unknown>) =>
          typeof row.currency === 'string' ? row.currency : 'SAR';
        return (
          <>
            <p className="nz-muted">
              {t(locale, 'af.rp.period', { from: r.from, to: r.to })} ·{' '}
              {t(locale, 'af.rp.generated', { when: formatDateTime(r.generatedAt, locale) })}
            </p>
            <p className="nz-row">
              <ButtonLink
                variant="secondary"
                href={`/${locale}/billing/revenue-reports/export?${new URLSearchParams({
                  report,
                  from: r.from,
                  to: r.to,
                }).toString()}`}
              >
                {t(locale, 'af.rp.csv')}
              </ButtonLink>
              {ledgerChecks.map(([k, ok]) => (
                <Badge key={k} tone={ok ? 'success' : 'danger'}>
                  {t(locale, 'af.rp.ledgerCheck')}:{' '}
                  {t(locale, ok ? 'af.rp.matches' : 'af.rp.mismatch')}
                </Badge>
              ))}
            </p>
            {r.rows.length === 0 ? (
              <EmptyState title={t(locale, 'af.rp.none')} body={t(locale, 'af.rp.noneBody')} />
            ) : (
              <>
                {bars.length > 0 && moneyCol && (
                  <Bars
                    label={t(locale, 'af.rp.chart', {
                      label: label(moneyCol.key, moneyCol.label),
                    })}
                    rows={bars.map((b) => ({
                      key: b.key,
                      label: textCol ? <Ltr>{b.labelKey}</Ltr> : b.labelKey,
                      value: <Ltr>{formatMinor(b.minor, 'SAR', locale)}</Ltr>,
                      ratio: b.ratio,
                    }))}
                  />
                )}
                <Table
                  caption={tDynamic(locale, `af.rp.name.${report}`, report)}
                  rows={r.rows.map((row, i) => ({ row, i }))}
                  rowKey={(x) => `${x.i}`}
                  columns={r.columns.map((c) => ({
                    key: c.key,
                    header: label(c.key, c.label),
                    render: (x: { row: Record<string, unknown> }) =>
                      show(locale, c.key, c.kind, x.row[c.key], currency(x.row)),
                  }))}
                />
              </>
            )}
            <h2 className="nz-h2">{t(locale, 'af.rp.totals')}</h2>
            <dl>
              {Object.entries(r.totals)
                .filter(([k]) => k !== 'matchesLedger' && k !== 'reconciles')
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{tDynamic(locale, `af.rp.tot.${k}`, humanize(k))}</dt>
                    <dd>{show(locale, k, undefined, v, 'SAR')}</dd>
                  </div>
                ))}
            </dl>
            {r.notes.length > 0 && (
              <>
                <h2 className="nz-h2">{t(locale, 'af.rp.notes')}</h2>
                <ul lang="en" dir="ltr">
                  {r.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        );
      },
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.rp.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="reports" can={s.can} />
      {allowed && (
        <form method="get" className="nz-row" aria-label={t(locale, 'af.rp.title')}>
          <Field id="rp-report" label={t(locale, 'af.rp.f.report')}>
            {(x) => (
              <Select {...x} name="report" defaultValue={report}>
                {REPORTS.map((v) => (
                  <option key={v} value={v}>
                    {t(locale, `af.rp.name.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="rp-from" label={t(locale, 'af.rp.f.from')}>
            {(x) => <Input {...x} dir="ltr" type="date" name="from" defaultValue={from} />}
          </Field>
          <Field id="rp-to" label={t(locale, 'af.rp.f.to')}>
            {(x) => <Input {...x} dir="ltr" type="date" name="to" defaultValue={to} />}
          </Field>
          <Button type="submit">{t(locale, 'af.rp.show')}</Button>
        </form>
      )}
      {body}
    </>
  );
}
