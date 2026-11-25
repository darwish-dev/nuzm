'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Ltr } from '@nuzm/ui';
import {
  approvalView,
  credits,
  eventText,
  isAnnounced,
  isRunActive,
  num,
  type PendingApproval,
  type Run,
  type RunEvent,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall, useRunStream } from '../lib/builder-client';
import { DiffView, ProblemNote, RiskList, RunBadge, when } from './BuilderBits';

/** Text of one timeline entry in the page language; unknown event types are shown by their code (nothing is invented). */
export function eventLine(locale: Locale, e: RunEvent): string {
  const { key, params } = eventText(e);
  const task = String(params.task ?? '');
  return tDynamic(locale, key, e.type, {
    ...params,
    task: task ? tDynamic(locale, `bld.task.${task}`, task) : '',
    kind: params.kind
      ? tDynamic(locale, `bld.approval.kind.${params.kind}`, String(params.kind))
      : '',
  });
}

/** The pending approval of a run: what the AI proposes (plan or change set, with its diff and risks) and the Approve / Deny decision of a human member. */
export function ApprovalCard({
  locale,
  runId,
  approval,
  canDecide,
  onDecided,
  title,
  body,
}: {
  locale: Locale;
  runId: string;
  approval: PendingApproval;
  canDecide: boolean;
  onDecided: (run: Run) => void;
  /** replaces the heading (a mobile run's `plan` is the app design, not a website plan) */
  title?: string;
  /** replaces the website plan's page list, diff and risks with the screen's own view of what is proposed (the mobile design) */
  body?: ReactNode;
}) {
  const call = useBuilderCall();
  const view = approvalView(approval);
  const keys = useRef<Record<string, string>>({});
  const decide = (decision: 'approve' | 'deny') => {
    const k = `${approval.id}:${decision}`;
    keys.current[k] ??= newKey();
    void call.run(
      () =>
        bapi.post<Run>(`/v1/ai/runs/${runId}/approvals`, {
          body: { approvalId: approval.id, decision },
          idempotencyKey: keys.current[k],
        }),
      (r) => onDecided(r),
    );
  };
  return (
    <section className="nz-card" aria-labelledby={`bld-ap-${approval.id}`}>
      <h3 className="nz-h2" id={`bld-ap-${approval.id}`}>
        {title ??
          t(locale, 'bld.approval.title', {
            kind: tDynamic(locale, `bld.approval.kind.${approval.kind}`, approval.kind),
          })}
      </h3>
      <p className="nz-muted">
        {t(locale, 'bld.approval.expires', { when: formatDateTime(approval.expiresAt, locale) })}
      </p>
      {view.summary && (
        <p>
          <bdi dir="auto">{view.summary}</bdi>
        </p>
      )}
      {body}
      {!body && view.pages.length > 0 && (
        <ul className="bld-list" aria-label={t(locale, 'bld.approval.pages')}>
          {view.pages.map((p) => (
            <li key={p.pageId}>
              <Ltr>{p.slug}</Ltr> · {t(locale, 'bld.approval.sections', { count: p.sections })}
            </li>
          ))}
        </ul>
      )}
      {!body && view.diff && <DiffView locale={locale} diff={view.diff} />}
      {!body && <RiskList locale={locale} risks={view.risks} />}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {canDecide ? (
        <div className="nz-row">
          <Button disabled={call.busy} onClick={() => decide('approve')}>
            {t(locale, 'bld.approval.approve')}
          </Button>
          <Button variant="secondary" disabled={call.busy} onClick={() => decide('deny')}>
            {t(locale, 'bld.approval.deny')}
          </Button>
        </div>
      ) : (
        <p className="nz-muted">{t(locale, 'bld.approval.needsWriter')}</p>
      )}
    </section>
  );
}

