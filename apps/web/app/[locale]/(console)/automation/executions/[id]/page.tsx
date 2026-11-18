import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Card, Ltr, PageTitle } from '@nuzm/ui';
import { AutomationTabs } from '../../../../../../components/AutomationTabs';
import { RefreshButton } from '../../../../../../components/AutomationPanels';
import { JsonBlock } from '../../../../../../components/M11Ui';
import { DisabledAction } from '../../../../../../components/M11Parts';
import { Fact } from '../../../../../../components/DataParts';
import {
  FLAGS,
  durationMs,
  executionTone,
  groupAttempts,
  isUuid,
  prettyJson,
  type ExecutionDto,
} from '../../../../../../lib/m11';
import { actingHeader, actingOrgOf, gateM11, m11View } from '../../../../../../lib/m11-server';

const dur = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

function Block({ locale, label, value }: { locale: Locale; label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <details>
      <summary>{label}</summary>
      <JsonBlock label={`${label} (${t(locale, 'm11.exec.redacted')})`} value={prettyJson(value)} />
    </details>
  );
}

/**
 * UI-M11-03: the timeline of one execution: steps, attempts (with idempotency flag), redacted input/output/error, and dead letters. The replay route is SCR-M11-02 (not approved), so the replay
 * button is shown DISABLED with that note. Logs are redacted by the API before they are stored; the browser masks credential-looking keys again before showing them.
 */
export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'automation:read',
    title: 'm11.exec.title',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const acting = await actingOrgOf(s);
  const body = await m11View(
    locale,
    async () =>
      (await unwrap(
        s.api.GET('/v1/workflow-executions/{id}', {
          params: { path: { id }, header: actingHeader(acting) },
        }),
      )) as unknown as ExecutionDto,
    (e) => {
      const groups = groupAttempts(e.steps ?? []);
      return (
        <>
          <p className="nz-row">
            <Badge tone={executionTone(e.status)}>
              {tDynamic(locale, `m11.exec.status.${e.status}`, e.status)}
            </Badge>
            <RefreshButton locale={locale} />
          </p>
          {(e.status === 'queued' || e.status === 'running' || e.status === 'waiting') && (
            <Banner tone="warn">{t(locale, 'm11.exec.inProgress')}</Banner>
          )}
          <Card aria-label={t(locale, 'm11.exec.summary')}>
            <dl>
              <Fact label={t(locale, 'm11.exec.col.id')}>
                <Ltr>{e.id}</Ltr>
              </Fact>
              <Fact label={t(locale, 'm11.exec.workflow')}>
                <a href={`/${locale}/automation/workflows/${e.workflowId}/edit`}>
                  <Ltr>{e.workflowId}</Ltr>
                </a>
              </Fact>
              <Fact label={t(locale, 'm11.exec.col.trigger')}>
                {tDynamic(
                  locale,
                  `m11.wf.trigger.${e.trigger === 'platform_event' ? 'event' : e.trigger}`,
                  e.trigger,
                )}
              </Fact>
              <Fact label={t(locale, 'm11.exec.started')}>
                {e.startedAt ? formatDateTime(e.startedAt, locale) : '—'}
              </Fact>
              <Fact label={t(locale, 'm11.exec.finished')}>
                {e.finishedAt ? formatDateTime(e.finishedAt, locale) : '—'}
              </Fact>
              <Fact label={t(locale, 'm11.exec.duration')}>
                {dur(durationMs(e.startedAt, e.finishedAt))}
              </Fact>
              {e.operationId && (
                <Fact label={t(locale, 'm11.exec.operation')}>
                  <a href={`/${locale}/operations`}>
                    <Ltr>{e.operationId}</Ltr>
                  </a>
                </Fact>
              )}
            </dl>
            <Block locale={locale} label={t(locale, 'm11.exec.input')} value={e.input} />
            {e.error ? (
              <Block locale={locale} label={t(locale, 'm11.exec.error')} value={e.error} />
            ) : null}
          </Card>

          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm11.exec.timeline')}
          </h2>
          {groups.length === 0 ? (
            <p className="nz-muted">{t(locale, 'm11.exec.noSteps')}</p>
          ) : (
            <ol
              style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}
              aria-label={t(locale, 'm11.exec.timeline')}
            >
              {groups.map((grp) => (
                <li key={grp.key}>
                  <Card aria-label={grp.key}>
                    <h3 className="nz-h2">
                      <Ltr>{grp.key}</Ltr>{' '}
                      <Badge tone={executionTone(grp.attempts.at(-1)!.status)}>
                        {tDynamic(
                          locale,
                          `m11.exec.status.${grp.attempts.at(-1)!.status}`,
                          grp.attempts.at(-1)!.status,
                        )}
                      </Badge>
                      {grp.attempts.length > 1 && (
                        <span className="nz-muted">
                          {' '}
                          {t(locale, 'm11.exec.attempts', { n: grp.attempts.length })}
                        </span>
                      )}
                    </h3>
                    <ol style={{ margin: 0, paddingInlineStart: 20 }}>
                      {grp.attempts.map((a) => (
                        <li key={a.attempt} style={{ marginBlockEnd: 8 }}>
                          <span className="nz-row">
                            <strong>{t(locale, 'm11.exec.attempt', { n: a.attempt })}</strong>
                            <Badge tone={executionTone(a.status)}>
                              {tDynamic(locale, `m11.exec.status.${a.status}`, a.status)}
                            </Badge>
                            <Badge tone={a.idempotent ? 'success' : 'warn'}>
                              {t(
                                locale,
                                a.idempotent ? 'm11.exec.idempotent' : 'm11.exec.notIdempotent',
                              )}
                            </Badge>
                            <span className="nz-muted">
                              {a.startedAt ? formatDateTime(a.startedAt, locale) : '—'} ·{' '}
                              {dur(durationMs(a.startedAt, a.finishedAt))}
                            </span>
                          </span>
                          <Block
                            locale={locale}
                            label={t(locale, 'm11.exec.input')}
                            value={a.input}
                          />
                          <Block
                            locale={locale}
                            label={t(locale, 'm11.exec.output')}
                            value={a.output}
                          />
                          {a.error ? (
                            <Block
                              locale={locale}
                              label={t(locale, 'm11.exec.error')}
                              value={a.error}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </Card>
                </li>
              ))}
            </ol>
          )}

          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm11.exec.dlq')}
          </h2>
          {(e.deadLetters ?? []).length === 0 ? (
            <p className="nz-muted">{t(locale, 'm11.exec.dlqEmpty')}</p>
          ) : (
            <>
              <Banner tone="danger">
                {t(locale, 'm11.exec.dlqBanner', { n: e.deadLetters!.length })}
              </Banner>
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
                {e.deadLetters!.map((d) => (
                  <li key={d.id}>
                    <Card aria-label={d.stepKey}>
                      <p>
                        <Ltr>{d.stepKey}</Ltr>{' '}
                        <Badge tone={d.replayedAt ? 'success' : 'danger'}>
                          {t(locale, d.replayedAt ? 'm11.exec.dlqReplayed' : 'm11.exec.dlqWaiting')}
                        </Badge>
                      </p>
                      <p className="nz-muted">
                        <bdi dir="auto">{d.reason}</bdi>
                      </p>
                      <DisabledAction
                        id={`replay-${d.id}`}
                        label={t(locale, 'm11.exec.replay')}
                        reason={t(locale, 'm11.exec.replayBlocked')}
                      />
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.exec.title')}</PageTitle>
      <AutomationTabs locale={locale} current="workflows" />
      {body}
    </>
  );
}
