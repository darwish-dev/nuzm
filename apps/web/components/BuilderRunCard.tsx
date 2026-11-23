'use client';
import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Icon } from '@nuzm/ui';
import {
  approvalView,
  credits,
  isAnnounced,
  isRunActive,
  num,
  runStages,
  type Run,
  type Stage,
} from '../lib/builder';
import { bapi, useBuilderCall, useRunStream } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';
import { ApprovalCard, eventLine } from './BuilderRun';

export interface RunProgress {
  active: boolean;
  /** the step being worked on, in the page language ("" when nothing is running) */
  label: string;
}

const StageMark = ({ state }: { state: Stage['state'] }) =>
  state === 'done' ? (
    <span className="bld-st-mark" data-state="done">
      <Icon name="check" size={14} />
    </span>
  ) : state === 'active' ? (
    <span className="bld-st-mark" data-state="active" aria-hidden="true">
      <span className="bld-spinner" />
    </span>
  ) : state === 'failed' ? (
    <span className="bld-st-mark" data-state="failed">
      <Icon name="close" size={14} />
    </span>
  ) : (
    <span className="bld-st-mark" data-state="pending" aria-hidden="true" />
  );

/**
 * The live card of one AI run, shown inside the chat thread: a title that says what is happening, a progress bar and a short list of steps with a loader on the
 * one being worked on, the plan awaiting approval (Approve / Reject) and the cost. The full event history is one click away. It only reports what the run's
 * events say (see `runStages`). Progress is announced in a polite live region.
 */
