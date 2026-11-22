'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, EmptyState, Ltr, Meter } from '@nuzm/ui';
import { problemOf, problemKey } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import {
  argsLine,
  bytesLabel,
  callStatusKey,
  fallbackKey,
  isLive,
  isTimeline,
  LIMIT_NAMES,
  limitKey,
  limitPct,
  modeKey,
  phaseKey,
  stateKey,
  stepStatusKey,
  type Timeline,
  type TimelineStep,
} from '../lib/agent-timeline';

const POLL_MS = 4000;
/** A Latin unit inside Arabic text keeps its own direction (a bidi isolate), so "1.5 KB" never reads backwards. */
const iso = (v: string): string => `\u2066${v}\u2069`;

/**
 * The read-only execution timeline of a plan's run (S-AG3): the agent's plan, every step with its phase, the read-only tool calls of each (redacted arguments, outcome, size), the limits
 * used against their ceilings, a fallback to the single call and why, and the outcome. It only reads: there is no control here that starts, changes, approves or runs anything.
 * It never shows file contents. Loading, empty, error and forbidden states are explicit.
 */
export function AgentTimeline({ locale, planId }: { locale: Locale; planId: string }) {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<{ key: MessageKey; trace?: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await bapi.get<Timeline>(`/v1/builder/generation-plans/${planId}/timeline`);
    if (!mounted.current) return;
    setBusy(false);
    if (!r.response.ok || !isTimeline(r.data)) {
      const p = problemOf(r);
      setError({ key: problemKey(p), trace: p.traceId });
      return;
    }
    setError(null);
    setTl(r.data);
  }, [planId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // while the run is moving, the timeline follows it; once finished nothing is polled
  const live = isLive(tl);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [live, load]);

  return (
    <Card aria-labelledby="agt-h">
      <div className="knd-head">
        <div>
          <h2 className="nz-h2" id="agt-h">
            {t(locale, 'agt.title')}
          </h2>
          <p className="nz-muted">{t(locale, 'agt.intro')}</p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={busy}>
          {busy && tl ? t(locale, 'agt.refreshing') : t(locale, 'agt.refresh')}
        </Button>
      </div>
      <div data-testid="agt" aria-busy={busy} className="knd">
        {error && (
          <Banner tone="danger">
            <span role="alert">
              {t(locale, error.key)}
              {error.trace && (
                <>
                  {' '}
                  <Ltr>{error.trace}</Ltr>
                </>
              )}
            </span>{' '}
            <Button variant="secondary" onClick={() => void load()}>
              {t(locale, 'agt.retry')}
            </Button>
          </Banner>
        )}
        {!tl && busy && !error && (
          <p className="nz-muted" role="status">
            {t(locale, 'agt.loading')}
          </p>
        )}
        {tl && <Body locale={locale} tl={tl} />}
      </div>
    </Card>
  );
}

function Body({ locale, tl }: { locale: Locale; tl: Timeline }) {
  if (tl.mode === 'NONE' || !tl.runId)
    return <EmptyState title={t(locale, 'agt.none')} body={t(locale, 'agt.intro')} />;
  if (tl.mode === 'SINGLE_CALL')
    return (
      <>
        <Status locale={locale} tl={tl} />
        <p className="nz-muted">{t(locale, 'agt.single')}</p>
        <Outcome locale={locale} tl={tl} />
      </>
    );
  return (
    <>
      <Status locale={locale} tl={tl} />
      {tl.fellBack && (
        <Banner tone="warn">
          <span role="status" data-testid="agt-fallback">
            <strong>{t(locale, 'agt.fallback.title')}</strong> {t(locale, fallbackKey(tl.fellBack))}
          </span>
        </Banner>
      )}
      {tl.plan && (
        <section aria-labelledby="agt-plan-h" className="knd">
          <h3 className="nz-h3" id="agt-plan-h">
            {t(locale, 'agt.plan.title')}
          </h3>
          <p dir="auto" data-testid="agt-plan">
            {tl.plan}
          </p>
        </section>
      )}
      <Limits locale={locale} tl={tl} />
      <section aria-labelledby="agt-steps-h" className="knd">
        <h3 className="nz-h3" id="agt-steps-h">
          {t(locale, 'agt.steps.title')}
        </h3>
        <ol className="kni-list" data-testid="agt-steps">
          {tl.steps.map((s) => (
            <Step key={s.seq} locale={locale} s={s} />
          ))}
        </ol>
      </section>
      <Outcome locale={locale} tl={tl} />
    </>
  );
}

