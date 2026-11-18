import { t, type Locale } from '@nuzm/i18n';
import { Button, EmptyState, Field, Ltr, Select, Table } from '@nuzm/ui';
import { METRIC_WINDOWS, type MetricWindow, type SeriesView } from '../lib/compute';

const num = (n: number | undefined, locale: Locale): string =>
  n === undefined
    ? '—'
    : new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', {
        maximumFractionDigits: 2,
      }).format(n);

/** UI-M05-05: metrics for a window; `unsupported` (provider exposes none, or 422 unsupported_capability) is an empty state, not an error. */
export function MetricsPanel(p: {
  locale: Locale;
  unsupported: boolean;
  series: SeriesView[];
  window: MetricWindow;
}) {
  const { locale } = p;
  if (p.unsupported)
    return (
      <EmptyState
        title={t(locale, 'm05.web.metrics.unsupported.title')}
        body={t(locale, 'm05.web.metrics.unsupported.body')}
      />
    );
  return (
    <>
      <form method="get" className="nz-card" aria-label={t(locale, 'm05.web.metrics.window')}>
        <div className="nz-row" style={{ alignItems: 'flex-end' }}>
          <Field id="m-window" label={t(locale, 'm05.web.metrics.window')}>
            {(x) => (
              <Select {...x} name="window" defaultValue={p.window}>
                {METRIC_WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {t(locale, `m05.web.metrics.w.${w}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit">{t(locale, 'action.search')}</Button>
        </div>
      </form>
      {p.series.length === 0 ? (
        <EmptyState
          title={t(locale, 'm05.web.metrics.empty.title')}
          body={t(locale, 'm05.web.metrics.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'm05.web.detail.tab.metrics')}
          rows={p.series}
          rowKey={(s) => s.name}
          columns={[
            { key: 'name', header: t(locale, 'field.name'), render: (s) => <Ltr>{s.name}</Ltr> },
            {
              key: 'unit',
              header: t(locale, 'bill.f.unit'),
              render: (s) => (s.unit ? <Ltr>{s.unit}</Ltr> : '—'),
            },
            {
              key: 'latest',
              header: t(locale, 'm05.web.metrics.latest'),
              render: (s) => <Ltr>{num(s.latest, locale)}</Ltr>,
            },
            {
              key: 'min',
              header: t(locale, 'm05.web.metrics.min'),
              render: (s) => <Ltr>{num(s.min, locale)}</Ltr>,
            },
            {
              key: 'max',
              header: t(locale, 'm05.web.metrics.max'),
              render: (s) => <Ltr>{num(s.max, locale)}</Ltr>,
            },
            {
              key: 'points',
              header: t(locale, 'm05.web.metrics.points'),
              render: (s) => <Ltr>{String(s.points)}</Ltr>,
            },
          ]}
        />
      )}
    </>
  );
}
