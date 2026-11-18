import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, Table } from '@nuzm/ui';
import {
  effectiveJobLabel,
  effectiveRunLabel,
  formatCost,
  lvKey,
  lvTone,
  stepTone,
  type LiveVerification,
  type LvLabel,
  type LvRun,
} from '../lib/providers';

export const LvBadge = ({ locale, label }: { locale: Locale; label: LvLabel }) => (
  <Badge tone={lvTone(label)}>{t(locale, `m05.adm.lv.label.${lvKey(label)}`)}</Badge>
);

/**
 * UI-M05-15: live verification status. READ-ONLY by design: there is no control that starts a run. Live verification is started by a person,
 * after the human gate (HG-05-01..03) is granted and the spend cap (HG-05-04) is set; neither the agent nor this screen can start it.
 */
export function LiveVerificationPanel({
  locale,
  data,
}: {
  locale: Locale;
  data: LiveVerification;
}) {
  const runs = [...data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <Banner tone="warn">{t(locale, 'm05.adm.lv.ownerOnly')}</Banner>
      {data.jobs.length === 0 ? (
        <EmptyState
          title={t(locale, 'm05.adm.lv.empty.title')}
          body={t(locale, 'm05.adm.lv.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'm05.adm.lv.jobs')}
          rows={data.jobs}
          rowKey={(j) => j.jobId}
          columns={[
            {
              key: 'j',
              header: t(locale, 'm05.adm.lv.col.job'),
              render: (j) => <Ltr>{j.jobId}</Ltr>,
            },
            {
              key: 'p',
              header: t(locale, 'm05.adm.col.provider'),
              render: (j) => <Ltr>{j.provider}</Ltr>,
            },
            {
              key: 'g',
              header: t(locale, 'm05.adm.lv.col.gate'),
              render: (j) => (
                <span>
                  <Ltr>{j.gate}</Ltr>{' '}
                  <Badge tone={j.gateStatus === 'GRANTED' ? 'success' : 'warn'}>
                    {t(
                      locale,
                      `m05.adm.lv.gate.${j.gateStatus === 'GRANTED' ? 'granted' : 'pending'}`,
                    )}
                  </Badge>
                </span>
              ),
            },
            {
              key: 'l',
              header: t(locale, 'm05.adm.lv.col.label'),
              render: (j) => <LvBadge locale={locale} label={effectiveJobLabel(j)} />,
            },
            {
              key: 'r',
              header: t(locale, 'm05.adm.lv.col.lastRun'),
              icon: 'calendar',
              render: (j) =>
                j.lastRunAt
                  ? formatDateTime(j.lastRunAt, locale)
                  : t(locale, 'm05.adm.lv.neverRun'),
            },
          ]}
        />
      )}
      <p className="nz-muted">{t(locale, 'm05.adm.lv.hg04')}</p>
      <h2 className="nz-h2">{t(locale, 'm05.adm.lv.runs')}</h2>
      {runs.length === 0 ? (
        <EmptyState
          title={t(locale, 'm05.adm.lv.noRuns.title')}
          body={t(locale, 'm05.adm.lv.noRuns.body')}
        />
      ) : (
        runs.map((r) => <RunCard key={r.id} locale={locale} run={r} />)
      )}
      <h2 className="nz-h2">{t(locale, 'm05.adm.lv.evidence')}</h2>
      <EvidenceIndex locale={locale} runs={runs} />
    </>
  );
}

function RunCard({ locale, run }: { locale: Locale; run: LvRun }) {
  const label = effectiveRunLabel(run);
  return (
    <section
      className="nz-card"
      aria-label={`${run.jobId} ${formatDateTime(run.createdAt, locale)}`}
    >
      <p className="nz-row">
        <Ltr>{run.jobId}</Ltr>
        <LvBadge locale={locale} label={label} />
        {label !== run.status && (
          <span className="nz-muted">{t(locale, 'm05.adm.lv.downgraded')}</span>
        )}
        <span className="nz-muted">{formatDateTime(run.createdAt, locale)}</span>
      </p>
      {/* the run's own reason is English operator text */}
      <p>
        <span lang="en" dir="ltr">
          {run.reason}
        </span>
      </p>
      {run.spendCapMinor && run.currency && (
        <p>
          {t(locale, 'm05.adm.lv.spendCap')}:{' '}
          <Ltr>{formatCost(run.spendCapMinor, run.currency)}</Ltr>
        </p>
      )}
      <p>
        {t(locale, 'm05.adm.lv.residual')}:{' '}
        {run.residualResources > 0 ? (
          <Badge tone="danger">{String(run.residualResources)}</Badge>
        ) : (
          <Ltr>0</Ltr>
        )}
      </p>
      {run.steps.length > 0 && (
        <ol aria-label={t(locale, 'm05.adm.lv.steps')}>
          {run.steps.map((s, i) => (
            <li key={`${s.step}-${i}`}>
              <Ltr>{s.step}</Ltr>{' '}
              <Badge tone={stepTone(s.status)}>
                {tDynamic(locale, `m05.adm.lv.step.${s.status}`, s.status)}
              </Badge>
              {s.detail && (
                <span className="nz-muted">
                  {' '}
                  <span lang="en" dir="ltr">
                    {s.detail}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Evidence ids recorded by runs (the gate evidence is listed apart). Ids only: the evidence itself lives in the evidence store. */
export function EvidenceIndex({ locale, runs }: { locale: Locale; runs: LvRun[] }) {
  const rows = runs.flatMap((r) => [
    ...r.evidenceIds.map((id) => ({ key: `${r.id}-e-${id}`, id, kind: 'run', run: r })),
    ...(r.gateEvidenceId ? [{ key: `${r.id}-g`, id: r.gateEvidenceId, kind: 'gate', run: r }] : []),
  ]);
  if (rows.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.adm.lv.noEvidence.title')}
        body={t(locale, 'm05.adm.lv.noEvidence.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm05.adm.lv.evidence')}
      rows={rows}
      rowKey={(r) => r.key}
      columns={[
        { key: 'id', header: t(locale, 'm05.adm.col.evidence'), render: (r) => <Ltr>{r.id}</Ltr> },
        {
          key: 'k',
          header: t(locale, 'field.kind'),
          icon: 'code',
          render: (r) =>
            t(locale, r.kind === 'gate' ? 'm05.adm.lv.evidence.gate' : 'm05.adm.lv.evidence.run'),
        },
        {
          key: 'j',
          header: t(locale, 'm05.adm.lv.col.job'),
          render: (r) => <Ltr>{r.run.jobId}</Ltr>,
        },
        {
          key: 'w',
          header: t(locale, 'field.when'),
          icon: 'calendar',
          render: (r) => formatDateTime(r.run.createdAt, locale),
        },
      ]}
    />
  );
}
