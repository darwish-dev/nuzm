'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Icon, type IconName } from '@nuzm/ui';
import {
  TEMPLATE_IDS,
  credits,
  type Credits,
  type Project,
  type Run,
  type Session,
  type SiteLocale,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

/**
 * What can be started. `website` always; `webapp` only while the organization has the app builder on (flag `app_builder.enabled`); `mobile` only while it has
 * `mobile_builder.enabled`. A type that cannot be started is shown, honestly marked "coming soon", never faked.
 */
export const PROJECT_TYPES = [
  { id: 'website', available: true },
  { id: 'webapp', available: false },
  { id: 'mobile', available: false },
] as const;
export type StartType = (typeof PROJECT_TYPES)[number]['id'];
/** The start types with their availability for this organization. */
export const startTypes = (appsEnabled: boolean, mobileEnabled = false) =>
  PROJECT_TYPES.map((x) => ({
    id: x.id,
    available: x.id === 'webapp' ? appsEnabled : x.id === 'mobile' ? mobileEnabled : x.available,
  }));

const MAX_PROMPT = 600;
const EXAMPLES: { id: string; icon: IconName }[] = [
  { id: 'restaurant', icon: 'hosting' },
  { id: 'portfolio', icon: 'user' },
  { id: 'clinic', icon: 'shield' },
  { id: 'shop', icon: 'tag' },
];

/** Starting points for a web app (shown while the web-app type is selected). */
const APP_EXAMPLES: { id: string; icon: IconName }[] = [
  { id: 'crm', icon: 'organization' },
  { id: 'inventory', icon: 'data' },
  { id: 'booking', icon: 'tag' },
];

/** A project name (1..100 characters) from the first words of the description: the person never has to name anything to start. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?؟،,:;]+$/u, '')
    .split(' ')
    .slice(0, 6)
    .join(' ');
  const name = words.length > 60 ? `${words.slice(0, 60).trimEnd()}…` : words;
  return name || 'Project';
}

/**
 * UI-M09-02 (redesigned): one prompt, one button. Describe what to build → the project, its AI session and the first run are created in one go and the
 * workspace opens. No steps; languages, template and the spending cap are optional and live under "Options". Each stage keeps its result, so after a failure
 * (no credits, no model provider, kill switch, residency) the retry continues where it stopped and never creates a second project. Only the types that can
 * really be created are selectable to start; the others say "coming soon" (nothing is faked).
 */
export function BuilderStart({
  locale,
  credits: wallet,
  canRun,
  appsEnabled = false,
  mobileEnabled = false,
  initialType = 'website',
  projects,
  projectCount = 0,
  initialTab,
}: {
  locale: Locale;
  credits: Credits | null;
  canRun: boolean;
  /** the organization has `app_builder.enabled`: the web-app tile can be started */
  appsEnabled?: boolean;
  /** the organization has `mobile_builder.enabled`: the mobile-app tile can be started (it opens the mobile preview) */
  mobileEnabled?: boolean;
  initialType?: StartType;
  /** the organization's projects, rendered by the server: shown in the "My projects" tab */
  projects?: ReactNode;
  projectCount?: number;
  /** which tab of the lower section opens first: the projects when there are some, else the examples */
  initialTab?: 'examples' | 'projects';
}) {
  const router = useRouter();
  const call = useBuilderCall();
  const [type, setType] = useState<StartType>(initialType);
  const [prompt, setPrompt] = useState('');
  const [langs, setLangs] = useState<SiteLocale[]>(['ar', 'en']);
  const [template, setTemplate] = useState('');
  const [maxCredits, setMaxCredits] = useState('');
  const [err, setErr] = useState('');
  const [optErr, setOptErr] = useState('');
  const [partial, setPartial] = useState<string | null>(null);
  const hasProjects = projects !== undefined;
  const [tab, setTab] = useState<'examples' | 'projects'>(
    initialTab ?? (hasProjects && projectCount > 0 ? 'projects' : 'examples'),
  );
  const box = useRef<HTMLTextAreaElement>(null);
  const created = useRef<{ projectId?: string; sessionId?: string; requestStored?: boolean }>({});
  const keys = useRef({ project: newKey(), session: newKey(), message: newKey(), run: newKey() });
  const types = startTypes(appsEnabled, mobileEnabled);
  const startable = types.find((x) => x.id === type)?.available === true;

  const toggleLang = (l: SiteLocale) =>
    setLangs((cur) => {
      const next = cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l];
      // site languages keep the order ar, en: the first is the default language of the site
      return (['ar', 'en'] as const).filter((x) => next.includes(x));
    });

  function pickExample(id: string) {
    // the website examples are shown for every type but web app: picking one selects the website type (a web-app example keeps the web-app type)
    if (type !== 'webapp') setType('website');
    setPrompt(
      t(locale, (type === 'webapp' ? `m10a.start.ex.${id}` : `bld.start.ex.${id}`) as MessageKey),
    );
    setErr('');
    // back to the prompt: the chosen words are there to read, edit and send
    document
      .getElementById('bld-start-h')
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    box.current?.focus({ preventScroll: true });
  }

  const toMore = (e: { preventDefault(): void }) => {
    e.preventDefault();
    document.getElementById('bl-more')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (call.busy || !startable) return;
    const text = prompt.trim();
    if (text.length < 1 || text.length > MAX_PROMPT) {
      setErr(t(locale, 'bld.start.promptErr', { max: MAX_PROMPT }));
      box.current?.focus();
      return;
    }
    const cap = maxCredits.trim();
    if (cap !== '' && !/^[1-9]\d{0,8}$/.test(cap)) {
      setOptErr(t(locale, 'bld.wiz.budget.err'));
      return;
    }
    if (langs.length === 0) {
      setOptErr(t(locale, 'bld.wiz.languages.err'));
      return;
    }
    setErr('');
    setOptErr('');
    setPartial(null);
    const c = created.current;
    if (!c.projectId) {
      const base = nameFromPrompt(text);
      for (let attempt = 0; attempt < 3 && !c.projectId; attempt++) {
        const name = attempt === 0 ? base : `${base.slice(0, 90)} ${attempt + 1}`;
        let taken = false;
        const ok = await call.run(
          () =>
            bapi.post<Project>('/v1/builder/projects', {
              body: {
                type,
                name,
                locale: langs,
                ...(type === 'website' && template ? { templateId: template } : {}),
              },
              idempotencyKey: keys.current.project,
            }),
          (p) => {
            c.projectId = p.id;
          },
          // the same words twice: take the next free name instead of asking the person to rename anything
          (p) => {
            if (p.code === 'name_taken' && attempt < 2) {
              taken = true;
              keys.current.project = newKey();
              return true;
            }
          },
        );
        if (!ok && !taken) return;
      }
      if (!c.projectId) return;
    }
    if (!c.sessionId) {
      const ok = await call.run(
        () =>
          bapi.post<Session>('/v1/ai/sessions', {
            body: { title: nameFromPrompt(text).slice(0, 200), projectId: c.projectId },
            idempotencyKey: keys.current.session,
          }),
        (s) => {
          c.sessionId = s.id;
        },
        () => {
          setPartial(c.projectId ?? null);
        },
      );
      if (!ok) return;
    }
    // a mobile app's design request is also the first message of its chat (the workspace shows it above the live run); it is context, so a refusal does not stop the run
    if (type === 'mobile' && !c.requestStored) {
      const stored = await bapi.post<{ id: string }>(`/v1/ai/sessions/${c.sessionId}/messages`, {
        body: { content: text },
        idempotencyKey: keys.current.message,
      });
      if (stored.response.ok || stored.response.status !== 599) c.requestStored = true;
    }
    await call.run(
      () =>
        bapi.post<Run>('/v1/ai/runs', {
          body: {
            sessionId: c.sessionId,
            kind: type,
            projectId: c.projectId,
            // the person's words travel as DATA: `brief.prompt` for an app, `description` for a website
            input:
              type === 'webapp'
                ? { brief: { prompt: text, locales: langs } }
                : { description: text },
            ...(cap ? { budget: { maxCredits: Number(cap) } } : {}),
          },
          idempotencyKey: keys.current.run,
        }),
      // every project type opens in the same workspace (a mobile app in its mobile mode)
      () => router.push(`/${locale}/builder/projects/${c.projectId}`),
      (p) => {
        // a definitive refusal frees the key (the next attempt is a new request); an uncertain network failure keeps it so a retry cannot start a second run
        if (p.status !== 599) keys.current.run = newKey();
        setPartial(c.projectId ?? null);
      },
    );
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  };

  if (!canRun) return <Banner tone="warn">{t(locale, 'bld.wiz.noRunPermission')}</Banner>;

  const typeName = (id: StartType) => t(locale, `bld.start.type.${id}` as MessageKey);

  const exampleList = type === 'webapp' ? APP_EXAMPLES : EXAMPLES;
  const exText = (id: string) =>
    t(locale, (type === 'webapp' ? `m10a.start.ex.${id}` : `bld.start.ex.${id}`) as MessageKey);

  return (
    <div className="bl">
      <section className="bl-hero" aria-labelledby="bld-start-h">
        <div className="bl-glow" aria-hidden="true" />
        <form className="bl-form" onSubmit={(e) => void submit(e)} noValidate>
          <header className="bl-intro">
            <span className="bl-brand">
              <Icon name="code" size={16} /> Nuzm Builder
            </span>
            <h2 id="bld-start-h" className="bl-title">
              {t(locale, 'bld.start.hero')}
            </h2>
            <p className="bl-sub">{t(locale, 'bld.start.sub')}</p>
          </header>

          <div className="bl-prompt">
            <label className="nz-sr" htmlFor="bld-prompt">
              {t(locale, 'bld.start.promptLabel')}
            </label>
            <textarea
              id="bld-prompt"
              ref={box}
              className="bl-input"
              dir="auto"
              rows={4}
              maxLength={MAX_PROMPT}
              value={prompt}
              placeholder={t(locale, 'bld.start.placeholder')}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? 'bld-prompt-err' : 'bld-prompt-hint'}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (err) setErr('');
              }}
              onKeyDown={onKey}
            />
            <div className="bl-prompt-foot">
              <span className="bl-count" id="bld-prompt-hint">
                <bdi dir="ltr">
                  {prompt.length}/{MAX_PROMPT}
                </bdi>{' '}
                · <bdi dir="ltr">Ctrl / ⌘ + Enter</bdi> {t(locale, 'bld.start.keys')}
              </span>
              <button
                className="bl-go"
                type="submit"
                disabled={call.busy || !startable}
                aria-busy={call.busy}
              >
                <span>{call.busy ? t(locale, 'state.loading') : t(locale, 'bld.start.go')}</span>
                <Icon name="arrow" size={18} />
              </button>
            </div>
          </div>
          {err && (
            <p className="nz-error-text bl-err" id="bld-prompt-err" role="alert">
              {err}
            </p>
          )}

          <div className="bl-types" role="radiogroup" aria-labelledby="bld-types">
            <p className="bl-label" id="bld-types">
              {t(locale, 'bld.start.type.group')}
            </p>
            <div className="bl-types-grid">
              {types.map((x) => (
                <label key={x.id} className="bl-type" data-soon={!x.available ? 'true' : undefined}>
                  <input
                    type="radio"
                    name="bld-type"
                    value={x.id}
                    checked={type === x.id}
                    onChange={() => setType(x.id)}
                    aria-describedby={`bld-type-${x.id}`}
                  />
                  <span className="bl-type-icon">
                    <Icon
                      name={x.id === 'website' ? 'globe' : x.id === 'webapp' ? 'code' : 'phone'}
                      size={22}
                    />
                  </span>
                  <span className="bl-type-text">
                    <strong>{typeName(x.id)}</strong>
                    <small id={`bld-type-${x.id}`}>
                      {!x.available && (
                        <>
                          <Badge>{t(locale, 'bld.start.soon')}</Badge>{' '}
                        </>
                      )}
                      {t(locale, `bld.start.type.${x.id}.hint` as MessageKey)}
                    </small>
                  </span>
                  <span className="bl-type-dot" aria-hidden="true" />
                </label>
              ))}
            </div>
          </div>
          {!startable && (
            <p className="bl-note" role="status">
              {t(locale, 'bld.start.soonNote', { type: typeName(type) })}
            </p>
          )}

          <details className="bl-opts">
            <summary>{t(locale, 'bld.start.options')}</summary>
            <p className="bl-note">{t(locale, 'bld.start.options.hint')}</p>
            <div className="bl-opts-grid">
              <fieldset>
                <legend>{t(locale, 'bld.wiz.languages')}</legend>
                {(['ar', 'en'] as const).map((l) => (
                  <label key={l} className="bl-check">
                    <input
                      type="checkbox"
                      checked={langs.includes(l)}
                      onChange={() => toggleLang(l)}
                    />{' '}
                    {t(locale, `bld.lang.${l}`)}
                  </label>
                ))}
              </fieldset>
              {type === 'website' && (
                <label className="bl-field">
                  <span>{t(locale, 'bld.wiz.template')}</span>
                  <select
                    className="nz-input"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                  >
                    <option value="">{t(locale, 'bld.tpl.none')}</option>
                    {TEMPLATE_IDS.map((id) => (
                      <option key={id} value={id}>
                        {tDynamic(locale, `bld.tpl.${id}`, id)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="bl-field">
                <span>{t(locale, 'bld.wiz.budget')}</span>
                <input
                  className="nz-input"
                  inputMode="numeric"
                  dir="ltr"
                  value={maxCredits}
                  onChange={(e) => setMaxCredits(e.target.value)}
                />
                <small className="nz-help">{t(locale, 'bld.wiz.budget.help')}</small>
              </label>
            </div>
            {optErr && (
              <p className="nz-error-text" role="alert">
                {optErr}
              </p>
            )}
          </details>

          <p className="bl-note">
            {wallet
              ? t(locale, 'bld.start.credits', { credits: credits(wallet.availableCredits) })
              : t(locale, 'bld.wiz.credits.unknown')}
            {wallet?.lowCredit ? ` — ${t(locale, 'bld.wiz.credits.low')}` : ''}
          </p>
        </form>

        {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
        {partial && (
          <p role="status" className="bl-note">
            {t(locale, 'bld.wiz.partial')}{' '}
            <a href={`/${locale}/builder/projects/${partial}`}>
              {t(locale, 'bld.wiz.openProject')}
            </a>
          </p>
        )}

        <a className="bl-cue" href="#bl-more" onClick={toMore}>
          <span>{t(locale, 'bld.land.scroll')}</span>
          <Icon name="chevron" size={16} />
        </a>
      </section>

      <section className="bl-more" id="bl-more" aria-label={t(locale, 'bld.land.sections')}>
        <div className="bl-tabs" role="tablist" aria-label={t(locale, 'bld.land.sections')}>
          {hasProjects && (
            <button
              type="button"
              role="tab"
              id="bl-tab-projects"
              aria-selected={tab === 'projects'}
              aria-controls="bl-panel-projects"
              onClick={() => setTab('projects')}
            >
              <Icon name="projects" size={16} />
              {t(locale, 'bld.land.tab.projects')}
              <span className="bl-count-badge">{projectCount}</span>
            </button>
          )}
          <button
            type="button"
            role="tab"
            id="bl-tab-examples"
            aria-selected={tab === 'examples'}
            aria-controls="bl-panel-examples"
            onClick={() => setTab('examples')}
          >
            <Icon name="sparkle" size={16} />
            {t(locale, 'bld.land.tab.examples')}
          </button>
        </div>

        {tab === 'examples' && (
          <div role="tabpanel" id="bl-panel-examples" aria-labelledby="bl-tab-examples">
            <ul className="bl-ex-grid">
              {exampleList.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className="bl-ex"
                    data-example={x.id}
                    onClick={() => pickExample(x.id)}
                  >
                    <span className="bl-ex-art" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <span className="bl-ex-icon">
                        <Icon name={x.icon} size={22} />
                      </span>
                    </span>
                    <span className="bl-ex-body">
                      <strong>{t(locale, `bld.land.exTitle.${x.id}` as MessageKey)}</strong>
                      <span className="bl-ex-text">{exText(x.id)}</span>
                    </span>
                    <span className="bl-ex-use">
                      {t(locale, 'bld.land.use')}
                      <Icon name="arrow" size={16} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {tab === 'projects' && hasProjects && (
          <div role="tabpanel" id="bl-panel-projects" aria-labelledby="bl-tab-projects">
            {projects}
          </div>
        )}
      </section>
    </div>
  );
}
