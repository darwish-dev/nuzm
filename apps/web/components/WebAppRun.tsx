'use client';
import { useEffect, useRef, useState } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Icon, Ltr } from '@nuzm/ui';
import {
  approvalsOfRun,
  budgetWarns,
  nodeTone,
  nodeViews,
  progressPct,
  runBudgetMeters,
  type NodeView,
} from '../lib/appworkspace';
import { credits, isRunActive, num, type Run, failureReasonKey } from '../lib/builder';
import { bapi, useBuilderCall, useRunStream } from '../lib/builder-client';
import { runFailure } from '../lib/mobile';
import { useRunSafetyPoll } from '../lib/run-poll';
import { timelineOf, type OpenTarget } from '../lib/webapp-events';
import { appPhase } from '../lib/webapp-workspace';
import { PendingApprovals, type ApprovalLite } from './ApprovalPanels';
import { ProblemNote } from './BuilderBits';
import { ProducedList, RunTimeline, useProduced } from './WebAppTimeline';

export interface AppRunProgress {
  active: boolean;
  /** the agent being worked on, in the page language ("" when nothing is running) */
  label: string;
}

interface PendingRow extends ApprovalLite {
  runId?: string | null;
  status: string;
}

const Mark = ({ status }: { status: NodeView['status'] }) =>
  status === 'done' ? (
    <span className="bld-st-mark" data-state="done">
      <Icon name="check" size={14} />
    </span>
  ) : status === 'running' || status === 'waiting' ? (
    <span className="bld-st-mark" data-state="active" aria-hidden="true">
      <span className="bld-spinner" />
    </span>
  ) : status === 'failed' ? (
    <span className="bld-st-mark" data-state="failed">
      <Icon name="close" size={14} />
    </span>
  ) : (
    <span className="bld-st-mark" data-state="pending" aria-hidden="true" />
  );

/**
 * The live card of one web-app build (`kind=webapp`) in the chat thread: what the agent graph is doing (Requirements, Architecture and app spec, Database, Backend
 * and API, Frontend, Tests, Deployment plan, each with its status), a progress bar, the budget, the human approvals the run waits on decided right here (each one
 * bound to the exact action it shows, with the step-up the action needs), the reasons a run failed, and Cancel. It follows the run over the same stream as the
 * website workspace and re-reads the run row every few seconds besides, so it never stays on "Working". It only reports what the run's events say.
 */
