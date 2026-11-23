'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  DIMENSIONS,
  MODES,
  SEARCH_PLATFORMS,
  STRATEGIES,
  requirementBody,
  weightsTotal,
  type DefaultView,
  type DimensionView,
  type EngineSettingsView,
  type RecommendationView,
  type RecommendedView,
  type RevisionView,
  type SearchHit,
  type SearchResult,
} from '../lib/knowledge-retrieval';

/**
 * Retrieval and recommendation console (S-K5, SCR-K-07): search the platform library, simulate a recommendation with the full explanation (hard filters first, then the weighted
 * model, then the strategy), and see or change the recommendation weights with their history. Everything the engine says is shown with its reason; nothing is hidden behind a
 * number. Reading needs `admin:ai_knowledge:read`; changing the weights needs `admin:ai_knowledge:publish`.
 */
const reason = (locale: Locale, r: string) => tDynamic(locale, `kr.reason.${r}`, r);
const BASE = '/v1/admin/knowledge';

export function KnowledgeRetrieval({
  locale,
  canPublish,
}: {
  locale: Locale;
  canPublish: boolean;
}) {
  return (
    <>
      <SearchPanel locale={locale} />
      <RecommendPanel locale={locale} />
      <SettingsPanel locale={locale} canPublish={canPublish} />
    </>
  );
}

