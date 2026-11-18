import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Ltr, Table } from '@nuzm/ui';
import {
  QUALITY_METRICS,
  anyBreach,
  breached,
  metricDelta,
  metricText,
  type Quality,
  type QualityMetric,
} from '../lib/ai';

/** Thresholds and the trend table of the evaluation reports (UI-M09-14). A breach is the harness's verdict, shown as text and a badge, never by colour alone. */
export function QualityPanel({ locale, quality }: { locale: Locale; quality: Quality }) {
  const th = quality.thresholds;
  const metricName = (m: QualityMetric) => tDynamic(locale, `aia.quality.m.${m}`, m);
  return (
    <>
      {anyBreach(quality) ? (
        <Banner tone="danger">{t(locale, 'aia.quality.breach')}</Banner>
      ) : (
        <p>{t(locale, 'aia.quality.noBreach')}</p>
      )}
      <h2 className="nz-h2">{t(locale, 'aia.quality.thresholds')}</h2>
      <p className="nz-muted">{t(locale, 'aia.quality.thresholdsHelp')}</p>
      <Table
        caption={t(locale, 'aia.quality.thresholds')}
        rows={[...QUALITY_METRICS]}
        rowKey={(m) => m}
        columns={[
          { key: 'm', header: t(locale, 'aia.quality.metric'), render: (m) => metricName(m) },
          {
            key: 't',
            header: t(locale, 'aia.quality.threshold'),
            render: (m) => {
              const v = metricText(th[m]);
              return v === null ? t(locale, 'aia.quality.notSet') : <Ltr>{v}</Ltr>;
            },
          },
        ]}
      />
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'aia.quality.trend')}
      </h2>
      <p className="nz-muted">{t(locale, 'aia.quality.trendHelp')}</p>
      <Table
        caption={t(locale, 'aia.quality.trend')}
        rows={quality.reports.map((r, i) => ({ r, i }))}
        rowKey={(x) => x.r.id}
        columns={[
          {
            key: 'w',
            header: t(locale, 'field.when'),
            render: ({ r }) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
          },
          {
            key: 'mo',
            header: t(locale, 'aia.quality.model'),
            render: ({ r }) => (
              <>
                <Ltr>{r.model}</Ltr>
                <p>
                  <Badge tone={r.modelQuality === 'VERIFIED' ? 'success' : 'warn'}>
                    {r.modelQuality === 'VERIFIED'
                      ? t(locale, 'aia.quality.verified')
                      : t(locale, 'aia.quality.notVerified')}
                  </Badge>
                </p>
              </>
            ),
          },
          { key: 'n', header: t(locale, 'aia.quality.sites'), render: ({ r }) => r.sites },
          ...QUALITY_METRICS.map((m) => ({
            key: m,
            header: metricName(m),
            render: ({ r, i }: { r: Quality['reports'][number]; i: number }) => {
              const v = metricText(r.metrics[m]);
              if (v === null)
                return (
                  <>
                    <span className="nz-muted">
                      {m === 'humanRubricMean'
                        ? t(locale, 'aia.quality.rubricPending')
                        : t(locale, 'aia.quality.notMeasured')}
                    </span>
                    {breached(r, m) && (
                      <p>
                        <Badge tone="danger">{t(locale, 'aia.quality.breached')}</Badge>
                      </p>
                    )}
                  </>
                );
              const d = metricDelta(quality.reports, i, m);
              return (
                <>
                  <Ltr>{v}</Ltr>
                  {d !== null && (
                    <span className="nz-muted">
                      {' '}
                      (<Ltr>{d}</Ltr>)
                    </span>
                  )}
                  {breached(r, m) && (
                    <p>
                      <Badge tone="danger">{t(locale, 'aia.quality.breached')}</Badge>
                    </p>
                  )}
                </>
              );
            },
          })),
        ]}
      />
    </>
  );
}
