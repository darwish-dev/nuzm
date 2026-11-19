'use client';
import { useEffect, useRef } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Icon, Ltr } from '@nuzm/ui';
import { credits, isRunActive, num, type Run } from '../lib/builder';
import { bapi, useBuilderCall, useRunStream } from '../lib/builder-client';
import { useRunSafetyPoll } from '../lib/run-poll';
import {
  biText,
  mobileApprovalView,
  mobilePhase,
  mobileRunStages,
  runFailure,
  type MobileStage,
} from '../lib/mobile';
import { ProblemNote } from './BuilderBits';
import { ApprovalCard } from './BuilderRun';

export interface MobileRunProgress {
  active: boolean;
  /** the phase of the run in words, in the page language ("" when nothing is happening) */
  label: string;
}

const Mark = ({ state }: { state: MobileStage['state'] }) =>
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

/** The design the person is asked to approve, as the screen shows it: name, package, screens with their kind, the tabs and the permissions. */
function DesignSummary({ locale, summary }: { locale: Locale; summary: unknown }) {
  const v = mobileApprovalView(summary);
  const lang = locale === 'ar' ? 'ar' : 'en';
  return (
    <div className="mws-design">
      {v.appName && (
        <p>
          <strong>
            <bdi dir="auto">{biText(v.appName, lang)}</bdi>
          </strong>
          {v.applicationId && (
            <>
              {' '}
              <Ltr>{v.applicationId}</Ltr>
            </>
          )}
        </p>
      )}
      {v.screens.length > 0 && (
        <ul className="bld-list" aria-label={t(locale, 'mws.approval.screens')}>
          {v.screens.map((s) => (
            <li key={s.id}>
              <bdi dir="auto">{biText(s.title, lang)}</bdi> ·{' '}
              {tDynamic(locale, `mobile.kind.${s.kind}`, s.kind)}
              {v.tabs.includes(s.id) ? ` · ${t(locale, 'mobile.preview.tab')}` : ''}
            </li>
          ))}
        </ul>
      )}
      {v.permissions.length > 0 && (
        <p className="nz-muted">
          {t(locale, 'mobile.preview.permissions')}:{' '}
          {v.permissions
            .map((p) => tDynamic(locale, `mobile.wizard.permission.${p}`, p))
            .join(' · ')}
        </p>
      )}
      <p className="nz-muted">{t(locale, 'mws.approval.note')}</p>
    </div>
  );
}

/**
 * The live card of one `mobile` run in the chat thread: what the run is doing (queued, designing, design ready and waiting for the person, generating the Flutter
 * project, done, failed with the reasons the service recorded), the steps, a progress bar, and the design to approve or decline inline. It follows the run over the
 * same stream as the website workspace and re-reads the run row every few seconds besides, so it never stays on "Running". It only reports what the run says.
 */
export function MobileRunCard({
  locale,
  runId,
  canWrite,
  onRun,
  onProgress,
}: {
  locale: Locale;
  runId: string;
  canWrite: boolean;
  /** called with the run row whenever its STATE changes (the workspace reloads the project when a run finishes and reads the design while it waits) */
  onRun?: (run: Run) => void;
  onProgress?: (p: MobileRunProgress) => void;
}) {
  const stream = useRunStream(runId);
  const call = useBuilderCall();
  const run = stream.run;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (stream.changed) {
      known(stream.changed.state);
      onRunRef.current?.(stream.changed);
    }
  }, [stream.changed]);

  const active = run ? isRunActive(run.state) : false;
  const waiting = run?.state === 'waiting_approval';
  const known = useRunSafetyPoll(runId, run, stream.setRun, (r) => onRunRef.current?.(r));
  const phase = run ? mobilePhase(run.state, stream.events) : 'queued';
  const stages = run ? mobileRunStages(run.state, stream.events, run.error) : [];
  const title = t(locale, `mws.run.title.${phase}` as MessageKey);
  useEffect(() => {
    onProgressRef.current?.({
      active: run ? active && !waiting : false,
      label: run ? title : '',
    });
  }, [active, waiting, title, run]);

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

  const failure = run.state === 'failed' ? runFailure(run.error) : null;
  const done = stages.filter((x) => x.state === 'done').length;
  const pct =
    run.state === 'succeeded' ? 100 : Math.round((done / Math.max(1, stages.length)) * 100);
  const working = active && !waiting;
  return (
    <section
      className="bld-run mws-run"
      data-state={run.state}
      data-phase={phase}
      aria-label={t(locale, 'mws.run.label')}
    >
      <p className="nz-sr" role="status" aria-live="polite" aria-atomic="true">
        {title}
      </p>
      <header className="bld-run-head">
        {working ? (
          <span className="bld-orbit" aria-hidden="true" />
        ) : (
          <span className="bld-run-icon" data-state={run.state} aria-hidden="true">
            <Icon
              name={run.state === 'succeeded' ? 'check' : waiting ? 'sparkle' : 'close'}
              size={16}
            />
          </span>
        )}
        <div>
          <strong>{title}</strong>
          <span className="bld-run-sub">
            {t(locale, `mws.run.sub.${phase}` as MessageKey)}
            {stream.status === 'reconnecting' && ` ${t(locale, 'bld.run.reconnecting')}`}
          </span>
        </div>
      </header>
      <div
        className="bld-bar"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        data-busy={working ? 'true' : undefined}
      >
        <span style={{ inlineSize: `${pct}%` }} />
      </div>
      <ol className="bld-steps" aria-label={t(locale, 'bld.run.events')}>
        {stages.map((x) => (
          <li key={x.id} data-state={x.state}>
            <Mark state={x.state} />
            <span>{t(locale, `mws.stage.${x.id}` as MessageKey)}</span>
          </li>
        ))}
      </ol>
      {failure && (
        <div className="mws-failed" role="alert">
          <Banner tone="danger">
            {t(locale, 'mws.run.failedNote', { code: failure.code ?? '—' })}
          </Banner>
          {(failure.message || failure.details.length > 0) && (
            <div className="mws-reasons">
              <p className="mws-reasons-h">{t(locale, 'mws.run.reasons')}</p>
              <ul dir="auto">
                {failure.details.length > 0 ? (
                  failure.details.map((d, i) => (
                    <li key={i}>
                      <bdi dir="auto">{d}</bdi>
                    </li>
                  ))
                ) : (
                  <li>
                    <bdi dir="auto">{failure.message}</bdi>
                  </li>
                )}
              </ul>
            </div>
          )}
          <p className="nz-muted">{t(locale, 'mws.run.retryHint')}</p>
        </div>
      )}
      {run.state === 'budget_exceeded' && (
        <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
      )}
      {run.state === 'cancelled' && (
        <Banner tone="warn">{t(locale, 'mws.run.cancelledNote')}</Banner>
      )}
      {run.state === 'succeeded' && (
        <p className="nz-muted">
          <Badge tone="success">{t(locale, 'mws.run.generatedBadge')}</Badge>{' '}
          {t(locale, 'mws.run.doneNote')}
        </p>
      )}
      {waiting && run.pendingApproval && (
        <ApprovalCard
          locale={locale}
          runId={run.id}
          approval={run.pendingApproval}
          canDecide={canWrite}
          title={t(locale, 'mws.approval.title')}
          body={<DesignSummary locale={locale} summary={run.pendingApproval.summary} />}
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
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
    </section>
  );
}
