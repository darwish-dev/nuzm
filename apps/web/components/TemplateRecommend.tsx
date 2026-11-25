'use client';
import { PROJECT_PROMPT_MAX } from '../lib/appbuilder';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Ltr, Select } from '@nuzm/ui';
import { bapi } from '../lib/builder-client';
import {
  MODES,
  PLATFORMS,
  pct,
  recommendBody,
  type AdaptationMode,
  type Candidate,
  type Recommendation,
} from '../lib/templates';

/**
 * "Suggest a template" (S-K7): describe what to build; the recommendation engine answers with the best eligible templates and why. It only suggests: nothing is created and
 * a choice is never made for the customer. Only templates the customer may use are ever returned.
 */
export function TemplateRecommend({ locale }: { locale: Locale }) {
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState('');
  const [mode, setMode] = useState<AdaptationMode>('ADAPTIVE');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [res, setRes] = useState<Recommendation | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    const body = recommendBody({ text, platform, mode });
    if (!body || state === 'loading') return;
    setState('loading');
    const r = await bapi.post<Recommendation>('/v1/builder/template-recommendations', { body });
    if (!r.response.ok || !r.data) {
      setState('error');
      return;
    }
    setRes(r.data);
    setState('ok');
  }

  const ranked = res?.ranked ?? [];
  const best = res?.selected?.resourceId ?? null;
  return (
    <Card aria-labelledby="tpl-rec-h">
      <h2 className="nz-h2" id="tpl-rec-h">
        {t(locale, 'tpl.rec.title')}
      </h2>
      <p className="nz-muted">{t(locale, 'tpl.rec.intro')}</p>
      <form className="kni-toolbar" onSubmit={run} aria-busy={state === 'loading'}>
        <Field
          id="tpl-rec-text"
          label={t(locale, 'tpl.rec.text')}
          help={t(locale, 'tpl.rec.text.help')}

          error={
            text.trim().length > PROJECT_PROMPT_MAX
              ? t(locale, 'bld.start.promptErr', { max: PROJECT_PROMPT_MAX })
              : undefined
          }
        >
          {(a) => <Input {...a} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Field id="tpl-rec-platform" label={t(locale, 'tpl.filter.platform')}>
          {(a) => (
            <Select {...a} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">{t(locale, 'kd.all')}</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t(locale, `kn.platform.${p}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="tpl-rec-mode" label={t(locale, 'tpl.start.mode')}>
          {(a) => (
            <Select {...a} value={mode} onChange={(e) => setMode(e.target.value as AdaptationMode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(locale, `kr.mode.${m}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" disabled={state === 'loading' || (!text.trim() && !platform)}>
          {state === 'loading' ? t(locale, 'tpl.rec.busy') : t(locale, 'tpl.rec.run')}
        </Button>
      </form>
      {state === 'error' && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'tpl.rec.error')}
        </p>
      )}
      {state === 'ok' && res && (
        <div aria-live="polite" data-testid="tpl-rec-result">
          {(res.decision?.notes ?? []).length > 0 && (
            <p className="nz-muted">
              {(res.decision?.notes ?? [])
                .map((n) => tDynamic(locale, `kr.decision.${n}`, n))
                .join(' · ')}
            </p>
          )}
          {ranked.length === 0 ? (
            <EmptyState title={t(locale, 'tpl.rec.title')} body={t(locale, 'tpl.rec.none')} />
          ) : (
            <ul className="kr-list" aria-label={t(locale, 'tpl.rec.title')}>
              {ranked.map((c) => (
                <Candidate_ key={c.resourceId} locale={locale} c={c} best={c.resourceId === best} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function Candidate_({ locale, c, best }: { locale: Locale; c: Candidate; best: boolean }) {
  const usage = c.usage?.recommended;
  return (
    <li className="kr-cand" data-testid="tpl-rec-item">
      <div className="kr-score">
        <strong>
          <a href={`/${locale}/builder/templates/${c.resourceId}`}>{c.name}</a>
        </strong>
        {best && <Badge tone="success">{t(locale, 'tpl.rec.best')}</Badge>}
        {c.gated && <Badge tone="warn">{t(locale, 'tpl.rec.gated')}</Badge>}
        <Ltr>{`${pct(c.score)}%`}</Ltr>
        <progress
          className="kr-bar"
          max={100}
          value={pct(c.score)}
          aria-label={t(locale, 'tpl.rec.score', { n: pct(c.score) })}
        />
      </div>
      <p className="nz-muted">
        {t(locale, 'tpl.rec.confidence', { n: pct(c.confidence) })}
        {usage && <> · {tDynamic(locale, `kr.usage.${usage}`, usage)}</>}
        {c.platform && <> · {tDynamic(locale, `kn.platform.${c.platform}`, c.platform)}</>}
      </p>
      <details>
        <summary>{t(locale, 'tpl.rec.why')}</summary>
        <ul className="kni-list">
          {(c.dimensions ?? [])
            .filter((d) => d.applicable)
            .map((d) => (
              <li key={d.dimension}>
                {tDynamic(locale, `kr.dimension.${d.dimension}`, d.dimension ?? '')}:{' '}
                <Ltr>{`${pct((d.score ?? 0) * 100)}%`}</Ltr>
                {d.note && <> — {tDynamic(locale, `kr.note.${d.note}`, d.note)}</>}
              </li>
            ))}
        </ul>
      </details>
    </li>
  );
}
