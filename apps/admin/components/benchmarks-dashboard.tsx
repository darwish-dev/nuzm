import { formatDateTime, type Locale } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, Table } from '@nuzm/ui';
import {
  barText,
  evidenceTone,
  money,
  pct,
  permille,
  scorecardValue,
  type Overview,
  type ScorecardRow,
} from '../lib/benchmarks';
import { bt, type BenchKey } from '../lib/benchmarks-text';
import { BenchmarksActions } from './benchmarks-actions';
import { BenchmarksGovernanceForm } from './benchmarks-governance';

/**
 * Benchmark dashboard (S-AG5): dataset, PROPOSED/ACCEPTED thresholds, recorded runs with their evidence label, qualification states and the (unavailable) live runner. Offline evidence is
 * always labelled as such and never as real-model performance; states are text and badges, never colour alone. Arabic is the default locale (D-32) and numbers stay left-to-right.
 */
export function BenchmarksDashboard({
  locale,
  overview,
  canRecord,
  canApprove = false,
  scorecard = [],
}: {
  locale: Locale;
  overview: Overview;
  canRecord: boolean;
  /** may accept or reject thresholds (`admin:ai:approve`) */
  canApprove?: boolean;
  /** the scorecard of the latest stored run (empty when there is none) */
  scorecard?: ScorecardRow[];
}) {
  const k = (key: BenchKey) => bt(locale, key);
  if (!overview.enabled) return <EmptyState title={k('title')} body={k('disabled')} />;
  const th = overview.thresholds;
  return (
    <>
      <Banner tone="warn">{k('notice')}</Banner>

      {overview.dataset && (
        <section aria-labelledby="bench-dataset">
          <h2 className="nz-h2" id="bench-dataset">
            {k('dataset')}
          </h2>
          <p className="nz-muted">{k('datasetHelp')}</p>
          <p>
            {k('version')}: <Ltr>{overview.dataset.version}</Ltr> · {k('tasks')}:{' '}
            <Ltr>{overview.dataset.tasks}</Ltr> · {k('hash')}:{' '}
            <Ltr>{overview.dataset.hash.slice(0, 12)}</Ltr>
          </p>
          <Table
            caption={k('dataset')}
            rows={overview.dataset.categories}
            rowKey={(c) => c}
            columns={[
              { key: 'c', header: k('category'), render: (c) => <Ltr>{c}</Ltr> },
              {
                key: 'n',
                header: k('tasks'),
                render: (c) => <Ltr>{overview.dataset?.perCategory[c] ?? 0}</Ltr>,
              },
            ]}
          />
        </section>
      )}

      {th && (
        <section aria-labelledby="bench-thresholds">
          <h2 className="nz-h2" id="bench-thresholds">
            {k('thresholds')} <Ltr>({th.version})</Ltr>
          </h2>
          {th.status === 'ACCEPTED' ? (
            <p>
              <Badge tone="success">{bt(locale, 'yes')}</Badge>{' '}
              {bt(locale, 'thresholdsAccepted', {
                who: th.acceptedBy ?? '—',
                when: th.acceptedAt ? formatDateTime(th.acceptedAt, locale) : '—',
              })}
            </p>
          ) : (
            <Banner tone="warn">{k('thresholdsProposed')}</Banner>
          )}
          <section aria-labelledby="bench-gov-thresholds">
            <h3 className="nz-h3" id="bench-gov-thresholds">
              {k('governanceTitle')}
            </h3>
            <p className="nz-muted">{k('governanceHelp')}</p>
            <p>
              <Badge tone={th.governance.state === 'ACCEPTED' ? 'success' : 'warn'}>
                {bt(locale, `govState_${th.governance.state}` as BenchKey)}
              </Badge>{' '}
              {th.governance.proposedBy && (
                <>{bt(locale, 'govProposedBy', { who: th.governance.proposedBy })} </>
              )}
              {th.governance.decidedBy && (
                <>{bt(locale, 'govDecidedBy', { who: th.governance.decidedBy })} </>
              )}
              {th.governance.reason && (
                <>{bt(locale, 'govReason', { reason: th.governance.reason })}</>
              )}
            </p>
            <h4 className="nz-h3">{k('govReviews')}</h4>
            {th.governance.reviews.length === 0 ? (
              <p>{k('govNoReviews')}</p>
            ) : (
              <ul>
                {th.governance.reviews.map((r) => (
                  <li key={r.by}>
                    <Ltr>{r.by}</Ltr>: {bt(locale, `verdict_${r.verdict}` as BenchKey)} — {r.note}
                  </li>
                ))}
              </ul>
            )}
            <BenchmarksGovernanceForm
              locale={locale}
              version={th.version}
              state={th.governance.state}
              canManage={canRecord}
              canApprove={canApprove}
            />
          </section>
          <Table
            caption={k('thresholds')}
            rows={th.items}
            rowKey={(t) => t.id}
            columns={[
              { key: 'id', header: k('thresholdId'), render: (t) => <Ltr>{t.id}</Ltr> },
              { key: 'sc', header: k('scope'), render: (t) => <Ltr>{t.scope}</Ltr> },
              { key: 'm', header: k('metric'), render: (t) => <Ltr>{t.metric}</Ltr> },
              { key: 'b', header: k('bar'), render: (t) => <Ltr>{barText(t)}</Ltr> },
              { key: 'w', header: k('why'), render: (t) => t.why },
            ]}
          />
        </section>
      )}

      <section aria-labelledby="bench-runs">
        <h2 className="nz-h2" id="bench-runs">
          {k('runs')}
        </h2>
        {overview.runs.length === 0 ? (
          <EmptyState title={k('runsEmpty')} body={k('runsEmptyBody')} />
        ) : (
          <Table
            caption={k('runs')}
            rows={overview.runs}
            rowKey={(r) => r.id}
            columns={[
              { key: 'l', header: k('label'), render: (r) => <Ltr>{r.label}</Ltr> },
              {
                key: 'w',
                header: k('when'),
                render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
              },
              {
                key: 'e',
                header: k('evidence'),
                render: (r) => (
                  <Badge tone={evidenceTone(r.evidence)}>
                    {bt(locale, `evidenceLabel_${r.evidence}` as BenchKey)}
                  </Badge>
                ),
              },
              { key: 'v', header: k('version'), render: (r) => <Ltr>{r.datasetVersion}</Ltr> },
              {
                key: 'a',
                header: k('adapters'),
                render: (r) => <Ltr>{r.adapters.join(', ') || '—'}</Ltr>,
              },
              { key: 'p', header: k('passRate'), render: (r) => <Ltr>{pct(r.passRate)}</Ltr> },
              { key: 'q', header: k('quality'), render: (r) => <Ltr>{r.meanQuality}</Ltr> },
              {
                key: 's',
                header: k('security'),
                render: (r) => <Ltr>{r.meanSecurity ?? bt(locale, 'notApplicable')}</Ltr>,
              },
              { key: 'x', header: k('violations'), render: (r) => <Ltr>{r.modeViolations}</Ltr> },
            ]}
          />
        )}
        {canRecord && <BenchmarksActions locale={locale} />}
      </section>

      <section aria-labelledby="bench-score">
        <h2 className="nz-h2" id="bench-score">
          {k('scorecardTitle')}
        </h2>
        <p className="nz-muted">{k('scorecardHelp')}</p>
        {scorecard.length === 0 ? (
          <p>{k('scorecardEmpty')}</p>
        ) : (
          <Table
            caption={k('scorecardTitle')}
            rows={scorecard}
            rowKey={(r) => r.dimension}
            columns={[
              {
                key: 'd',
                header: k('dimension'),
                render: (r) => bt(locale, `dim_${r.dimension}` as BenchKey),
              },
              {
                key: 'v',
                header: k('value'),
                render: (r) => <Ltr>{scorecardValue(r, bt(locale, 'notMeasured'))}</Ltr>,
              },
              { key: 'n', header: k('tasks'), render: (r) => <Ltr>{r.tasks}</Ltr> },
              {
                key: 't',
                header: k('thresholdsJudging'),
                render: (r) => (
                  <>
                    {r.thresholds.map((x) => (
                      <span key={x.id}>
                        <Ltr>{x.id}</Ltr>{' '}
                        <Badge
                          tone={
                            x.status === 'PASS'
                              ? 'success'
                              : x.status === 'FAIL'
                                ? 'danger'
                                : 'warn'
                          }
                        >
                          {bt(
                            locale,
                            x.status === 'PASS'
                              ? 'statusPass'
                              : x.status === 'FAIL'
                                ? 'statusFail'
                                : 'statusNotMeasured',
                          )}
                        </Badge>{' '}
                      </span>
                    ))}
                  </>
                ),
              },
            ]}
          />
        )}
      </section>

      {overview.stages && (
        <section aria-labelledby="bench-stages">
          <h2 className="nz-h2" id="bench-stages">
            {k('stagesTitle')}
          </h2>
          <p className="nz-muted">{k('stagesHelp')}</p>
          <Banner tone="warn">
            {overview.stages.rateBasis.status === 'APPROVED_WITH_BUDGET'
              ? bt(locale, 'rateApproved', { source: overview.stages.rateBasis.source })
              : bt(locale, 'rateReference', {
                  model: overview.stages.rateBasis.model ?? '—',
                  source: overview.stages.rateBasis.source,
                })}
          </Banner>
          <Table
            caption={k('stagesTitle')}
            rows={overview.stages.plans}
            rowKey={(p) => p.stage}
            columns={[
              {
                key: 's',
                header: k('stage'),
                render: (p) => (
                  <>
                    {bt(locale, `stageName_${p.stage}` as BenchKey)}
                    <br />
                    <span className="nz-muted">
                      {bt(locale, `stagePurpose_${p.stage}` as BenchKey)}
                    </span>
                  </>
                ),
              },
              {
                key: 't',
                header: k('tasks'),
                render: (p) => <Ltr>{p.models > 1 ? `${p.tasks} × ${p.models}` : p.tasks}</Ltr>,
              },
              { key: 'r', header: k('runCount'), render: (p) => <Ltr>{p.runs}</Ltr> },
              {
                key: 'e',
                header: k('estimated'),
                render: (p) => <Ltr>{money(p.estimateCostMinor, p.currency)}</Ltr>,
              },
              {
                key: 'm',
                header: k('maximum'),
                render: (p) => <Ltr>{money(p.maxCostMinor, p.currency)}</Ltr>,
              },
              {
                key: 'd',
                header: k('duration'),
                render: (p) => (
                  <Ltr>
                    {bt(locale, 'durationValue', {
                      est: String(p.estimatedMinutes),
                      max: String(p.maximumMinutes),
                    })}
                  </Ltr>
                ),
              },
              {
                key: 'st',
                header: k('stageStatus'),
                render: () => <Badge tone="warn">{k('stageBlocked')}</Badge>,
              },
            ]}
          />
          <p className="nz-muted">
            {bt(locale, 'assumptionsNote', {
              usage: permille(overview.stages.usagePermille),
              input: permille(overview.stages.inputSharePermille),
            })}
          </p>
          {overview.stages.monthly && (
            <p>
              {bt(locale, 'monthly', {
                est: money(
                  overview.stages.monthly.estimateCostMinor,
                  overview.stages.monthly.currency,
                ),
                max: money(overview.stages.monthly.maxCostMinor, overview.stages.monthly.currency),
              })}
            </p>
          )}
          <h3 className="nz-h3">{k('prerequisites')}</h3>
          <ul>
            {(overview.stages.plans.find((p) => p.stage === 'E')?.prerequisites ?? []).map((q) => (
              <li key={q}>{bt(locale, `prereq_${q}` as BenchKey)}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="bench-qual">
        <h2 className="nz-h2" id="bench-qual">
          {k('qualification')}
        </h2>
        {overview.qualifications.length === 0 ? (
          <p>{k('qualificationEmpty')}</p>
        ) : (
          <Table
            caption={k('qualification')}
            rows={overview.qualifications}
            rowKey={(q) => q.id}
            columns={[
              { key: 'a', header: k('adapters'), render: (q) => <Ltr>{q.adapterId}</Ltr> },
              { key: 'm', header: k('model'), render: (q) => <Ltr>{q.model}</Ltr> },
              {
                key: 's',
                header: k('state'),
                render: (q) => (
                  <Badge tone={q.effectiveState === 'QUALIFIED' ? 'success' : 'warn'}>
                    <Ltr>{q.effectiveState}</Ltr>
                  </Badge>
                ),
              },
              { key: 'v', header: k('version'), render: (q) => <Ltr>{q.datasetVersion}</Ltr> },
            ]}
          />
        )}
      </section>

      <section aria-labelledby="bench-gov">
        <h2 className="nz-h2" id="bench-gov">
          {k('gate')}
        </h2>
        <ul>
          <li>
            {k('budget')}:{' '}
            {overview.budget ? (
              <Ltr>{`${overview.budget.ref} · ${overview.budget.maxCostMinor} ${overview.budget.currency} · ${overview.budget.maxTokens} / ${overview.budget.maxRequests}`}</Ltr>
            ) : (
              k('budgetNone')
            )}
          </li>
          <li>
            {k('reviewers')}:{' '}
            {overview.reviewers.length > 0
              ? overview.reviewers.map((r) => r.name).join('، ')
              : k('reviewersNone')}
          </li>
          <li>
            {k('securityReview')}:{' '}
            {overview.securityReview ? (
              <>
                <Ltr>{overview.securityReview.ref}</Ltr>{' '}
                <Badge tone={overview.securityReview.passed ? 'success' : 'warn'}>
                  {overview.securityReview.passed ? bt(locale, 'checkOk') : bt(locale, 'checkFail')}
                </Badge>
              </>
            ) : (
              k('securityNone')
            )}
          </li>
          <li>
            {k('live')}: {overview.liveAvailable ? bt(locale, 'yes') : k('liveUnavailable')}
          </li>
        </ul>
      </section>
    </>
  );
}