// ---- search ----------------------------------------------------------------------------------------------------------------------
function SearchPanel({ locale }: { locale: Locale }) {
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState('');
  const [framework, setFramework] = useState('');
  const [eligible, setEligible] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  async function run(e: FormEvent) {
    e.preventDefault();
    setState('loading');
    const query: Record<string, string | number> = { limit: 20 };
    if (q.trim()) query.q = q.trim();
    if (platform) query.platform = platform;
    if (framework.trim()) query.framework = framework.trim();
    if (eligible) query.eligible = eligible;
    const x = await browserApi().GET(`${BASE}/search` as never, { params: { query } } as never);
    if (!x.response.ok) return setState('error');
    setRes(x.data as unknown as SearchResult);
    setState('ok');
  }
  return (
    <Card aria-label={t(locale, 'kr.search.title')}>
      <h2 className="nz-h2">{t(locale, 'kr.search.title')}</h2>
      <p className="nz-muted">{t(locale, 'kr.search.intro')}</p>
      <form className="kni-toolbar" role="search" onSubmit={run}>
        <Field id="kr-q" label={t(locale, 'kr.search.q')}>
          {(a) => <Input {...a} value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <Field id="kr-platform" label={t(locale, 'kr.platform')}>
          {(a) => (
            <Select {...a} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">{t(locale, 'kd.all')}</option>
              {SEARCH_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t(locale, `kn.platform.${p}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="kr-framework" label={t(locale, 'kr.framework')}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              value={framework}
              maxLength={40}
              onChange={(e) => setFramework(e.target.value)}
            />
          )}
        </Field>
        <Field id="kr-eligible" label={t(locale, 'kr.search.eligible')}>
          {(a) => (
            <Select {...a} value={eligible} onChange={(e) => setEligible(e.target.value)}>
              <option value="">{t(locale, 'kd.all')}</option>
              <option value="true">{t(locale, 'kr.eligible')}</option>
              <option value="false">{t(locale, 'kr.ineligible')}</option>
            </Select>
          )}
        </Field>
        <Button type="submit" disabled={state === 'loading'}>
          {t(locale, 'kr.search.run')}
        </Button>
      </form>
      {state === 'error' && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'kr.error')}
        </p>
      )}
      {state === 'loading' && (
        <p className="nz-muted" role="status">
          {t(locale, 'ki.loading')}
        </p>
      )}
      {state === 'ok' && res && (
        <>
          <p className="nz-muted" role="status">
            {t(locale, 'kr.search.results', { n: res.total })}
            {res.query.groups.length > 0 && (
              <>
                {' · '}
                {t(locale, 'kr.groups')}:{' '}
                {res.query.groups.map((g) => (
                  <span key={g.key}>
                    <Badge tone={g.concept ? 'success' : undefined}>
                      {g.concept ? tDynamic(locale, `kr.concept.${g.key}`, g.key) : g.key}
                    </Badge>{' '}
                  </span>
                ))}
              </>
            )}
          </p>
          {res.items.length === 0 ? (
            <EmptyState title={t(locale, 'kr.search.title')} body={t(locale, 'kr.search.none')} />
          ) : (
            <Table
              caption={t(locale, 'kr.search.title')}
              rows={res.items}
              rowKey={(h: SearchHit) => h.resourceId}
              columns={[
                {
                  key: 'name',
                  header: t(locale, 'kr.col.name'),
                  card: 'title',
                  render: (h: SearchHit) => (
                    <a href={`/${locale}/ai-intelligence/library/${h.resourceId}`}>{h.name}</a>
                  ),
                },
                {
                  key: 'rel',
                  header: t(locale, 'kr.col.relevance'),
                  card: 'meta',
                  render: (h: SearchHit) =>
                    h.relevance === null ? '—' : <Ltr>{`${h.relevance}%`}</Ltr>,
                },
                {
                  key: 'plat',
                  header: t(locale, 'kr.platform'),
                  card: 'meta',
                  render: (h: SearchHit) =>
                    h.platform ? t(locale, `kn.platform.${h.platform}` as MessageKey) : '—',
                },
                {
                  key: 'fw',
                  header: t(locale, 'kr.framework'),
                  card: 'meta',
                  render: (h: SearchHit) => <Ltr>{h.frameworks.join(', ') || '—'}</Ltr>,
                },
                {
                  key: 'elig',
                  header: t(locale, 'kr.col.eligibility'),
                  card: 'badge',
                  render: (h: SearchHit) =>
                    h.eligibility.eligible ? (
                      <Badge tone="success">{t(locale, 'kr.eligible')}</Badge>
                    ) : (
                      <>
                        <Badge tone="danger">{t(locale, 'kr.ineligible')}</Badge>{' '}
                        {h.eligibility.reasons.map((r) => reason(locale, r)).join('، ')}
                      </>
                    ),
                },
                {
                  key: 'ev',
                  header: t(locale, 'kr.col.evidence'),
                  card: 'footer',
                  render: (h: SearchHit) =>
                    h.matches.length === 0 && h.components.length === 0 ? (
                      '—'
                    ) : (
                      <ul className="kni-list">
                        {h.components.slice(0, 3).map((c) => (
                          <li key={c.ref}>
                            <Ltr>{c.name}</Ltr>
                          </li>
                        ))}
                        {h.matches.slice(0, 2).map((m) => (
                          <li key={`${m.kind}:${m.ref}`}>
                            {tDynamic(locale, `kr.doc.${m.kind}`, m.kind)}: <Ltr>{m.ref}</Ltr>
                          </li>
                        ))}
                      </ul>
                    ),
                },
              ]}
            />
          )}
        </>
      )}
    </Card>
  );
}

// ---- recommendation --------------------------------------------------------------------------------------------------------------
const EMPTY = {
  text: '',
  platform: '',
  frameworks: '',
  frameworksRequired: false,
  mode: 'ADAPTIVE',
  strategy: 'AUTO_SELECT',
  resourceId: '',
  requiresAi: false,
  dark: '',
  rtl: '',
  arabicFont: '',
  tailwind: '',
  primaryColor: '',
};

function Tri({
  locale,
  id,
  label,
  value,
  onChange,
}: {
  locale: Locale;
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field id={id} label={label}>
      {(a) => (
        <Select {...a} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t(locale, 'kr.rec.any')}</option>
          <option value="yes">{t(locale, 'kr.rec.yes')}</option>
          <option value="no">{t(locale, 'kr.rec.no')}</option>
        </Select>
      )}
    </Field>
  );
}

function RecommendPanel({ locale }: { locale: Locale }) {
  const [f, setF] = useState(EMPTY);
  const [res, setRes] = useState<RecommendationView | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error' | 'invalid'>('idle');
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) =>
    setF((c) => ({ ...c, [k]: v }));
  async function run(e: FormEvent) {
    e.preventDefault();
    setState('loading');
    const x = await browserApi().POST(
      `${BASE}/recommendations` as never,
      { body: requirementBody(f) } as never,
    );
    if (x.response.status === 422) return setState('invalid');
    if (!x.response.ok) return setState('error');
    setRes(x.data as unknown as RecommendationView);
    setState('ok');
  }
  return (
    <Card aria-label={t(locale, 'kr.rec.title')}>
      <h2 className="nz-h2">{t(locale, 'kr.rec.title')}</h2>
      <p className="nz-muted">{t(locale, 'kr.rec.intro')}</p>
      <form onSubmit={run}>
        <Field id="kr-text" label={t(locale, 'kr.rec.text')} help={t(locale, 'kr.rec.text.help')}>
          {(a) => (
            <textarea
              {...a}
              className="nz-input"
              rows={3}
              maxLength={2000}
              value={f.text}
              onChange={(e) => set('text', e.target.value)}
            />
          )}
        </Field>
        <div className="kni-toolbar">
          <Field id="kr-rec-platform" label={t(locale, 'kr.platform')}>
            {(a) => (
              <Select {...a} value={f.platform} onChange={(e) => set('platform', e.target.value)}>
                <option value="">{t(locale, 'kr.rec.any')}</option>
                {SEARCH_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {t(locale, `kn.platform.${p}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            id="kr-rec-fw"
            label={t(locale, 'kr.rec.frameworks')}
            help={t(locale, 'kr.rec.frameworks.help')}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                value={f.frameworks}
                maxLength={200}
                onChange={(e) => set('frameworks', e.target.value)}
              />
            )}
          </Field>
          <Field id="kr-rec-mode" label={t(locale, 'kr.rec.mode')}>
            {(a) => (
              <Select {...a} value={f.mode} onChange={(e) => set('mode', e.target.value)}>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(locale, `kr.mode.${m}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="kr-rec-strategy" label={t(locale, 'kr.rec.strategy')}>
            {(a) => (
              <Select {...a} value={f.strategy} onChange={(e) => set('strategy', e.target.value)}>
                {STRATEGIES.map((m) => (
                  <option key={m} value={m}>
                    {t(locale, `kr.strategy.${m}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {f.strategy === 'USER_SELECTED' && (
            <Field id="kr-rec-resource" label={t(locale, 'kr.rec.resourceId')}>
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  value={f.resourceId}
                  maxLength={40}
                  onChange={(e) => set('resourceId', e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
        <fieldset className="kni-pad">
          <legend>{t(locale, 'kr.rec.design')}</legend>
          <div className="kni-toolbar">
            <Tri
              locale={locale}
              id="kr-dark"
              label={t(locale, 'kd.trait.darkMode')}
              value={f.dark}
              onChange={(v) => set('dark', v)}
            />
            <Tri
              locale={locale}
              id="kr-rtl"
              label={t(locale, 'kd.trait.rtl')}
              value={f.rtl}
              onChange={(v) => set('rtl', v)}
            />
            <Tri
              locale={locale}
              id="kr-arabic"
              label={t(locale, 'kd.trait.arabicFont')}
              value={f.arabicFont}
              onChange={(v) => set('arabicFont', v)}
            />
            <Tri
              locale={locale}
              id="kr-tailwind"
              label={t(locale, 'kd.trait.tailwind')}
              value={f.tailwind}
              onChange={(v) => set('tailwind', v)}
            />
            <Field id="kr-colour" label={t(locale, 'kr.rec.primaryColor')} help="#2563eb">
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  value={f.primaryColor}
                  maxLength={30}
                  onChange={(e) => set('primaryColor', e.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>
        <p>
          <label>
            <input
              type="checkbox"
              checked={f.frameworksRequired}
              onChange={(e) => set('frameworksRequired', e.target.checked)}
            />{' '}
            {t(locale, 'kr.rec.required')}
          </label>
          {' · '}
          <label>
            <input
              type="checkbox"
              checked={f.requiresAi}
              onChange={(e) => set('requiresAi', e.target.checked)}
            />{' '}
            {t(locale, 'kr.rec.ai')}
          </label>
        </p>
        <Button type="submit" disabled={state === 'loading'}>
          {t(locale, 'kr.rec.run')}
        </Button>
      </form>
      {state === 'error' && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'kr.error')}
        </p>
      )}
      {state === 'invalid' && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'kr.rec.invalid')}
        </p>
      )}
      {state === 'loading' && (
        <p className="nz-muted" role="status">
          {t(locale, 'ki.loading')}
        </p>
      )}
      {state === 'ok' && res && <RecommendationResult locale={locale} r={res} />}
    </Card>
  );
}

function ScoreBar({ locale, score, label }: { locale: Locale; score: number; label: string }) {
  return (
    <span className="kr-score">
      <progress className="kr-bar" max={100} value={score} aria-label={label} />
      <Ltr>{`${score}`}</Ltr>
      <span className="nz-muted"> /100 · {t(locale, 'kr.score')}</span>
    </span>
  );
}

function Breakdown({ locale, c }: { locale: Locale; c: RecommendedView }) {
  return (
    <>
      {c.gated && <p className="nz-muted">{t(locale, 'kr.gated')}</p>}
      <Table
        caption={`${c.name} — ${t(locale, 'kr.breakdown')}`}
        rows={c.dimensions}
        rowKey={(d: DimensionView) => d.dimension}
        columns={[
          {
            key: 'dim',
            header: t(locale, 'kr.col.dimension'),
            card: 'title',
            render: (d: DimensionView) => t(locale, `kr.dimension.${d.dimension}` as MessageKey),
          },
          {
            key: 'w',
            header: t(locale, 'kr.col.weight'),
            card: 'meta',
            render: (d: DimensionView) =>
              d.applicable ? (
                <Ltr>{`${d.effectiveWeight}% (${d.weight})`}</Ltr>
              ) : (
                <Ltr>{`0% (${d.weight})`}</Ltr>
              ),
          },
          {
            key: 's',
            header: t(locale, 'kr.col.score'),
            card: 'badge',
            render: (d: DimensionView) =>
              d.applicable && d.score !== null ? (
                <Ltr>{`${Math.round(d.score * 100)}%`}</Ltr>
              ) : (
                <Badge>{t(locale, 'kr.na')}</Badge>
              ),
          },
          {
            key: 'p',
            header: t(locale, 'kr.col.points'),
            card: 'meta',
            render: (d: DimensionView) => <Ltr>{String(d.points)}</Ltr>,
          },
          {
            key: 'n',
            header: t(locale, 'kr.col.why'),
            card: 'footer',
            render: (d: DimensionView) => tDynamic(locale, `kr.note.${d.note}`, d.note),
          },
        ]}
      />
    </>
  );
}

function Candidate({
  locale,
  c,
  selected,
}: {
  locale: Locale;
  c: RecommendedView;
  selected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="kr-cand" aria-label={c.name}>
      <div>
        <strong>{c.name}</strong>{' '}
        {selected && <Badge tone="success">{t(locale, 'kr.selected')}</Badge>}{' '}
        <Badge>{c.resourceType}</Badge>{' '}
        {c.platform && <Badge>{t(locale, `kn.platform.${c.platform}` as MessageKey)}</Badge>}{' '}
        <span className="nz-muted">
          {t(locale, 'kr.confidence')} <Ltr>{`${c.confidence}%`}</Ltr>
        </span>
      </div>
      <ScoreBar locale={locale} score={c.score} label={`${c.name}: ${t(locale, 'kr.score')}`} />
      <div className="nz-muted">
        {t(locale, 'kr.usage')}:{' '}
        {c.usage.recommended ? t(locale, `kr.usage.${c.usage.recommended}` as MessageKey) : '—'} ·{' '}
        {t(locale, 'kr.license')}: <Ltr>{c.license.spdx ?? c.license.verdict}</Ltr>
        {c.components.length > 0 && (
          <>
            {' · '}
            <Ltr>
              {c.components
                .slice(0, 4)
                .map((x) => x.name)
                .join(', ')}
            </Ltr>
          </>
        )}
      </div>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t(locale, open ? 'kc.hide' : 'kc.details')}
      </Button>
      {open && <Breakdown locale={locale} c={c} />}
    </li>
  );
}

function RecommendationResult({ locale, r }: { locale: Locale; r: RecommendationView }) {
  const d = r.decision;
  return (
    <div aria-label={t(locale, 'kr.result')}>
      <h3 className="nz-h3">{t(locale, 'kr.decision')}</h3>
      <p role="status">
        <Badge tone={d.selectedResourceId ? 'success' : 'warn'}>
          {t(locale, `kr.strategy.${d.strategy}` as MessageKey)}
        </Badge>{' '}
        {d.notes.map((n) => tDynamic(locale, `kr.decision.${n}`, n)).join(' · ')}
      </p>
      {r.userChoice && (
        <p role="alert">
          <strong>{r.userChoice.name ?? r.userChoice.resourceId}</strong>:{' '}
          {r.userChoice.reasons.map((x) => reason(locale, x)).join('، ')}
        </p>
      )}
      {r.adminDefault && !r.adminDefault.eligible && (
        <p className="nz-muted">
          {t(locale, 'kr.adminDefault')}:{' '}
          {r.adminDefault.reasons.map((x) => reason(locale, x)).join('، ')}
        </p>
      )}
      <p className="nz-muted">
        {t(locale, 'kr.stats', {
          considered: r.stats.considered,
          eligible: r.stats.eligible,
          excluded: r.stats.excluded,
        })}
        {r.requirement.groups.length > 0 && (
          <>
            {' · '}
            {t(locale, 'kr.groups')}:{' '}
            {r.requirement.groups
              .map((g) => (g.concept ? tDynamic(locale, `kr.concept.${g.key}`, g.key) : g.key))
              .join('، ')}
          </>
        )}
      </p>
      <h3 className="nz-h3">{t(locale, 'kr.ranked')}</h3>
      {r.ranked.length === 0 ? (
        <p className="nz-muted">{t(locale, 'kr.ranked.none')}</p>
      ) : (
        <ol className="kr-list">
          {r.ranked.map((c) => (
            <Candidate
              key={c.resourceId}
              locale={locale}
              c={c}
              selected={c.resourceId === d.selectedResourceId}
            />
          ))}
        </ol>
      )}
      {r.alternatives.length > 0 && (
        <>
          <h3 className="nz-h3">{t(locale, 'kr.alternatives')}</h3>
          <p className="nz-muted">{t(locale, 'kr.alternatives.note')}</p>
          <ol className="kr-list">
            {r.alternatives.map((c) => (
              <Candidate key={c.resourceId} locale={locale} c={c} />
            ))}
          </ol>
        </>
      )}
      <h3 className="nz-h3">{t(locale, 'kr.excluded')}</h3>
      <p className="nz-muted">{t(locale, 'kr.excluded.note')}</p>
      {r.excluded.length === 0 ? (
        <p className="nz-muted">{t(locale, 'kr.excluded.none')}</p>
      ) : (
        <ul className="kni-list">
          {r.excluded.map((x) => (
            <li key={x.resourceId}>
              <strong>{x.name}</strong>: {x.reasons.map((y) => reason(locale, y)).join('، ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- settings --------------------------------------------------------------------------------------------------------------------
function SettingsPanel({ locale, canPublish }: { locale: Locale; canPublish: boolean }) {
  const [cur, setCur] = useState<EngineSettingsView | null>(null);
  const [hist, setHist] = useState<RevisionView[]>([]);
  const [defs, setDefs] = useState<DefaultView[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading');
  const [w, setW] = useState<Record<string, string>>({});
  const [min, setMin] = useState('35');
  const [why, setWhy] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; key: MessageKey } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      browserApi().GET(`${BASE}/settings/recommendation` as never, {} as never),
      browserApi().GET(`${BASE}/settings/recommendation/revisions` as never, {} as never),
      browserApi().GET(`${BASE}/defaults` as never, {} as never),
    ]);
    if (a.response.status === 403) return setState('forbidden');
    if (!a.response.ok) return setState('error');
    const s = a.data as unknown as EngineSettingsView;
    setCur(s);
    setW(Object.fromEntries(DIMENSIONS.map((d) => [d, String(s.weights[d] ?? 0)])));
    setMin(String(s.minScore));
    setHist(b.response.ok ? ((b.data as unknown as { items: RevisionView[] }).items ?? []) : []);
    setDefs(c.response.ok ? ((c.data as unknown as { items: DefaultView[] }).items ?? []) : []);
    setState('ok');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const total = weightsTotal(w);
  const valid =
    total === 100 &&
    DIMENSIONS.every((d) => /^\d{1,3}$/.test(w[d] ?? '')) &&
    /^\d{1,3}$/.test(min) &&
    Number(min) <= 100 &&
    why.trim().length >= 10;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!cur || !valid) return;
    setBusy(true);
    setNotice(null);
    const r = await browserApi().PUT(
      `${BASE}/settings/recommendation` as never,
      {
        params: { header: { 'If-Match': String(cur.revision) } },
        body: {
          weights: Object.fromEntries(DIMENSIONS.map((d) => [d, Number(w[d])])),
          minScore: Number(min),
          reason: why.trim(),
        },
      } as never,
    );
    setBusy(false);
    if (r.response.status === 412) return setNotice({ tone: 'error', key: 'kr.set.stale' });
    if (r.response.status === 403) return setNotice({ tone: 'error', key: 'ki.forbidden' });
    if (!r.response.ok) return setNotice({ tone: 'error', key: 'kr.set.invalid' });
    setWhy('');
    setNotice({ tone: 'ok', key: 'kr.set.saved' });
    await load();
  }
  return (
    <Card aria-label={t(locale, 'kr.set.title')}>
      <h2 className="nz-h2">{t(locale, 'kr.set.title')}</h2>
      <p className="nz-muted">{t(locale, 'kr.set.intro')}</p>
      {state === 'loading' && (
        <p className="nz-muted" role="status">
          {t(locale, 'ki.loading')}
        </p>
      )}
      {state === 'forbidden' && <p className="nz-error-text">{t(locale, 'ki.forbidden')}</p>}
      {state === 'error' && (
        <div role="alert">
          <p className="nz-error-text">{t(locale, 'kr.error')}</p>
          <Button variant="secondary" onClick={() => void load()}>
            {t(locale, 'ki.retry.load')}
          </Button>
        </div>
      )}
      {state === 'ok' && cur && (
        <>
          <p>
            <Badge tone={cur.isDefault ? undefined : 'success'}>
              {cur.isDefault
                ? t(locale, 'kr.set.default')
                : t(locale, 'kr.set.revision', { n: cur.revision })}
            </Badge>
          </p>
          <form onSubmit={save}>
            <div className="kni-toolbar">
              {DIMENSIONS.map((d) => (
                <Field
                  key={d}
                  id={`kr-w-${d}`}
                  label={t(locale, `kr.dimension.${d}` as MessageKey)}
                >
                  {(a) => (
                    <Input
                      {...a}
                      dir="ltr"
                      inputMode="numeric"
                      value={w[d] ?? ''}
                      disabled={!canPublish}
                      onChange={(e) => setW((c) => ({ ...c, [d]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
              <Field
                id="kr-min"
                label={t(locale, 'kr.set.minScore')}
                help={t(locale, 'kr.set.minScore.help')}
              >
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    inputMode="numeric"
                    value={min}
                    disabled={!canPublish}
                    onChange={(e) => setMin(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <p role="status" className={total === 100 ? 'nz-muted' : 'nz-error-text'}>
              {t(locale, total === 100 ? 'kr.set.sum' : 'kr.set.sum.bad', { n: total })}
            </p>
            {canPublish ? (
              <>
                <Field
                  id="kr-why"
                  label={t(locale, 'kr.set.reason')}
                  help={t(locale, 'kr.set.reason.help')}
                >
                  {(a) => (
                    <Input
                      {...a}
                      value={why}
                      maxLength={500}
                      onChange={(e) => setWhy(e.target.value)}
                    />
                  )}
                </Field>
                <Button type="submit" disabled={!valid || busy}>
                  {t(locale, 'kr.set.save')}
                </Button>
              </>
            ) : (
              <p className="nz-muted">{t(locale, 'kr.set.readonly')}</p>
            )}
            {notice && (
              <p
                role={notice.tone === 'error' ? 'alert' : 'status'}
                className={notice.tone === 'error' ? 'nz-error-text' : 'nz-muted'}
              >
                {t(locale, notice.key)}
              </p>
            )}
          </form>
          <h3 className="nz-h3">{t(locale, 'kr.set.history')}</h3>
          {hist.length === 0 ? (
            <p className="nz-muted">{t(locale, 'kr.set.history.none')}</p>
          ) : (
            <ul className="kni-list">
              {hist.map((h) => (
                <li key={h.revision}>
                  <strong>{t(locale, 'kr.set.revision', { n: h.revision })}</strong>{' '}
                  <span className="nz-muted">
                    {h.createdAt ? formatDateTime(h.createdAt, locale) : ''}
                  </span>
                  {' · '}
                  {h.reason}
                  {' · '}
                  <Ltr>
                    {DIMENSIONS.map((d) => h.value.weights?.[d] ?? 0).join('/')} ·{' '}
                    {h.value.minScore}
                  </Ltr>
                </li>
              ))}
            </ul>
          )}
          <h3 className="nz-h3">{t(locale, 'kr.defaults.title')}</h3>
          <p className="nz-muted">{t(locale, 'kr.defaults.note')}</p>
          {defs.length === 0 ? (
            <p className="nz-muted">{t(locale, 'kr.defaults.none')}</p>
          ) : (
            <Table
              caption={t(locale, 'kr.defaults.title')}
              rows={defs}
              rowKey={(x: DefaultView) => x.id}
              columns={[
                {
                  key: 'res',
                  header: t(locale, 'kr.col.name'),
                  card: 'title',
                  render: (x: DefaultView) => x.resourceName ?? x.resourceId,
                },
                {
                  key: 'rule',
                  header: t(locale, 'kr.defaults.rule'),
                  card: 'meta',
                  render: (x: DefaultView) => (
                    <Ltr>{[x.platform, x.framework, x.category, x.plan, x.mode].join(' / ')}</Ltr>
                  ),
                },
                {
                  key: 'pin',
                  header: t(locale, 'kr.defaults.pin'),
                  card: 'meta',
                  render: (x: DefaultView) =>
                    x.versionPin ? <Ltr>{x.versionPin.slice(0, 8)}</Ltr> : '—',
                },
              ]}
            />
          )}
        </>
      )}
    </Card>
  );
}
