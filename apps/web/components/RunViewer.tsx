'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, Ltr } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { isLiveRun, prettyJson, runTone, settle, type Run } from '../lib/builder';
import { newKey } from '../lib/data';
import { PendingApprovals, type ApprovalLite } from './ApprovalPanels';
import { BudgetMeters, Code, Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { ConfirmDialog, Note } from './DataUi';

export const POLL_MS = 3000;

type Step = Run['steps'][number];

/** One step of the timeline: agent, status, attempt, tokens and cost; its tool calls are REDACTED summaries (the arguments are masked by the API and again here). */
export function RunStep({ locale, step }: { locale: Locale; step: Step }) {
  const calls = step.toolCalls ?? [];
  const tokens = (step.tokensIn ?? 0) + (step.tokensOut ?? 0);
  return (
    <li>
      <Card aria-label={`${step.agent ?? step.node ?? ''} ${step.seq ?? ''}`}>
        <div className="nz-row">
          <strong>
            {step.seq !== undefined ? `${step.seq}. ` : ''}
            {step.agent ?? step.node ?? '—'}
          </strong>
          <Badge
            tone={
              step.status === 'succeeded'
                ? 'success'
                : step.status === 'failed'
                  ? 'danger'
                  : step.status === 'running'
                    ? 'warn'
                    : undefined
            }
          >
            <Word locale={locale} prefix="m10.step.status" value={step.status ?? 'unknown'} />
          </Badge>
        </div>
        <dl>
          <dt>{t(locale, 'm10.step.attempt')}</dt>
          <dd>
            <Ltr>{String(step.attempt ?? 1)}</Ltr>
          </dd>
          <dt>{t(locale, 'm10.step.tokens')}</dt>
          <dd>
            <Ltr>{`${step.tokensIn ?? 0} + ${step.tokensOut ?? 0} = ${tokens}`}</Ltr>
          </dd>
          <dt>{t(locale, 'm10.step.cost')}</dt>
          <dd>
            <Ltr>{formatMinor(String(step.costMinor ?? 0), 'SAR', locale)}</Ltr>
          </dd>
          {step.errorCode && (
            <>
              <dt>{t(locale, 'm10.step.error')}</dt>
              <dd>
                <Ltr>{step.errorCode}</Ltr>
              </dd>
            </>
          )}
        </dl>
        {calls.length > 0 && (
          <details>
            <summary>{t(locale, 'm10.step.toolCalls', { n: calls.length })}</summary>
            <p className="nz-muted">{t(locale, 'm10.step.redacted')}</p>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {calls.map((c, i) => (
                <li key={i}>
                  <p>
                    <Ltr>{c.tool ?? '—'}</Ltr>{' '}
                    {c.status && <Word locale={locale} prefix="m10.step.status" value={c.status} />}
                    {typeof c.durationMs === 'number' && (
                      <>
                        {' '}
                        <Ltr>{`${c.durationMs} ms`}</Ltr>
                      </>
                    )}
                  </p>
                  {c.args && Object.keys(c.args).length > 0 && (
                    <Code label={t(locale, 'm10.step.args')}>{prettyJson(c.args, 1500)}</Code>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </li>
  );
}

/**
 * UI-M10-06: the agent run viewer. The run is polled every few seconds while it is queued, running or waiting for approval; the budget meter warns from 80 %;
 * pending approvals show the exact action and are decided here; cancelling stops the run at its next checkpoint.
 */
export function RunViewer({
  locale,
  projectId,
  initial,
  canApprove,
  canRun,
  mfaFactorId,
  pollMs = POLL_MS,
}: {
  locale: Locale;
  projectId: string;
  initial: Run;
  canApprove: boolean;
  canRun: boolean;
  mfaFactorId: string | null;
  pollMs?: number;
}) {
  const call = useBuilderCall(locale, mfaFactorId);
  const [run, setRun] = useState<Run>(initial);
  const [offline, setOffline] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelKey, setCancelKey] = useState(newKey());
  const [announce, setAnnounce] = useState('');
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  const last = useRef(initial.state);

  async function refresh() {
    const r = await settle(() =>
      browserApi().GET('/v1/ai/runs/{id}', { params: { path: { id: initial.id } } }),
    );
    if (!alive.current) return;
    if (r.response.ok && r.data) {
      setOffline(false);
      const next = r.data as Run;
      setRun(next);
      if (next.state !== last.current) {
        last.current = next.state;
        setAnnounce(
          t(locale, 'm10.run.stateChanged', {
            state: tDynamic(locale, `m10.run.state.${next.state}`, next.state),
          }),
        );
      }
    } else setOffline(true);
    setTick((n) => n + 1);
  }

  useEffect(() => {
    alive.current = true;
    if (!isLiveRun(run.state)) return;
    const id = setTimeout(() => void refresh(), pollMs);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
    // the effect re-arms after every poll attempt (`tick`, also when it failed) and stops once the state is final
  }, [run.state, tick, pollMs]);

  function cancel() {
    void call.run(
      () =>
        browserApi().POST('/v1/ai/runs/{id}/cancellation', {
          params: { path: { id: run.id }, header: { 'Idempotency-Key': cancelKey } },
        }),
      (r) => {
        setConfirmCancel(false);
        setCancelKey(newKey());
        setRun(r as Run);
        call.setNotice({ tone: 'ok', text: t(locale, 'm10.run.cancelled') });
      },
      (f) => {
        if (f.problem.status === 409) {
          setConfirmCancel(false);
          call.setNotice({ tone: 'error', text: t(locale, 'm10.run.cancelTerminal') });
          void refresh();
          return true;
        }
      },
    );
  }

  const pending: ApprovalLite[] = (run.pendingApprovals ?? [])
    .filter((a) => a.id && a.scopeHash)
    .map((a) => ({ id: a.id!, type: a.type, scopeHash: a.scopeHash!, expiresAt: a.expiresAt }));

  return (
    <>
      <div role="status" aria-live="polite" className="nz-sr">
        {announce}
      </div>
      {offline && <Banner tone="warn">{t(locale, 'm10.run.offline')}</Banner>}
      <Card aria-label={t(locale, 'm10.run.summary')}>
        <div className="nz-row">
          <Badge tone={runTone(run.state)}>
            <Word locale={locale} prefix="m10.run.state" value={run.state} />
          </Badge>
          {isLiveRun(run.state) && (
            <span className="nz-muted">
              {t(locale, 'm10.run.polling', { s: Math.round(pollMs / 1000) })}
            </span>
          )}
        </div>
        <dl>
          <dt>{t(locale, 'field.kind')}</dt>
          <dd>
            <Ltr>{run.kind}</Ltr>
          </dd>
          {run.reason && (
            <>
              <dt>{t(locale, 'field.reason')}</dt>
              <dd>
                <Word locale={locale} prefix="m10.run.reason" value={run.reason} />
              </dd>
            </>
          )}
          {run.dataRegion && (
            <>
              <dt>{t(locale, 'field.region')}</dt>
              <dd>{run.dataRegion}</dd>
            </>
          )}
          {run.createdAt && (
            <>
              <dt>{t(locale, 'field.created')}</dt>
              <dd>{formatDateTime(run.createdAt, locale)}</dd>
            </>
          )}
        </dl>
        {run.state === 'budget_exceeded' && (
          <Banner tone="danger">{t(locale, 'm10.run.budgetExceeded')}</Banner>
        )}
        {run.state === 'succeeded' && (
          <p>
            <a href={`/${locale}/builder/projects/${projectId}`}>
              {t(locale, 'm10.run.openProject')}
            </a>
          </p>
        )}
        {canRun && isLiveRun(run.state) && (
          <>
            <Button variant="danger" disabled={call.busy} onClick={() => setConfirmCancel(true)}>
              {t(locale, 'm10.run.cancel')}
            </Button>
            <ConfirmDialog
              open={confirmCancel}
              title={t(locale, 'm10.run.cancelTitle')}
              onClose={() => setConfirmCancel(false)}
            >
              <p>{t(locale, 'm10.run.cancelBody')}</p>
              <div className="nz-row">
                <Button variant="danger" disabled={call.busy} onClick={cancel}>
                  {t(locale, 'm10.run.cancelConfirm')}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
                  {t(locale, 'm10.run.keep')}
                </Button>
              </div>
            </ConfirmDialog>
          </>
        )}
        <Note n={call.notice} />
      </Card>
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm10.run.budget')}
      </h2>
      <Card aria-label={t(locale, 'm10.run.budget')}>
        <BudgetMeters locale={locale} run={run} />
      </Card>
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm10.run.approvals')}
      </h2>
      <PendingApprovals
        locale={locale}
        mfaFactorId={mfaFactorId}
        items={pending}
        canDecide={canApprove}
        runId={run.id}
        onDecided={() => void refresh()}
      />
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm10.run.steps')}
      </h2>
      {run.steps.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm10.run.noSteps')}</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
          {run.steps.map((s, i) => (
            <RunStep key={s.seq ?? i} locale={locale} step={s} />
          ))}
        </ol>
      )}
      {call.panel}
    </>
  );
}