/**
 * Timeline of one AI run (UI-M09-03, UI-M09-09): live events over SSE with the states generating, waiting approval, conflict, budget exceeded, cancelled,
 * failed and done; the pending approval with Approve / Deny; Cancel while it runs. Progress is announced in a polite live region.
 */
export function RunPanel({
  locale,
  runId,
  canWrite,
  onRun,
  compact,
}: {
  locale: Locale;
  runId: string;
  canWrite: boolean;
  /** called with the run row whenever its STATE changes (the workspace reloads the site when a run finishes) */
  onRun?: (run: Run) => void;
  compact?: boolean;
}) {
  const stream = useRunStream(runId);
  const call = useBuilderCall();
  const [live, setLive] = useState('');
  const run = stream.run;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (stream.changed) onRunRef.current?.(stream.changed);
  }, [stream.changed]);
  useEffect(() => {
    const last = [...stream.events].reverse().find((e) => isAnnounced(e.type));
    if (last) setLive(eventLine(locale, last));
  }, [stream.events, locale]);
  useEffect(() => {
    if (run)
      setLive(
        t(locale, 'bld.run.announce', {
          state: tDynamic(locale, `bld.run.state.${run.state}`, run.state),
        }),
      );
  }, [run?.state, locale]);

  const cancel = () =>
    void call.run(
      () => bapi.post<{ state: string }>(`/v1/ai/runs/${runId}/cancellation`),
      () => stream.reconnect(),
    );

  if (!run)
    return (
      <p role="status" aria-busy="true">
        {t(locale, 'state.loading')}
      </p>
    );
  const conflict = stream.events.some((e) => e.type === 'change_conflict');
  const errCode =
    run.error && typeof run.error === 'object'
      ? ((run.error as { code?: unknown }).code as string | undefined)
      : undefined;
  return (
    <div>
      <p className="nz-sr" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </p>
      <p className="nz-row">
        <RunBadge locale={locale} state={run.state} />
        <Badge>{tDynamic(locale, `bld.run.kind.${run.kind}`, run.kind)}</Badge>
        {run.step && (
          <span className="nz-muted">{tDynamic(locale, `bld.run.step.${run.step}`, run.step)}</span>
        )}
        {compact && <a href={`/builder/runs/${run.id}`}>{t(locale, 'bld.run.details')}</a>}
      </p>
      {run.state === 'budget_exceeded' && (
        <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
      )}
      {run.state === 'cancelled' && (
        <Banner tone="warn">{t(locale, 'bld.run.cancelledNote')}</Banner>
      )}
      {run.state === 'failed' && (
        <Banner tone="danger">{t(locale, 'bld.run.failedNote', { code: errCode ?? '—' })}</Banner>
      )}
      {conflict && <Banner tone="warn">{t(locale, 'bld.run.conflict')}</Banner>}
      {(run.state === 'queued' || run.state === 'running') && (
        <p role="status" aria-busy="true">
          {t(locale, run.state === 'queued' ? 'bld.run.queued' : 'bld.run.generating')}
          {stream.status === 'reconnecting' ? ` ${t(locale, 'bld.run.reconnecting')}` : ''}
        </p>
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
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {isRunActive(run.state) && canWrite && (
        <Button variant="secondary" disabled={call.busy} onClick={cancel}>
          {t(locale, 'bld.run.cancel')}
        </Button>
      )}
      <p className="nz-muted">
        {t(locale, 'bld.run.cost', {
          credits: credits(run.usage.spentCredits),
          tokens: num(run.usage.tokensIn) + num(run.usage.tokensOut),
        })}
      </p>
      {!compact || stream.events.length > 0 ? (
        <ol className="bld-list" aria-label={t(locale, 'bld.run.events')}>
          {stream.events
            .filter((e) => isAnnounced(e.type) || !compact)
            .map((e) => (
              <li key={e.seq}>
                <span className="nz-muted">{when(e.at, locale)}</span> {eventLine(locale, e)}
              </li>
            ))}
        </ol>
      ) : null}
    </div>
  );
}
