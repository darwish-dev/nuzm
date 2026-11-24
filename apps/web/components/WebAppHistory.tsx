'use client';
import { useState } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Icon } from '@nuzm/ui';
import { credits, num, type Run } from '../lib/builder';
import { useRunStream } from '../lib/builder-client';
import { runFailure } from '../lib/mobile';
import type { OpenTarget } from '../lib/webapp-events';
import { appPhase } from '../lib/webapp-workspace';
import { when } from './BuilderBits';
import { ProducedList, RunTimeline, useProduced } from './WebAppTimeline';

/** The events of one earlier build, read only when its card is opened (a finished run's stream ends by itself). */
function PastDetail({
  locale,
  run,
  onOpen,
}: {
  locale: Locale;
  run: Run;
  onOpen?: (t: OpenTarget) => void;
}) {
  const stream = useRunStream(run.id);
  const produced = useProduced(run, stream.events);
  return (
    <div className="wsp-past-body">
      <ProducedList locale={locale} items={produced} onOpen={onOpen} />
      <RunTimeline locale={locale} events={stream.events} live={false} onOpen={onOpen} />
    </div>
  );
}

/**
 * An earlier build or test-and-fix run in the conversation, kept after the next request: when it ran, how it ended (the reasons a failed one gave), what it cost,
 * and, when opened, what it produced and its events. It comes from the persisted run, so it is there after a reload. Nothing here can change the run.
 */
export function WebAppRunHistory({
  locale,
  run,
  onOpen,
}: {
  locale: Locale;
  run: Run;
  onOpen?: (t: OpenTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const phase = appPhase(run.state);
  const failure = run.state === 'failed' ? runFailure(run.error) : null;
  return (
    <li className="bld-hist">
      <section className="bld-run mws-run wsp-past" data-state={run.state} data-phase={phase}>
        <header className="bld-run-head">
          <span className="bld-run-icon" data-state={run.state} aria-hidden="true">
            <Icon name={run.state === 'succeeded' ? 'check' : 'close'} size={16} />
          </span>
          <div>
            <strong>{t(locale, `mws.web.run.title.${phase}` as MessageKey)}</strong>
            <span className="bld-run-sub">
              <Badge>{tDynamic(locale, `bld.run.kind.${run.kind}`, run.kind)}</Badge>{' '}
              {when(run.createdAt, locale)}
            </span>
          </div>
        </header>
        {failure && (failure.details.length > 0 || failure.message) && (
          <div className="mws-reasons">
            <p className="mws-reasons-h">
              {t(locale, 'm10a.run.failed', { code: failure.code ?? '—' })}
            </p>
            <ul dir="auto">
              {(failure.details.length > 0 ? failure.details : [failure.message ?? '']).map(
                (d, i) => (
                  <li key={i}>
                    <bdi dir="auto">{d}</bdi>
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
        {run.state === 'budget_exceeded' && (
          <Banner tone="danger">{t(locale, 'bld.run.budgetExceeded')}</Banner>
        )}
        <footer className="bld-run-foot">
          <span className="nz-muted">
            {t(locale, 'bld.run.cost', {
              credits: credits(run.usage.spentCredits),
              tokens: num(run.usage.tokensIn) + num(run.usage.tokensOut),
            })}
          </span>
          <span className="bld-run-actions">
            <button
              type="button"
              className="bld-link"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {t(locale, open ? 'wsp.hist.hide' : 'wsp.hist.show')}
            </button>
            <a className="bld-link" href={`/builder/runs/${run.id}`}>
              {t(locale, 'bld.run.details')}
            </a>
          </span>
        </footer>
        {open && <PastDetail locale={locale} run={run} onOpen={onOpen} />}
      </section>
    </li>
  );
}
