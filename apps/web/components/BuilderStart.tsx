'use client';
import { PROJECT_PROMPT_MAX } from '../lib/appbuilder';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Icon } from '@nuzm/ui';
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
import { BuilderHistory } from './BuilderHistory';
import { TemplatesButton, type StartTemplate } from './StartTemplates';
import { GithubPicker, SourceChip, SourceMenu, readLocalSource } from './StartSources';
import { MAX_IMPORT_FILES, batchPatches, type StartSource } from '../lib/start-sources';

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

const MAX_PROMPT = PROJECT_PROMPT_MAX;
/** the share of a description's term groups a Knowledge Library template must match before a project starts from it automatically */
export const LIBRARY_MIN_COVERAGE = 0.4;
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
  templatesEnabled = false,
  initialType = 'website',
  githubEnabled = false,
}: {
  locale: Locale;
  /** AI Studio is on for the organization: a project can start from a GitHub repository (its GitHub App connection) */
  githubEnabled?: boolean;
  credits: Credits | null;
  canRun: boolean;
  /** the organization has `app_builder.enabled`: the web-app tile can be started */
  appsEnabled?: boolean;
  /** the organization has `mobile_builder.enabled`: the mobile-app tile can be started (it opens the mobile preview) */
  mobileEnabled?: boolean;
  /** the organization has `knowledge.customer_templates`: a link offers the template gallery (S-K7) */
  templatesEnabled?: boolean;
  initialType?: StartType;
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
  const box = useRef<HTMLTextAreaElement>(null);
  const opts = useRef<HTMLDetailsElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  // where the project starts from: nothing (the prompt alone), the person's files or a GitHub repository
  const [source, setSource] = useState<StartSource | null>(null);
  const [ghOpen, setGhOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const created = useRef<{
    projectId?: string;
    headVersionId?: string | null;
    sessionId?: string;
    requestStored?: boolean;
    /** import batches already applied (a retry continues after them) */
    importedBatches?: number;
    imported?: boolean;
    linked?: boolean;
    versionId?: string | null;
    /** the Knowledge Library was asked once for this request; `libraryPick` is what it selected (null: nothing suitable, generate from scratch) */
    libraryChecked?: boolean;
    libraryPick?: { resourceId: string; versionId: string } | null;
    planId?: string;
  }>({});
  const importKeys = useRef<string[]>([]);
  const keys = useRef({ project: newKey(), session: newKey(), message: newKey(), run: newKey() });
  const types = startTypes(appsEnabled, mobileEnabled);
  // imported code is never a website (a site model, no free file tree): it becomes a web app, or a mobile app for a Flutter project
  const effectiveType: StartType = source
    ? source.kind === 'local' && source.type === 'mobile' && mobileEnabled
      ? 'mobile'
      : 'webapp'
    : type;
  const startable = types.find((x) => x.id === effectiveType)?.available === true;

  async function pickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setReading(true);
    setErr('');
    const r = await readLocalSource(list);
    setReading(false);
    if (r === 'empty') return setErr(t(locale, 'bld.src.empty'));
    if ('tooMany' in r)
      return setErr(
        t(locale, 'bld.src.tooMany', {
          count: r.tooMany.toLocaleString(locale === 'ar' ? 'ar-SA' : 'en'),
          max: MAX_IMPORT_FILES.toLocaleString(locale === 'ar' ? 'ar-SA' : 'en'),
        }),
      );
    choose(r);
  }
  function choose(next: StartSource | null) {
    setSource(next);
    setGhOpen(false);
    // a new source means a new import: the keys of the old one must not be reused
    created.current = {};
    keys.current = { project: newKey(), session: newKey(), message: newKey(), run: newKey() };
    importKeys.current = [];
    if (next)
      setType(
        next.kind === 'local' && next.type === 'mobile' && mobileEnabled ? 'mobile' : 'webapp',
      );
    box.current?.focus({ preventScroll: true });
  }

  const toggleLang = (l: SiteLocale) =>
    setLangs((cur) => {
      const next = cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l];
      // site languages keep the order ar, en: the first is the default language of the site
      return (['ar', 'en'] as const).filter((x) => next.includes(x));
    });

  /** A template from the Templates popup: its type, its description in the prompt (to read and edit), and for a website its bilingual site template. */
  function pickTemplate(tpl: StartTemplate) {
    choose(null);
    setType(tpl.kind);
    setTemplate(tpl.siteTemplate ?? '');
    setPrompt(t(locale, tpl.prompt));
    setErr('');
    box.current?.focus({ preventScroll: true });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (call.busy || !startable) return;
    const text = prompt.trim();
    if ((!source && text.length < 1) || text.length > MAX_PROMPT) {
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
    // a description with no imported source and no built-in starter chosen first asks the approved Knowledge Library for a fitting template: when one is selected,
    // the project starts from its source and the AI adapts it to the whole description (the checked template path: copy, plan, one adaptation run)
    if (
      text &&
      !source &&
      !template &&
      appsEnabled &&
      (effectiveType === 'website' || effectiveType === 'webapp') &&
      (await startFromLibrary(text, cap))
    )
      return;
    if (!c.projectId) {
      const base = nameFromPrompt(
        text ||
          (source?.kind === 'github' ? source.fullName.split('/').pop()! : source?.label) ||
          '',
      );
      for (let attempt = 0; attempt < 3 && !c.projectId; attempt++) {
        const name = attempt === 0 ? base : `${base.slice(0, 90)} ${attempt + 1}`;
        let taken = false;
        const ok = await call.run(
          () =>
            bapi.post<Project>('/v1/builder/projects', {
              body: {
                type: effectiveType,
                name,
                locale: langs,
                ...(effectiveType === 'website' && template ? { templateId: template } : {}),
              },
              idempotencyKey: keys.current.project,
            }),
          (p) => {
            c.projectId = p.id;
            c.headVersionId = p.headVersionId;
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
    if (source && !c.imported) {
      const ok = await importSource(source);
      if (!ok) {
        setPartial(c.projectId ?? null);
        return;
      }
    }
    // with a source and no words, the project opens with the imported code: no AI run is started
    if (!text) {
      router.push(`/builder/projects/${c.projectId}`);
      return;
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
    if (effectiveType === 'mobile' && !c.requestStored) {
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
            kind: effectiveType,
            projectId: c.projectId,
            // the person's words travel as DATA: `brief.prompt` for an app, `description` for a website
            input:
              effectiveType === 'webapp'
                ? { brief: { prompt: text, locales: langs } }
                : { description: text },
            ...(cap ? { budget: { maxCredits: Number(cap) } } : {}),
          },
          idempotencyKey: keys.current.run,
        }),
      // every project type opens in the same workspace (a mobile app in its mobile mode)
      () => router.push(`/builder/projects/${c.projectId}`),
      (p) => {
        // a definitive refusal frees the key (the next attempt is a new request); an uncertain network failure keeps it so a retry cannot start a second run
        if (p.status !== 599) keys.current.run = newKey();
        setPartial(c.projectId ?? null);
      },
    );
  }

  /**
   * Asks the Knowledge Library (published, active, licence-cleared templates only; the server applies those filters and records the decision and its reasons) for a
   * template that fits the description. Returns false when there is none (the normal generation goes on), true when this path took over (started, or stopped with
   * its own message).
   */
  async function startFromLibrary(text: string, cap: string): Promise<boolean> {
    const c = created.current;
    if (!c.libraryChecked) {
      const rec = await bapi.post<{ selected?: { resourceId: string; versionId: string } | null }>(
        '/v1/builder/template-recommendations',
        // a template must match the words of the request, not only its structure: at least 40% of the requirement's term groups (the server drops a weaker pick
        // and records why); below that the project is generated from scratch in the type the person chose
        {
          body: {
            text,
            platform: 'WEB',
            mode: 'ADAPTIVE',
            limit: 3,
            minFunctionalCoverage: LIBRARY_MIN_COVERAGE,
          },
        },
      );
      c.libraryChecked = true;
      // the library is off for this organization (404), or it found nothing suitable: generate from scratch as before
      c.libraryPick =
        rec.response.ok && rec.data?.selected
          ? { resourceId: rec.data.selected.resourceId, versionId: rec.data.selected.versionId }
          : null;
    }
    const pick = c.libraryPick;
    if (!pick) return false;
    if (!c.projectId) {
      const base = nameFromPrompt(text);
      for (let attempt = 0; attempt < 3 && !c.projectId; attempt++) {
        const name = attempt === 0 ? base : `${base.slice(0, 90)} ${attempt + 1}`;
        let taken = false;
        const ok = await call.run(
          () =>
            bapi.post<{ project: { id: string } }>('/v1/builder/projects/from-template', {
              body: {
                resourceId: pick.resourceId,
                versionId: pick.versionId,
                name,
                adaptationMode: 'ADAPTIVE',
              },
              idempotencyKey: keys.current.project,
            }),
          (r) => {
            c.projectId = r.project.id;
          },
          (p) => {
            if (p.code === 'name_taken' && attempt < 2) {
              taken = true;
              keys.current.project = newKey();
              return true;
            }
          },
        );
        if (!ok && !taken) return true;
      }
      if (!c.projectId) return true;
    }
    if (!c.planId) {
      const ok = await call.run(
        () =>
          bapi.post<{ id: string }>('/v1/builder/generation-plans', {
            // the whole description is the requirement (never shortened)
            body: { projectId: c.projectId, text, platform: 'WEB', mode: 'ADAPTIVE' },
            idempotencyKey: keys.current.session,
          }),
        (p) => {
          c.planId = p.id;
        },
        () => {
          setPartial(c.projectId ?? null);
        },
      );
      if (!ok) return true;
    }
    await call.run(
      () =>
        bapi.post(`/v1/builder/generation-plans/${c.planId}/runs`, {
          body: cap ? { budget: { maxCredits: Number(cap) } } : {},
          idempotencyKey: keys.current.run,
        }),
      () => router.push(`/builder/projects/${c.projectId}`),
      (p) => {
        if (p.status !== 599) keys.current.run = newKey();
        setPartial(c.projectId ?? null);
      },
    );
    return true;
  }

  /** Brings the chosen source into the new project. Local files: change sets through the safe-diff pipeline, chained on the version each one creates
   *  (a retry continues after the batches already applied). GitHub: link the repository, then pull it (the same checks apply). */
  async function importSource(src: StartSource): Promise<boolean> {
    const c = created.current;
    const pid = c.projectId!;
    if (src.kind === 'github') {
      if (!c.linked) {
        let already = false;
        const linked = await call.run(
          () =>
            bapi.post(`/v1/builder/projects/${pid}/github/link`, {
              body: { fullName: src.fullName },
            }),
          () => undefined,
          // an earlier attempt already linked this project
          (p) => {
            if (p.code === 'conflict') {
              already = true;
              return true;
            }
          },
        );
        if (!linked && !already) return false;
        c.linked = true;
      }
      const pulled = await call.run(
        () => bapi.post(`/v1/builder/projects/${pid}/github/pull`, { body: {} }),
        () => undefined,
      );
      if (pulled) c.imported = true;
      return pulled;
    }
    const batches = batchPatches(src.files);
    if (c.versionId === undefined) c.versionId = c.headVersionId ?? null;
    for (let i = c.importedBatches ?? 0; i < batches.length; i++) {
      setProgress({ done: i, total: batches.length });
      importKeys.current[i] ??= newKey();
      const ok = await call.run(
        () =>
          bapi.post<{ versionId: string }>(`/v1/builder/projects/${pid}/changes`, {
            body: {
              baseVersion: c.versionId,
              patches: batches[i],
              message:
                batches.length > 1
                  ? `Import ${src.label} (${i + 1}/${batches.length})`
                  : `Import ${src.label}`,
            },
            idempotencyKey: importKeys.current[i],
          }),
        (d) => {
          c.versionId = d.versionId;
          c.importedBatches = i + 1;
        },
      );
      if (!ok) {
        setProgress(null);
        return false;
      }
    }
    setProgress(null);
    c.imported = true;
    return true;
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  };

  if (!canRun) return <Banner tone="warn">{t(locale, 'bld.wiz.noRunPermission')}</Banner>;

  const typeName = (id: StartType) => t(locale, `bld.start.type.${id}` as MessageKey);

  return (
    <div className="bl">
      <BuilderHistory locale={locale} canChat={canRun} />
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
            {source && <SourceChip locale={locale} source={source} onRemove={() => choose(null)} />}
            <label className="nz-sr" htmlFor="bld-prompt">
              {t(locale, 'bld.start.promptLabel')}
            </label>
            <textarea
              id="bld-prompt"
              ref={box}
              className="bl-input"
              dir="auto"
              rows={4}
              value={prompt}
              placeholder={
                source ? t(locale, 'bld.src.promptOptional') : t(locale, 'bld.start.placeholder')
              }
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? 'bld-prompt-err' : 'bld-prompt-hint'}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (err) setErr('');
                // other words, another search: the library is asked again unless a project was already made for this request
                if (!created.current.projectId) created.current.libraryChecked = false;
              }}
              onKeyDown={onKey}
            />
            <div className="bl-prompt-foot">
              <SourceMenu
                locale={locale}
                appsEnabled={appsEnabled}
                githubEnabled={githubEnabled}
                onFolder={() => folderInput.current?.click()}
                onFiles={() => filesInput.current?.click()}
                onGithub={() => setGhOpen(true)}
              />
              <TemplatesButton
                locale={locale}
                initialKind={effectiveType}
                available={{
                  website: true,
                  webapp: appsEnabled,
                  mobile: mobileEnabled,
                }}
                onPick={pickTemplate}
              />
              <input
                ref={folderInput}
                type="file"
                hidden
                multiple
                {...{ webkitdirectory: '', directory: '' }}
                onChange={(e) => {
                  void pickFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <input
                ref={filesInput}
                type="file"
                hidden
                multiple
                onChange={(e) => {
                  void pickFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <span
                className="bl-count"
                id="bld-prompt-hint"
                data-over={prompt.trim().length > MAX_PROMPT || undefined}
              >
                <bdi dir="ltr">
                  {prompt.length}/{MAX_PROMPT}
                </bdi>{' '}
                · <bdi dir="ltr">Ctrl / ⌘ + Enter</bdi> {t(locale, 'bld.start.keys')}
              </span>
              <button
                className="bl-go"
                type="submit"
                disabled={call.busy || reading || !startable}
                aria-busy={call.busy}
              >
                <span>
                  {progress
                    ? t(locale, 'bld.src.importing', {
                        done: progress.done,
                        total: progress.total,
                      })
                    : call.busy
                      ? t(locale, 'state.loading')
                      : source && !prompt.trim()
                        ? t(locale, 'bld.src.open')
                        : t(locale, 'bld.start.go')}
                </span>
                <Icon name="arrow" size={18} />
              </button>
            </div>
          </div>
          {err && (
            <p className="nz-error-text bl-err" id="bld-prompt-err" role="alert">
              {err}
            </p>
          )}
          {reading && (
            <p className="bl-note" role="status" aria-busy="true">
              {t(locale, 'bld.src.reading')}
            </p>
          )}
          {ghOpen && (
            <GithubPicker
              locale={locale}
              onPick={(r) => choose({ kind: 'github', fullName: r.fullName, private: r.private })}
              onClose={() => setGhOpen(false)}
            />
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
                    checked={effectiveType === x.id}
                    disabled={Boolean(source) && x.id === 'website'}
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
              {t(locale, 'bld.start.soonNote', { type: typeName(effectiveType) })}
            </p>
          )}

          <details className="bl-opts" ref={opts}>
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
              {effectiveType === 'website' && (
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
          {templatesEnabled && (
            <p className="bl-note">
              <a href={`/${locale}/builder/templates`}>{t(locale, 'tpl.start.link')}</a>
            </p>
          )}
        </form>

        {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
        {partial && (
          <p role="status" className="bl-note">
            {t(locale, 'bld.wiz.partial')}{' '}
            <a href={`/builder/projects/${partial}`}>{t(locale, 'bld.wiz.openProject')}</a>
          </p>
        )}
      </section>
    </div>
  );
}