function Status({ locale, tl }: { locale: Locale; tl: Timeline }) {
  return (
    <p>
      <Badge>{t(locale, modeKey(tl.mode))}</Badge> <Badge>{t(locale, stateKey(tl.runState))}</Badge>
    </p>
  );
}

function Limits({ locale, tl }: { locale: Locale; tl: Timeline }) {
  return (
    <section aria-labelledby="agt-lim-h" className="knd">
      <h3 className="nz-h3" id="agt-lim-h">
        {t(locale, 'agt.limits.title')}
      </h3>
      <ul className="kni-list" data-testid="agt-limits">
        {LIMIT_NAMES.map((n) => {
          const l = tl.limits[n];
          const used = n === 'resultBytes' ? iso(bytesLabel(l.used)) : String(l.used);
          const max = n === 'resultBytes' ? iso(bytesLabel(l.max)) : String(l.max);
          const text = t(locale, 'agt.limit.of', { used, max });
          return (
            <li key={n}>
              {t(locale, limitKey(n))}: {text}{' '}
              <Meter label={`${t(locale, limitKey(n))}: ${text}`} percent={limitPct(l)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Step({ locale, s }: { locale: Locale; s: TimelineStep }) {
  return (
    <li data-testid={`agt-step-${s.node}`} data-status={s.status}>
      <p>
        <strong>{t(locale, phaseKey(s.phase))}</strong> <Ltr>{s.node}</Ltr>{' '}
        <Badge>{t(locale, stepStatusKey(s.status))}</Badge>
        {s.errorCode && (
          <>
            {' '}
            {t(locale, 'agt.err.code')}: <Ltr>{s.errorCode}</Ltr>
          </>
        )}
      </p>
      {(s.tokensIn > 0 || s.tokensOut > 0) && (
        <p className="nz-muted">
          {t(locale, 'agt.step.tokens', { tokensIn: s.tokensIn, tokensOut: s.tokensOut })}
        </p>
      )}
      {s.toolCalls.length > 0 && (
        <details>
          <summary>
            {t(locale, 'agt.calls.title')} ({s.toolCalls.length})
          </summary>
          <ul className="kni-list">
            {s.toolCalls.map((c) => (
              <li key={c.callId} data-testid="agt-call">
                <Ltr>{c.tool}</Ltr> <Badge>{t(locale, callStatusKey(c.status))}</Badge>{' '}
                {c.errorCode && <Ltr>{c.errorCode}</Ltr>}
                {argsLine(c.args) && (
                  <>
                    {' '}
                    <code dir="ltr">{argsLine(c.args)}</code>
                  </>
                )}
                <span className="nz-muted">
                  {' '}
                  {t(locale, 'agt.call.size', { size: iso(bytesLabel(c.resultBytes)) })}
                  {c.durationMs !== null && (
                    <> · {t(locale, 'agt.call.ms', { ms: c.durationMs })}</>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

const OUTCOMES = ['adapted', 'noop', 'failed', 'cancelled', 'budget_exceeded'];

function Outcome({ locale, tl }: { locale: Locale; tl: Timeline }) {
  const o = tl.outcome as {
    outcome?: string | null;
    summary?: string | null;
    patches?: number | null;
    branch?: string | null;
    errorCode?: string | null;
  } | null;
  if (!o) return null;
  const key = (
    o.outcome && OUTCOMES.includes(o.outcome) ? `agt.outcome.${o.outcome}` : 'agt.outcome.UNKNOWN'
  ) as MessageKey;
  return (
    <section aria-labelledby="agt-out-h" className="knd" data-testid="agt-outcome">
      <h3 className="nz-h3" id="agt-out-h">
        {t(locale, 'agt.outcome.title')}
      </h3>
      <p>{t(locale, key)}</p>
      {o.summary && <p dir="auto">{o.summary}</p>}
      {typeof o.patches === 'number' && <p>{t(locale, 'agt.outcome.patches', { n: o.patches })}</p>}
      {o.branch && (
        <p>
          {t(locale, 'agt.outcome.branch')}: <Ltr>{o.branch}</Ltr>
        </p>
      )}
      {o.errorCode && (
        <p>
          {t(locale, 'agt.err.code')}: <Ltr>{o.errorCode}</Ltr>
        </p>
      )}
    </section>
  );
}