export function WebAppRunCard({
  locale,
  runId,
  canWrite,
  canApprove,
  mfaFactorId,
  onRun,
  onProgress,
  onOpen,
}: {
  locale: Locale;
  runId: string;
  /** `ai:write`: cancel the run */
  canWrite: boolean;
  /** `ai:approve`: decide the approvals of the run */
  canApprove: boolean;
  mfaFactorId: string | null;
  /** called with the run row whenever its STATE changes (the workspace reloads the project when a run finishes) */
  onRun?: (run: Run) => void;
  onProgress?: (p: AppRunProgress) => void;
  /** open a panel of the workspace (a link in the timeline or in "what was produced") */
  onOpen?: (target: OpenTarget) => void;
}) {
  const stream = useRunStream(runId);
  const call = useBuilderCall();
  const run = stream.run;
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [tick, setTick] = useState(0);
  const [showEvents, setShowEvents] = useState<boolean | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const known = useRunSafetyPoll(runId, run, stream.setRun, (r) => onRunRef.current?.(r));

  useEffect(() => {
    if (stream.changed) {
      known(stream.changed.state);
      onRunRef.current?.(stream.changed);
    }
  }, [stream.changed]);

  const active = run ? isRunActive(run.state) : false;
  const waiting = run?.state === 'waiting_approval';
  const phase = run ? appPhase(run.state) : 'queued';
  const nodes = run ? nodeViews(stream.events, run.artifacts, run.state) : [];
  const current = nodes.find((n) => n.status === 'running' || n.status === 'failed');
  const label = current ? tDynamic(locale, `m10a.agent.${current.id}`, current.id) : '';

  // the approvals this run waits on: read while it waits (a decision resumes it)
  useEffect(() => {
    if (!waiting) {
      setPending([]);
      return;
    }
    let stop = false;
    const load = async () => {
      const r = await bapi.get<{ items: PendingRow[] }>('/v1/ai/approvals', {
        query: { status: 'pending' },
      });
      if (!stop && r.response.ok && r.data) setPending(approvalsOfRun(r.data.items, runId));
    };
    void load();
    const h = setInterval(() => void load(), 4000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [runId, waiting, tick]);
  // after the decision the run is queued or running again: reopen the event stream
  const was = useRef(false);
  useEffect(() => {
    if (was.current && run && !waiting) stream.reconnect();
    was.current = waiting;
  }, [waiting]);

  useEffect(() => {
    onProgressRef.current?.({ active: active && !waiting, label });
  }, [active, waiting, label]);

  const produced = useProduced(run, stream.events);

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

  const title = t(locale, `mws.web.run.title.${phase}` as MessageKey);
  const failure = run.state === 'failed' ? runFailure(run.error) : null;
  const pct = run.state === 'succeeded' ? 100 : progressPct(nodes);
  const meters = runBudgetMeters(run);
  const warn = budgetWarns(meters, stream.events);
  const working = active && !waiting;
  const events = showEvents ?? (active || run.state === 'failed' || stream.events.length <= 12);
  const timelineCount = timelineOf(stream.events).length;
  return (
    <section
      className="bld-run mws-run"
      data-state={run.state}
      data-phase={phase}
      aria-label={t(locale, 'mws.web.run.label')}
    >
      <p className="nz-sr" role="status" aria-live="polite" aria-atomic="true">
        {title} {label}
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
            {label && working ? label : t(locale, `mws.web.run.sub.${phase}` as MessageKey)}
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
      <ol className="bld-steps" aria-label={t(locale, 'm10a.run.agents')}>
        {nodes.map((n) => (
          <li
            key={n.id}
            data-node={n.id}
            data-status={n.status}
            data-state={
              n.status === 'running' || n.status === 'waiting'
                ? 'active'
                : n.status === 'pending'
                  ? 'pending'
                  : n.status
            }
          >
            <Mark status={n.status} />
            <span>{tDynamic(locale, `m10a.agent.${n.id}`, n.id)}</span>
            <span className="bld-st-detail">
              <Badge tone={nodeTone(n.status)}>{t(locale, `m10a.node.${n.status}`)}</Badge>
              {n.attempt > 1 && ` ${t(locale, 'm10a.run.attempt', { n: n.attempt })}`}
            </span>
          </li>
        ))}
      </ol>
      {failure && (
        <div className="mws-failed" role="alert">
          <Banner tone="danger">
            {t(locale, 'm10a.run.failed', { code: failure.code ?? '—' })}
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
                    {/* a known code is explained in the person's language; otherwise the server's own words */}
                    <bdi dir="auto">
                      {failureReasonKey(failure.code)
                        ? t(locale, failureReasonKey(failure.code)!)
                        : failure.message}
                    </bdi>
                  </li>
                )}
              </ul>
            </div>
          )}
          <p className="nz-muted">{t(locale, 'mws.web.run.retryHint')}</p>
        </div>
      )}
      {run.state === 'budget_exceeded' && (
        <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
      )}
      {run.state === 'cancelled' && (
        <Banner tone="warn">{t(locale, 'bld.run.cancelledNote')}</Banner>
      )}
      {warn && <Banner tone="warn">{t(locale, 'm10.run.budgetWarn')}</Banner>}
      {waiting && (
        <section aria-labelledby="mws-web-wait-h">
          <h3 className="nz-h3" id="mws-web-wait-h">
            {t(locale, 'm10a.run.waiting')}
          </h3>
          {pending.length === 0 ? (
            <p role="status">{t(locale, 'state.loading')}</p>
          ) : (
            <PendingApprovals
              locale={locale}
              mfaFactorId={mfaFactorId}
              items={pending}
              canDecide={canApprove}
              runId={runId}
              onDecided={() => {
                setTick((n) => n + 1);
                stream.reconnect();
              }}
            />
          )}
          {!canApprove && <p className="nz-muted">{t(locale, 'm10a.run.needsApprover')}</p>}
        </section>
      )}
      <ProducedList locale={locale} items={produced} onOpen={onOpen} />
      <section className="wsp-act" aria-labelledby="wsp-act-h">
        <h3 className="wsp-act-h" id="wsp-act-h">
          <button
            type="button"
            aria-expanded={events}
            aria-controls="wsp-act-body"
            onClick={() => setShowEvents(!events)}
          >
            <Icon name="chevron" size={13} />
            {t(locale, 'wsp.ev.title')}
            <span className="wsp-act-count">{stream.events.length > 0 ? timelineCount : ''}</span>
          </button>
        </h3>
        {events && (
          <div id="wsp-act-body">
            <RunTimeline locale={locale} events={stream.events} live={working} onOpen={onOpen} />
          </div>
        )}
      </section>
      <dl className="mws-meters">
        {meters.map((m) => (
          <div key={m.key}>
            <dt>{t(locale, `m10a.meter.${m.key}`)}</dt>
            <dd>
              <Ltr>
                {m.used.toLocaleString('en-US')}
                {m.max ? ` / ${m.max.toLocaleString('en-US')}` : ''}
              </Ltr>
              {m.level !== 'ok' && (
                <>
                  {' '}
                  <Badge tone={m.level === 'exceeded' ? 'danger' : 'warn'}>
                    {t(locale, m.level === 'exceeded' ? 'm10.run.exceeded' : 'm10.run.warn80')}
                  </Badge>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <footer className="bld-run-foot">
        <span className="nz-muted">
          {t(locale, 'bld.run.cost', {
            credits: credits(run.usage.spentCredits),
            tokens: num(run.usage.tokensIn) + num(run.usage.tokensOut),
          })}
        </span>
        <span className="bld-run-actions">
          <a className="bld-link" href={`/builder/runs/${run.id}`}>
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
