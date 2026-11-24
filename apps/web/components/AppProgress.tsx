'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Ltr, Meter } from '@nuzm/ui';
import { safeText } from '../lib/appbuilder';
import {
  approvalsOfRun,
  budgetWarns,
  nodeTone,
  nodeViews,
  progressPct,
  runBudgetMeters,
} from '../lib/appworkspace';
import { credits, isRunActive, num, type Run, type RunEvent, type Session } from '../lib/builder';
import { bapi, newKey, useBuilderCall, useRunStream } from '../lib/builder-client';
import { ProblemNote, RunBadge, when } from './BuilderBits';

interface PendingRow {
  id: string;
  type: string;
  runId?: string | null;
  status: string;
  scopeHash: string;
  expiresAt: string;
}

/** The brief of a build run: the person's words are DATA (`input.brief.prompt`); nothing else of the page is ever sent as an instruction. */
const MAX_BRIEF = 8000;

/** One-line text of an agent event for the screen-reader live region (unknown event types fall back to their code). */
export function nodeEventLine(locale: Locale, e: RunEvent): string {
  const node = String(e.data.node ?? e.data.agent ?? '');
  const agent = node ? tDynamic(locale, `m10a.agent.${node}`, node) : '';
  return tDynamic(locale, `m10a.ev.${e.type}`, e.type, { agent });
}

/** "Build again" / first build: the prompt, the optional token cap, one new run of kind `webapp` on the project's own AI session. */
function StartBuild({
  locale,
  projectId,
  sessionId,
  onStarted,
  first,
}: {
  locale: Locale;
  projectId: string;
  sessionId: string | null;
  first: boolean;
  onStarted: (run: Run, session: string) => void;
}) {
  const call = useBuilderCall();
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState(false);
  const keys = useRef({ session: newKey(), run: newKey() });
  const session = useRef(sessionId);

  async function submit() {
    const text = prompt.trim();
    if (text.length < 1 || text.length > MAX_BRIEF) {
      setErr(true);
      return;
    }
    setErr(false);
    if (!session.current) {
      const ok = await call.run(
        () =>
          bapi.post<Session>('/v1/ai/sessions', {
            body: { title: text.slice(0, 80), projectId },
            idempotencyKey: keys.current.session,
          }),
        (s) => {
          session.current = s.id;
        },
      );
      if (!ok) return;
    }
    await call.run(
      () =>
        bapi.post<Run>('/v1/ai/runs', {
          body: {
            sessionId: session.current,
            kind: 'webapp',
            projectId,
            input: { brief: { prompt: text } },
          },
          idempotencyKey: keys.current.run,
        }),
      (r) => {
        keys.current.run = newKey();
        setPrompt('');
        onStarted(r, session.current!);
      },
      (p) => {
        if (p.status !== 599) keys.current.run = newKey();
      },
    );
  }

  return (
    <form
      className="nz-card"
      aria-labelledby="m10a-build-h"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h3 className="nz-h2" id="m10a-build-h">
        {t(locale, first ? 'm10a.build.first' : 'm10a.build.again')}
      </h3>
      <Field
        id="m10a-brief"
        label={t(locale, 'm10a.build.brief')}
        error={err ? t(locale, 'm10a.build.briefErr', { max: MAX_BRIEF }) : undefined}
      >
        {(x) => (
          <textarea
            {...x}
            className="nz-input"
            dir="auto"
            rows={4}
            maxLength={MAX_BRIEF}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (err) setErr(false);
            }}
            style={{ paddingBlock: 8, resize: 'vertical' }}
          />
        )}
      </Field>
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      <p>
        <Button type="submit" disabled={call.busy} aria-busy={call.busy}>
          {call.busy ? t(locale, 'state.loading') : t(locale, 'm10a.build.start')}
        </Button>
      </p>
    </form>
  );
}

/**
 * UI-M10-06 (web-app workspace overview): the agent graph of the latest build run with live per-agent status (run events over SSE, then the run row and the
 * artifacts it saved), the budget meters, the human approvals the run waits on (decided in the inbox, the decision is bound to the exact action) and Cancel.
 * Progress is announced in a polite live region; no state is conveyed by colour alone.
 */
