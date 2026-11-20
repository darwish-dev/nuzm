'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { safeText } from '../lib/appbuilder';
import type { Built } from '../lib/appworkspace-server';
import type { Run, RunEvent } from '../lib/builder';
import {
  committedFiles,
  producedItems,
  timeText,
  timelineOf,
  type OpenTarget,
  type ProducedItem,
  type TimelineItem,
} from '../lib/webapp-events';
import { readRunBuilt } from '../lib/webapp-built';

/** The words of a link to a panel ("Open Code", "Open migrations" ...). */
export const openLabel = (locale: Locale, o: OpenTarget): string =>
  o.tab === 'design' && o.view
    ? t(locale, `wsp.open.design.${o.view}` as 'wsp.open.design.tables')
    : t(locale, `wsp.open.${o.tab}` as 'wsp.open.code');

function EventText({ locale, item }: { locale: Locale; item: TimelineItem }) {
  const agent = String(item.params.agent ?? '');
  const params = {
    ...item.params,
    agent: agent ? tDynamic(locale, `m10a.agent.${agent}`, safeText(agent, 40)) : '',
  };
  // an event type this screen does not know is shown by its code (nothing is invented)
  const text = item.key.startsWith('bld.ev.')
    ? tDynamic(
        locale,
        item.key,
        t(locale, 'wsp.ev.other', { code: String(item.params.code ?? '') }),
      )
    : t(locale, item.key as 'wsp.ev.created', params);
  return <>{text}</>;
}

/**
 * The live activity of one build as a timeline: what started and finished (each agent, with its tokens), the files committed, approvals asked and decided, budget
 * warnings and how the run ended with the reasons it gave; a step whose result lives in a panel carries a link that opens it. It only restates the run's persisted
 * events (see `timelineOf`); new events are announced politely. A failed step is never hidden.
 */
export function RunTimeline({
  locale,
  events,
  live,
  onOpen,
}: {
  locale: Locale;
  events: readonly RunEvent[];
  /** the run is still working: new entries are announced and the newest is kept in view */
  live: boolean;
  onOpen?: (target: OpenTarget) => void;
}) {
  const items = useMemo(() => timelineOf(events), [events]);
  const last = useRef<HTMLLIElement>(null);
  // while the build works, the newest entry stays in view (nothing moves once it is over)
  useEffect(() => {
    if (live) last.current?.scrollIntoView?.({ block: 'nearest' });
  }, [live, items.length]);
  if (items.length === 0)
    return (
      <p className="nz-muted wsp-ev-empty" role="status">
        {t(locale, live ? 'wsp.ev.waiting' : 'wsp.ev.none')}
      </p>
    );
  return (
    <ol
      className="wsp-ev"
      aria-label={t(locale, 'wsp.ev.title')}
      aria-live={live ? 'polite' : 'off'}
    >
      {items.map((it, i) => (
        <li key={it.seq} data-tone={it.tone} ref={i === items.length - 1 ? last : undefined}>
          <span className="wsp-ev-ico" aria-hidden="true">
            <Icon name={it.icon} size={13} />
          </span>
          <div className="wsp-ev-main">
            <p>
              <EventText locale={locale} item={it} />
            </p>
            {it.detail && (
              <small className="wsp-ev-detail">
                {t(locale, it.detail.key as 'wsp.ev.tokens', it.detail.params)}
              </small>
            )}
            {it.reasons && it.reasons.length > 0 && (
              <ul className="wsp-ev-reasons" dir="auto">
                {it.reasons.map((r, i) => (
                  <li key={i}>
                    <bdi dir="auto">{r}</bdi>
                  </li>
                ))}
              </ul>
            )}
            {it.open && onOpen && (
              <button type="button" className="wsp-ev-open" onClick={() => onOpen(it.open!)}>
                {openLabel(locale, it.open)}
                <Icon name="arrow" size={12} />
              </button>
            )}
          </div>
          <time dateTime={it.at}>{timeText(it.at, locale)}</time>
        </li>
      ))}
    </ol>
  );
}

/**
 * What a build produced, read from the artifacts the run already saved: the spec (entities), the database (tables, migrations, a flag when one is destructive), the
 * REST API (endpoints), the roles, the files committed as a version, the test plan and the deployment plan. Each item opens its panel. Items appear as their agent
 * finishes; counts that cannot be read stay out rather than being guessed.
 */
export function useProduced(run: Run | null, events: readonly RunEvent[]): ProducedItem[] {
  const [built, setBuilt] = useState<Built | null>(null);
  const types = run ? run.artifacts.map((a) => a.type) : [];
  const key = run ? `${run.id}:${types.join(',')}` : '';
  useEffect(() => {
    if (!run || run.artifacts.length === 0) {
      setBuilt(null);
      return;
    }
    let stop = false;
    void readRunBuilt(run).then((b) => {
      if (!stop) setBuilt(b);
    });
    return () => {
      stop = true;
    };
  }, [key]);
  return useMemo(
    () =>
      run
        ? producedItems({
            artifactTypes: types,
            spec: built?.spec ?? null,
            tables: built?.schema ? built.schema.tables.length : null,
            migrations: built?.schema ? built.schema.migrations.length : null,
            destructive: built?.schema?.migrations.some((m) => m.destructive.length > 0) ?? false,
            endpoints: built?.api ? built.api.endpoints.length : null,
            files: committedFiles(events),
          })
        : [],
    [key, built, events],
  );
}

/** "What was produced": the items as links into the Code, Data, Spec, Tests and Deployments panels. */
export function ProducedList({
  locale,
  items,
  onOpen,
}: {
  locale: Locale;
  items: ProducedItem[];
  onOpen?: (target: OpenTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="wsp-prod" aria-labelledby="wsp-prod-h">
      <h3 className="wsp-prod-h" id="wsp-prod-h">
        {t(locale, 'wsp.prod.title')}
      </h3>
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              disabled={!onOpen}
              data-warn={it.warn ? 'true' : undefined}
              onClick={() => onOpen?.(it.open)}
            >
              <span>{t(locale, `wsp.prod.${it.id}` as 'wsp.prod.spec')}</span>
              {it.count !== null && <b dir="ltr">{it.count}</b>}
              {it.warn && (
                <span className="wsp-prod-warn">{t(locale, 'wsp.prod.destructive')}</span>
              )}
              <Icon name="arrow" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
