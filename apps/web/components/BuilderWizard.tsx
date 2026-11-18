'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, ButtonLink, Field, Input } from '@nuzm/ui';
import {
  TEMPLATE_IDS,
  credits,
  type Credits,
  type Project,
  type Session,
  type Run,
  type SiteLocale,
} from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

type Step = 'describe' | 'languages' | 'template' | 'budget' | 'review';
const STEPS: Step[] = ['describe', 'languages', 'template', 'budget', 'review'];

/**
 * UI-M09-02: describe the business → languages → template → run budget → review. Submitting creates the project, then an AI session on it, then a `website`
 * run, and opens the workspace. Each stage keeps its result, so after a failure (no credits, no model provider, kill switch, residency) the retry continues
 * where it stopped and never creates a second project. The wallet is read-only here: the organization-wide AI budget is edited on the AI budgets screen.
 */
export function BuilderWizard({
  locale,
  credits: wallet,
  canRun,
}: {
  locale: Locale;
  credits: Credits | null;
  canRun: boolean;
}) {
  const router = useRouter();
  const call = useBuilderCall();
  const [step, setStep] = useState<Step>('describe');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [langs, setLangs] = useState<SiteLocale[]>(['ar', 'en']);
  const [template, setTemplate] = useState('');
  const [maxCredits, setMaxCredits] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [partial, setPartial] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const created = useRef<{ projectId?: string; sessionId?: string }>({});
  const keys = useRef({ project: newKey(), session: newKey(), run: newKey() });

  useEffect(() => heading.current?.focus(), [step]);

  const go = (s: Step) => {
    call.clear();
    setStep(s);
  };
  function toLanguages(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim().length < 1 || name.trim().length > 100)
      next.name = t(locale, 'bld.wiz.name.err');
    if (description.trim().length < 1 || description.length > 600)
      next.description = t(locale, 'bld.wiz.description.err');
    setErrs(next);
    if (Object.keys(next).length === 0) go('languages');
  }
  function toBudget(e: FormEvent) {
    e.preventDefault();
    const n = maxCredits.trim();
    if (n !== '' && !/^[1-9]\d{0,8}$/.test(n)) {
      setErrs({ maxCredits: t(locale, 'bld.wiz.budget.err') });
      return;
    }
    setErrs({});
    go('review');
  }
  const toggleLang = (l: SiteLocale) =>
    setLangs((cur) => {
      const next = cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l];
      // site languages keep the order ar, en: the first is the default language of the site
      return (['ar', 'en'] as const).filter((x) => next.includes(x));
    });

  async function submit() {
    setPartial(null);
    const c = created.current;
    if (!c.projectId) {
      const ok = await call.run(
        () =>
          bapi.post<Project>('/v1/builder/projects', {
            body: {
              type: 'website',
              name: name.trim(),
              locale: langs,
              ...(template ? { templateId: template } : {}),
            },
            idempotencyKey: keys.current.project,
          }),
        (p) => {
          c.projectId = p.id;
        },
      );
      if (!ok) return;
    }
    if (!c.sessionId) {
      const ok = await call.run(
        () =>
          bapi.post<Session>('/v1/ai/sessions', {
            body: { title: name.trim().slice(0, 200), projectId: c.projectId },
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
    const cap = maxCredits.trim();
    await call.run(
      () =>
        bapi.post<Run>('/v1/ai/runs', {
          body: {
            sessionId: c.sessionId,
            kind: 'website',
            projectId: c.projectId,
            input: { description: description.trim() },
            ...(cap ? { budget: { maxCredits: Number(cap) } } : {}),
          },
          idempotencyKey: keys.current.run,
        }),
      () => router.push(`/${locale}/builder/projects/${c.projectId}`),
      (p) => {
        // a definitive refusal frees the key (the next attempt is a new request); an uncertain network failure keeps it so a retry cannot start a second run
        if (p.status !== 599) keys.current.run = newKey();
        setPartial(c.projectId ?? null);
      },
    );
  }

  if (!canRun) return <Banner tone="warn">{t(locale, 'bld.wiz.noRunPermission')}</Banner>;

  return (
    <>
      <ol
        aria-label={t(locale, 'bld.wiz.steps')}
        className="nz-row"
        style={{ listStyle: 'none', padding: 0, margin: 0 }}
      >
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined}>
            <Badge tone={s === step ? 'success' : undefined}>
              {i + 1}. {t(locale, `bld.wiz.step.${s}`)}
            </Badge>
          </li>
        ))}
      </ol>
      <section className="nz-card" aria-labelledby="bld-wiz-h">
        <h2 className="nz-h2" id="bld-wiz-h" ref={heading} tabIndex={-1}>
          {t(locale, `bld.wiz.step.${step}`)}
        </h2>

        {step === 'describe' && (
          <form onSubmit={toLanguages} noValidate>
            <Field id="bld-name" label={t(locale, 'bld.wiz.name')} error={errs.name}>
              {(x) => (
                <Input
                  {...x}
                  value={name}
                  maxLength={100}
                  autoComplete="organization"
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field
              id="bld-desc"
              label={t(locale, 'bld.wiz.description')}
              help={t(locale, 'bld.wiz.description.help', { max: 600 })}
              error={errs.description}
            >
              {(x) => (
                <textarea
                  {...x}
                  className="nz-input"
                  rows={5}
                  maxLength={600}
                  style={{ paddingBlock: 'var(--nuzm-space-2)' }}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            <div className="nz-row">
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
          </form>
        )}

        {step === 'languages' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (langs.length === 0) return setErrs({ langs: t(locale, 'bld.wiz.languages.err') });
              setErrs({});
              go('template');
            }}
            noValidate
          >
            <fieldset aria-describedby={errs.langs ? 'bld-langs-err' : undefined}>
              <legend>{t(locale, 'bld.wiz.languages')}</legend>
              {(['ar', 'en'] as const).map((l) => (
                <p key={l}>
                  <label>
                    <input
                      type="checkbox"
                      checked={langs.includes(l)}
                      onChange={() => toggleLang(l)}
                    />{' '}
                    {t(locale, `bld.lang.${l}`)}
                  </label>
                </p>
              ))}
              <span className="nz-help">{t(locale, 'bld.wiz.languages.help')}</span>
              {errs.langs && (
                <span className="nz-error-text" id="bld-langs-err" role="alert">
                  {errs.langs}
                </span>
              )}
            </fieldset>
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('describe')}>
                {t(locale, 'bld.wiz.back')}
              </Button>
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
          </form>
        )}

        {step === 'template' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go('budget');
            }}
          >
            <fieldset>
              <legend>{t(locale, 'bld.wiz.template')}</legend>
              <p className="nz-help">{t(locale, 'bld.wiz.template.help')}</p>
              {['', ...TEMPLATE_IDS].map((id) => (
                <p key={id || 'none'}>
                  <label>
                    <input
                      type="radio"
                      name="bld-template"
                      value={id}
                      checked={template === id}
                      onChange={() => setTemplate(id)}
                    />{' '}
                    {id === '' ? t(locale, 'bld.tpl.none') : tDynamic(locale, `bld.tpl.${id}`, id)}
                  </label>
                </p>
              ))}
            </fieldset>
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('languages')}>
                {t(locale, 'bld.wiz.back')}
              </Button>
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
          </form>
        )}

        {step === 'budget' && (
          <form onSubmit={toBudget} noValidate>
            {wallet ? (
              <>
                <p>
                  {t(locale, 'bld.wiz.credits.available', {
                    credits: credits(wallet.availableCredits),
                  })}
                </p>
                {wallet.lowCredit && (
                  <Banner tone="warn">{t(locale, 'bld.wiz.credits.low')}</Banner>
                )}
              </>
            ) : (
              <p className="nz-muted">{t(locale, 'bld.wiz.credits.unknown')}</p>
            )}
            <Field
              id="bld-max"
              label={t(locale, 'bld.wiz.budget')}
              help={t(locale, 'bld.wiz.budget.help')}
              error={errs.maxCredits}
            >
              {(x) => (
                <Input
                  {...x}
                  inputMode="numeric"
                  dir="ltr"
                  value={maxCredits}
                  onChange={(e) => setMaxCredits(e.target.value)}
                />
              )}
            </Field>
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('template')}>
                {t(locale, 'bld.wiz.back')}
              </Button>
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
          </form>
        )}

        {step === 'review' && (
          <>
            <dl>
              <dt>{t(locale, 'bld.wiz.name')}</dt>
              <dd>
                <bdi dir="auto">{name}</bdi>
              </dd>
              <dt>{t(locale, 'bld.wiz.description')}</dt>
              <dd>
                <bdi dir="auto">{description}</bdi>
              </dd>
              <dt>{t(locale, 'bld.wiz.languages')}</dt>
              <dd>{langs.map((l) => t(locale, `bld.lang.${l}`)).join(' · ')}</dd>
              <dt>{t(locale, 'bld.wiz.template')}</dt>
              <dd>
                {template
                  ? tDynamic(locale, `bld.tpl.${template}`, template)
                  : t(locale, 'bld.tpl.none')}
              </dd>
              <dt>{t(locale, 'bld.wiz.budget')}</dt>
              <dd>
                {maxCredits.trim()
                  ? t(locale, 'bld.wiz.review.cap', { credits: maxCredits.trim() })
                  : t(locale, 'bld.wiz.review.noCap')}
              </dd>
            </dl>
            <p className="nz-muted">{t(locale, 'bld.wiz.review.note')}</p>
            {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
            {partial && (
              <p role="status">
                {t(locale, 'bld.wiz.partial')}{' '}
                <a href={`/${locale}/builder/projects/${partial}`}>
                  {t(locale, 'bld.wiz.openProject')}
                </a>
              </p>
            )}
            <div className="nz-row">
              <Button variant="secondary" disabled={call.busy} onClick={() => go('budget')}>
                {t(locale, 'bld.wiz.back')}
              </Button>
              <Button disabled={call.busy} aria-busy={call.busy} onClick={() => void submit()}>
                {call.busy ? t(locale, 'state.loading') : t(locale, 'bld.wiz.submit')}
              </Button>
              <ButtonLink variant="secondary" href={`/${locale}/builder/projects`}>
                {t(locale, 'action.cancel')}
              </ButtonLink>
            </div>
          </>
        )}
      </section>
    </>
  );
}