export function AppRunProgress({
  locale,
  projectId,
  initialRun,
  sessionId,
  canRun,
  canApprove,
}: {
  locale: Locale;
  projectId: string;
  initialRun: Run | null;
  sessionId: string | null;
  canRun: boolean;
  canApprove: boolean;
}) {
  const [runId, setRunId] = useState<string | null>(initialRun?.id ?? null);
  const [session, setSession] = useState<string | null>(sessionId);
  const stream = useRunStream(runId);
  const cancel = useBuilderCall();
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [live, setLive] = useState('');
  const run = stream.run ?? (runId && initialRun?.id === runId ? initialRun : null);

  useEffect(() => {
    const last = [...stream.events]
      .reverse()
      .find((e) => !['checkpoint', 'segment_started', 'created', 'artifact'].includes(e.type));
    if (last) setLive(nodeEventLine(locale, last));
  }, [stream.events, locale]);

  // the approvals this run waits on: re-read while it waits (a decision in the inbox resumes it)
  const waiting = run?.state === 'waiting_approval';
  useEffect(() => {
    if (!runId || !waiting) {
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
  }, [runId, waiting]);
  // after the decision the run is `queued`/`running` again: reopen the event stream
  const prevWaiting = useRef(false);
  useEffect(() => {
    if (prevWaiting.current && run && !waiting) stream.reconnect();
    prevWaiting.current = waiting;
  }, [waiting]);

  if (!runId || !run) {
    if (runId)
      return (
        <p role="status" aria-busy="true">
          {t(locale, 'state.loading')}
        </p>
      );
    return (
      <>
        <EmptyState
          title={t(locale, 'm10a.run.none.title')}
          body={t(locale, canRun ? 'm10a.run.none.body' : 'm10a.run.none.noPermission')}
        />
        {canRun && (
          <StartBuild
            locale={locale}
            projectId={projectId}
            sessionId={session}
            first
            onStarted={(r, s) => {
              setSession(s);
              setRunId(r.id);
            }}
          />
        )}
      </>
    );
  }

  const nodes = nodeViews(stream.events, run.artifacts, run.state);
  const pct = progressPct(nodes);
  const meters = runBudgetMeters(run);
  const warn = budgetWarns(meters, stream.events);
  const errCode =
    run.error && typeof run.error === 'object'
      ? safeText((run.error as { code?: unknown }).code, 60)
      : '';
  const active = isRunActive(run.state);

  return (
    <div>
      <p className="nz-sr" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </p>
      <section className="nz-card" aria-labelledby="m10a-run-h">
        <h2 className="nz-h2" id="m10a-run-h">
          {t(locale, 'm10a.run.title')}
        </h2>
        <p className="nz-row">
          <RunBadge locale={locale} state={run.state} />
          <Badge>{tDynamic(locale, `bld.run.kind.${run.kind}`, run.kind)}</Badge>
          <span className="nz-muted">{when(run.createdAt, locale)}</span>
          <a href={`/builder/runs/${run.id}`}>{t(locale, 'bld.run.details')}</a>
        </p>
        {run.state === 'succeeded' && (
          <p role="status">
            <Badge tone="success">{t(locale, 'm10a.run.succeeded')}</Badge>
          </p>
        )}
        {run.state === 'failed' && (
          <Banner tone="danger">{t(locale, 'm10a.run.failed', { code: errCode || '—' })}</Banner>
        )}
        {run.state === 'budget_exceeded' && (
          <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
        )}
        {run.state === 'cancelled' && (
          <Banner tone="warn">{t(locale, 'bld.run.cancelledNote')}</Banner>
        )}
        {(run.state === 'queued' || run.state === 'running') && (
          <p role="status" aria-busy="true">
            {t(locale, run.state === 'queued' ? 'bld.run.queued' : 'm10a.run.working')}
            {stream.status === 'reconnecting' ? ` ${t(locale, 'bld.run.reconnecting')}` : ''}
          </p>
        )}

        <h3 className="nz-h3">{t(locale, 'm10a.run.agents')}</h3>
        <Meter label={t(locale, 'm10a.run.progress')} percent={pct} />
        <p className="nz-muted">
          <Ltr>{pct}%</Ltr>
        </p>
        <ol className="bld-list" aria-label={t(locale, 'm10a.run.agents')}>
          {nodes.map((n) => (
            <li key={n.id} data-node={n.id} data-status={n.status}>
              <strong>{tDynamic(locale, `m10a.agent.${n.id}`, n.id)}</strong>{' '}
              <Badge tone={nodeTone(n.status)}>{t(locale, `m10a.node.${n.status}`)}</Badge>
              {n.attempt > 1 && (
                <span className="nz-muted"> {t(locale, 'm10a.run.attempt', { n: n.attempt })}</span>
              )}
              {n.tokens > 0 && (
                <span className="nz-muted">
                  {' '}
                  <Ltr>{n.tokens.toLocaleString('en-US')}</Ltr> {t(locale, 'm10a.run.tokens')}
                </span>
              )}
            </li>
          ))}
        </ol>

        <h3 className="nz-h3">{t(locale, 'm10.run.budget')}</h3>
        {warn && <Banner tone="warn">{t(locale, 'm10.run.budgetWarn')}</Banner>}
        <dl>
          {meters.map((m) => (
            <div key={m.key}>
              <dt>
                {t(locale, `m10a.meter.${m.key}`)}{' '}
                {m.level !== 'ok' && (
                  <Badge tone={m.level === 'exceeded' ? 'danger' : 'warn'}>
                    {t(locale, m.level === 'exceeded' ? 'm10.run.exceeded' : 'm10.run.warn80')}
                  </Badge>
                )}
              </dt>
              <dd>
                {m.max ? <Meter label={t(locale, `m10a.meter.${m.key}`)} percent={m.pct} /> : null}
                <Ltr>
                  {m.used.toLocaleString('en-US')}
                  {m.max ? ` / ${m.max.toLocaleString('en-US')}` : ''}
                </Ltr>
                {m.max ? <span className="nz-muted"> ({m.pct}%)</span> : null}
              </dd>
            </div>
          ))}
        </dl>

        {waiting && (
          <section aria-labelledby="m10a-wait-h">
            <h3 className="nz-h3" id="m10a-wait-h">
              {t(locale, 'm10a.run.waiting')}
            </h3>
            {pending.length === 0 ? (
              <p role="status">{t(locale, 'state.loading')}</p>
            ) : (
              <ul className="bld-list">
                {pending.map((a) => (
                  <li key={a.id}>
                    <Badge tone="warn">{tDynamic(locale, `m10.apr.type.${a.type}`, a.type)}</Badge>{' '}
                    <span className="nz-muted">
                      {t(locale, 'bld.approval.expires', {
                        when: formatDateTime(a.expiresAt, locale),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p>
              <a className="nz-btn" data-variant="primary" href={`/approvals`}>
                {t(locale, canApprove ? 'm10a.run.decide' : 'm10a.run.review')}
              </a>
            </p>
            {!canApprove && <p className="nz-muted">{t(locale, 'm10a.run.needsApprover')}</p>}
          </section>
        )}

        {cancel.problem && <ProblemNote locale={locale} problem={cancel.problem} />}
        {active && canRun && (
          <Button
            variant="secondary"
            disabled={cancel.busy}
            onClick={() =>
              void cancel.run(
                () => bapi.post<{ state: string }>(`/v1/ai/runs/${run.id}/cancellation`),
                () => stream.reconnect(),
              )
            }
          >
            {t(locale, 'bld.run.cancel')}
          </Button>
        )}
        <p className="nz-muted">
          {t(locale, 'bld.run.cost', {
            credits: credits(run.usage.spentCredits),
            tokens: num(run.usage.tokensIn) + num(run.usage.tokensOut),
          })}
        </p>
      </section>

      {!active && canRun && (
        <StartBuild
          locale={locale}
          projectId={projectId}
          sessionId={session}
          first={false}
          onStarted={(r, s) => {
            setSession(s);
            setRunId(r.id);
          }}
        />
      )}
    </div>
  );
}