export function RunCard({
  locale,
  runId,
  canWrite,
  onRun,
  onProgress,
}: {
  locale: Locale;
  runId: string;
  canWrite: boolean;
  /** called with the run row whenever its STATE changes (the workspace reloads the site when a run finishes) */
  onRun?: (run: Run) => void;
  onProgress?: (p: RunProgress) => void;
}) {
  const stream = useRunStream(runId);
  const call = useBuilderCall();
  const [showHistory, setShowHistory] = useState(false);
  const pagesTotal = useRef<number | null>(null);
  const run = stream.run;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (stream.changed) onRunRef.current?.(stream.changed);
  }, [stream.changed]);

  if (run?.pendingApproval) {
    const total = approvalView(run.pendingApproval).pages.length;
    if (total > 0) pagesTotal.current = total;
  }
  const stages = run ? runStages(run.kind, run.state, stream.events, pagesTotal.current) : [];
  const active = run ? isRunActive(run.state) : false;
  const current = stages.find((x) => x.state === 'active' || x.state === 'failed');
  const label = current
    ? `${t(locale, `bld.stage.${current.id}` as 'bld.stage.requirements')}${current.detail ? ` ${current.detail}` : ''}`
    : '';

  useEffect(() => {
    onProgressRef.current?.({ active: active && run?.state !== 'waiting_approval', label });
  }, [active, label, run?.state]);

  const cancel = () =>
    void call.run(
      () => bapi.post<{ state: string }>(`/v1/ai/runs/${runId}/cancellation`),
      () => stream.reconnect(),
    );

  if (!run)
    return (
      <div className="bld-run" data-state="loading" role="status" aria-busy="true">
        <span className="bld-spinner" /> {t(locale, 'state.loading')}
      </div>
    );

  const errCode =
    run.error && typeof run.error === 'object'
      ? ((run.error as { code?: unknown }).code as string | undefined)
      : undefined;
  const done = stages.filter((x) => x.state === 'done').length;
  const pct =
    run.state === 'succeeded' ? 100 : Math.round((done / Math.max(1, stages.length)) * 100);
  // a denied change finishes the run as succeeded with `rejected: true` (nothing was applied): the card must not say the site was updated
  const rejected =
    run.state === 'succeeded' &&
    typeof run.result === 'object' &&
    run.result !== null &&
    (run.result as { rejected?: unknown }).rejected === true;
  const title =
    run.state === 'waiting_approval'
      ? t(locale, 'bld.card.waiting')
      : run.state === 'succeeded'
        ? rejected
          ? t(locale, 'bld.card.rejected')
          : t(locale, 'bld.card.done')
        : run.state === 'failed'
          ? t(locale, 'bld.card.failed')
          : run.state === 'cancelled'
            ? t(locale, 'bld.card.cancelled')
            : run.state === 'budget_exceeded'
              ? t(locale, 'bld.card.budget')
              : t(locale, 'bld.card.working');
  const history = stream.events.filter((e) => isAnnounced(e.type));
  return (
    <section className="bld-run" data-state={run.state} aria-label={t(locale, 'bld.run.title')}>
      <p className="nz-sr" role="status" aria-live="polite" aria-atomic="true">
        {title} {label}
      </p>
      <header className="bld-run-head">
        {active && run.state !== 'waiting_approval' ? (
          <span className="bld-orbit" aria-hidden="true" />
        ) : (
          <span className="bld-run-icon" data-state={run.state} aria-hidden="true">
            <Icon
              name={
                run.state === 'succeeded'
                  ? 'check'
                  : run.state === 'waiting_approval'
                    ? 'sparkle'
                    : 'close'
              }
              size={16}
            />
          </span>
        )}
        <div>
          <strong>{title}</strong>
          {label && active && <span className="bld-run-sub">{label}</span>}
          {stream.status === 'reconnecting' && (
            <span className="bld-run-sub">{t(locale, 'bld.run.reconnecting')}</span>
          )}
        </div>
      </header>
      <div
        className="bld-bar"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        data-busy={active && run.state !== 'waiting_approval' ? 'true' : undefined}
      >
        <span style={{ inlineSize: `${pct}%` }} />
      </div>
      <ol className="bld-steps" aria-label={t(locale, 'bld.run.events')}>
        {stages.map((x) => (
          <li key={x.id} data-state={x.state}>
            <StageMark state={x.state} />
            <span>{t(locale, `bld.stage.${x.id}` as 'bld.stage.requirements')}</span>
            {x.detail && <span className="bld-st-detail">{x.detail}</span>}
          </li>
        ))}
      </ol>
      {run.state === 'failed' && (
        <Banner tone="danger">{t(locale, 'bld.run.failedNote', { code: errCode ?? '—' })}</Banner>
      )}
      {run.state === 'budget_exceeded' && (
        <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
      )}
      {run.state === 'waiting_approval' && run.pendingApproval && (
        <ApprovalCard
          locale={locale}
          runId={run.id}
          approval={run.pendingApproval}
          canDecide={canWrite}
          onDecided={(r) => {
            stream.setRun(r);
            stream.reconnect();
          }}
        />
      )}
      <footer className="bld-run-foot">
        <span className="nz-muted">
          {t(locale, 'bld.run.cost', {
            credits: credits(run.usage.spentCredits),
            tokens: num(run.usage.tokensIn) + num(run.usage.tokensOut),
          })}
        </span>
        <span className="bld-run-actions">
          <button type="button" className="bld-link" onClick={() => setShowHistory((v) => !v)}>
            {t(locale, showHistory ? 'bld.card.hideHistory' : 'bld.card.showHistory')}
          </button>
          <a className="bld-link" href={`/${locale}/builder/runs/${run.id}`}>
            {t(locale, 'bld.run.details')}
          </a>
          {active && canWrite && (
            <button type="button" className="bld-link" disabled={call.busy} onClick={cancel}>
              {t(locale, 'bld.run.cancel')}
            </button>
          )}
        </span>
      </footer>
      {showHistory && (
        <ol className="bld-history" aria-label={t(locale, 'bld.card.history')}>
          {history.map((e) => (
            <li key={e.seq}>
              <span className="nz-muted">{when(e.at, locale)}</span> {eventLine(locale, e)}
            </li>
          ))}
        </ol>
      )}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
    </section>
  );
}
