'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatMinor, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, Field, Input, Ltr } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  APP_LOCALES,
  CEILINGS,
  PROMPT_MAX,
  minorToSar,
  projectNameFrom,
  splitNames,
  validName,
  validateBudget,
  type AppLocale,
  type BudgetErrors,
} from '../lib/builder';
import { newKey } from '../lib/data';
import { TextArea } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { Note } from './DataUi';

type Step = 1 | 2 | 3;

/**
 * UI-M10-01: the app-generation wizard. Prompt → requirements review (entity and role names the person confirms) → budget (within the ceilings) → start.
 * Starting creates a web-app project, then a `webapp` run, and opens the run viewer. The prompt travels as DATA (`brief`), never as an instruction to the platform.
 */
export function AppWizard({
  locale,
  mfaFactorId,
  defaults,
  orgRemainingMinor,
}: {
  locale: Locale;
  mfaFactorId: string | null;
  defaults: { maxTokens: number; maxCostMinor: number; maxMinutes: number };
  orgRemainingMinor: number | null;
}) {
  const router = useRouter();
  const call = useBuilderCall(locale, mfaFactorId);
  const [step, setStep] = useState<Step>(1);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [locales, setLocales] = useState<AppLocale[]>([...APP_LOCALES]);
  const [entities, setEntities] = useState('');
  const [roles, setRoles] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [tokens, setTokens] = useState(String(defaults.maxTokens));
  const [cost, setCost] = useState(minorToSar(defaults.maxCostMinor));
  const [minutes, setMinutes] = useState(String(defaults.maxMinutes));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [budgetErrors, setBudgetErrors] = useState<BudgetErrors>({});
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectKey] = useState(newKey());
  const [runKey, setRunKey] = useState(newKey());
  const [problemBanner, setProblemBanner] = useState<'budget' | 'unsupported' | null>(null);

  const entityList = splitNames(entities);
  const roleList = splitNames(roles);

  function toggleLocale(l: AppLocale) {
    setLocales((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  }

  function next() {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (prompt.trim().length < 10) e.prompt = t(locale, 'm10.wiz.err.prompt');
      if (locales.length === 0) e.locales = t(locale, 'm10.wiz.err.locales');
    }
    if (step === 2) {
      if (entityList.length === 0) e.entities = t(locale, 'm10.wiz.err.entities');
      else if (entityList.some((x) => !validName(x)) || roleList.some((x) => !validName(x)))
        e.entities = t(locale, 'm10.wiz.err.names');
      if (!confirmed) e.confirm = t(locale, 'm10.wiz.err.confirm');
    }
    setErrors(e);
    if (Object.keys(e).length === 0) setStep((step + 1) as Step);
  }

  function start() {
    const v = validateBudget({ tokens, cost, minutes });
    if (!v.ok) return setBudgetErrors(v.errors);
    setBudgetErrors({});
    setProblemBanner(null);
    const brief = { prompt: prompt.trim(), locales, entities: entityList, roles: roleList };
    const createRun = (pid: string) =>
      void call.run(
        () =>
          browserApi().POST('/v1/ai/runs', {
            params: { header: { 'Idempotency-Key': runKey } },
            body: { kind: 'webapp', projectId: pid, budget: v.budget, brief },
          }),
        (run) => {
          setRunKey(newKey());
          router.push(`/${locale}/builder/projects/${pid}/runs/${run.id}`);
        },
        (f) => {
          if (f.problem.code === 'budget_required' || f.problem.status === 402)
            setProblemBanner('budget');
          if (f.problem.code === 'unsupported_capability') setProblemBanner('unsupported');
        },
      );
    if (projectId) return createRun(projectId);
    void call.run(
      () =>
        browserApi().POST('/v1/builder/projects', {
          params: { header: { 'Idempotency-Key': projectKey } },
          body: { type: 'webapp', name: name.trim() || projectNameFrom(prompt) },
        }),
      (p) => {
        setProjectId(p.id);
        createRun(p.id);
      },
      (f) => {
        if (f.problem.code === 'unsupported_capability') setProblemBanner('unsupported');
      },
    );
  }

  return (
    <div style={{ maxInlineSize: 720 }}>
      <nav aria-label={t(locale, 'm10.wiz.steps')}>
        <ol className="nz-row" style={{ listStyle: 'none', padding: 0 }}>
          {([1, 2, 3] as Step[]).map((n) => (
            <li key={n} aria-current={n === step ? 'step' : undefined}>
              <Badge tone={n === step ? 'success' : undefined}>
                {n}. {t(locale, `m10.wiz.step${n}`)}
              </Badge>
            </li>
          ))}
        </ol>
      </nav>
      <Card aria-label={t(locale, `m10.wiz.step${step}`)}>
        {step === 1 && (
          <form
            noValidate
            onSubmit={(ev) => {
              ev.preventDefault();
              next();
            }}
          >
            <h2 className="nz-h2">{t(locale, 'm10.wiz.step1')}</h2>
            <Field
              id="wiz-name"
              label={t(locale, 'm10.wiz.name')}
              help={t(locale, 'm10.wiz.nameHelp')}
            >
              {(x) => (
                <Input
                  {...x}
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field
              id="wiz-prompt"
              label={t(locale, 'm10.wiz.prompt')}
              help={t(locale, 'm10.wiz.promptData')}
              error={errors.prompt}
            >
              {(x) => (
                <TextArea
                  {...x}
                  rows={8}
                  maxLength={PROMPT_MAX}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              )}
            </Field>
            <fieldset aria-describedby={errors.locales ? 'wiz-loc-err' : undefined}>
              <legend>{t(locale, 'm10.wiz.locales')}</legend>
              {APP_LOCALES.map((l) => (
                <label key={l} className="nz-row">
                  <input
                    type="checkbox"
                    checked={locales.includes(l)}
                    onChange={() => toggleLocale(l)}
                  />
                  {t(locale, l === 'ar' ? 'm10.wiz.loc.ar' : 'm10.wiz.loc.en')}
                </label>
              ))}
              {errors.locales && (
                <span id="wiz-loc-err" role="alert" className="nz-error-text">
                  {errors.locales}
                </span>
              )}
            </fieldset>
            <p className="nz-muted">{t(locale, 'm10.wiz.mobileNote')}</p>
            <Button type="submit">{t(locale, 'action.next')}</Button>
          </form>
        )}
        {step === 2 && (
          <form
            noValidate
            onSubmit={(ev) => {
              ev.preventDefault();
              next();
            }}
          >
            <h2 className="nz-h2">{t(locale, 'm10.wiz.step2')}</h2>
            <p className="nz-muted">{t(locale, 'm10.wiz.reqHelp')}</p>
            <Field
              id="wiz-entities"
              label={t(locale, 'm10.wiz.entities')}
              help={t(locale, 'm10.wiz.listHelp')}
              error={errors.entities}
            >
              {(x) => (
                <TextArea
                  {...x}
                  rows={5}
                  value={entities}
                  onChange={(e) => {
                    setEntities(e.target.value);
                    setConfirmed(false);
                  }}
                />
              )}
            </Field>
            <Field
              id="wiz-roles"
              label={t(locale, 'm10.wiz.roles')}
              help={t(locale, 'm10.wiz.listHelp')}
            >
              {(x) => (
                <TextArea
                  {...x}
                  rows={4}
                  value={roles}
                  onChange={(e) => {
                    setRoles(e.target.value);
                    setConfirmed(false);
                  }}
                />
              )}
            </Field>
            <div aria-live="polite">
              <p>
                {t(locale, 'm10.wiz.entities')}:{' '}
                {entityList.length ? entityList.map((x) => <Badge key={x}>{x}</Badge>) : '—'}
              </p>
              <p>
                {t(locale, 'm10.wiz.roles')}:{' '}
                {roleList.length ? roleList.map((x) => <Badge key={x}>{x}</Badge>) : '—'}
              </p>
            </div>
            <label className="nz-row">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                aria-describedby={errors.confirm ? 'wiz-confirm-err' : undefined}
              />
              {t(locale, 'm10.wiz.confirmList')}
            </label>
            {errors.confirm && (
              <p id="wiz-confirm-err" role="alert" className="nz-error-text">
                {errors.confirm}
              </p>
            )}
            <div className="nz-row">
              <Button variant="secondary" onClick={() => setStep(1)}>
                {t(locale, 'm10.wiz.back')}
              </Button>
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
          </form>
        )}
        {step === 3 && (
          <form
            noValidate
            onSubmit={(ev) => {
              ev.preventDefault();
              start();
            }}
          >
            <h2 className="nz-h2">{t(locale, 'm10.wiz.step3')}</h2>
            <p className="nz-muted">
              {t(locale, 'm10.wiz.limits', {
                tokens: CEILINGS.maxTokens.toLocaleString('en-US'),
                minutes: CEILINGS.maxMinutes,
              })}
            </p>
            {orgRemainingMinor !== null && (
              <p>
                {t(locale, 'm10.wiz.credit')}:{' '}
                <Ltr>{formatMinor(String(orgRemainingMinor), 'SAR', locale)}</Ltr>
              </p>
            )}
            <Field
              id="wiz-tokens"
              label={t(locale, 'm10.wiz.tokens')}
              help={t(locale, 'm10.wiz.max', { max: CEILINGS.maxTokens.toLocaleString('en-US') })}
              error={budgetErrors.tokens ? t(locale, budgetErrors.tokens) : undefined}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="numeric"
                  value={tokens}
                  onChange={(e) => setTokens(e.target.value)}
                />
              )}
            </Field>
            <Field
              id="wiz-cost"
              label={t(locale, 'm10.wiz.cost')}
              help={t(locale, 'm10.wiz.costHelp')}
              error={budgetErrors.cost ? t(locale, budgetErrors.cost) : undefined}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              )}
            </Field>
            <Field
              id="wiz-minutes"
              label={t(locale, 'm10.wiz.minutes')}
              help={t(locale, 'm10.wiz.max', { max: CEILINGS.maxMinutes })}
              error={budgetErrors.minutes ? t(locale, budgetErrors.minutes) : undefined}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="numeric"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              )}
            </Field>
            <p className="nz-muted">{t(locale, 'm10.wiz.enforced')}</p>
            {problemBanner === 'budget' && (
              <Banner tone="warn">
                {t(locale, 'm10.err.budgetRequired')}{' '}
                <a href={`/${locale}/billing`}>{t(locale, 'm10.wiz.addCredit')}</a>
              </Banner>
            )}
            {problemBanner === 'unsupported' && (
              <Banner tone="warn">
                {t(locale, 'm10.err.unsupported')}
                {call.failure?.problem.detail ? (
                  <>
                    {' '}
                    <bdi dir="auto">{call.failure.problem.detail.slice(0, 200)}</bdi>
                  </>
                ) : null}
              </Banner>
            )}
            <Note n={problemBanner ? null : call.notice} />
            <div className="nz-row">
              <Button variant="secondary" onClick={() => setStep(2)}>
                {t(locale, 'm10.wiz.back')}
              </Button>
              <Button type="submit" disabled={call.busy}>
                {t(locale, 'm10.wiz.start')}
              </Button>
            </div>
          </form>
        )}
      </Card>
      {call.panel}
    </div>
  );
}
