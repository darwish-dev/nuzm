'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input } from '@nuzm/ui';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  orderLocales,
  validDescription,
  validProjectName,
} from '../lib/mobile';
import { MobileProblem } from './MobileParts';

/** `bapi` is the same-origin browser client: CSRF, organization and realm come from the first-party cookies. */
type Created = { projectId?: string; sessionId?: string };

/**
 * UI-M10-12: start a mobile app. Name + languages + a description → the project (`type: mobile`), the AI session and the `mobile` run are created in order and the
 * overview opens, where the proposed design waits for the person's approval. Each stage keeps its result: after a failure the retry continues where it stopped and never
 * creates a second project. The design comes from a model whose quality is not verified; the screen says so.
 */
export function MobileStart({ locale, canRun }: { locale: Locale; canRun: boolean }) {
  const router = useRouter();
  const call = useBuilderCall();
  const [name, setName] = useState('');
  const [langs, setLangs] = useState<string[]>(['ar', 'en']);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<{ name?: boolean; langs?: boolean; description?: boolean }>(
    {},
  );
  const [partial, setPartial] = useState(false);
  const created = useRef<Created>({});
  const keys = useRef({ project: newKey(), session: newKey(), run: newKey() });

  if (!canRun) return <Banner tone="warn">{t(locale, 'mobile.start.noPermission')}</Banner>;

  const toggle = (l: string) =>
    setLangs((cur) => orderLocales(cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (call.busy) return;
    const next = {
      name: !validProjectName(name),
      langs: langs.length === 0,
      description: !validDescription(description),
    };
    setErrors(next);
    if (next.name || next.langs || next.description) return;
    setPartial(false);
    const c = created.current;
    if (!c.projectId) {
      const ok = await call.run(
        () =>
          bapi.post<{ id: string }>('/v1/builder/projects', {
            body: { type: 'mobile', name: name.trim(), locale: orderLocales(langs) },
            idempotencyKey: keys.current.project,
          }),
        (p) => {
          c.projectId = p.id;
        },
        () => {
          keys.current.project = newKey();
        },
      );
      if (!ok) return;
    }
    if (!c.sessionId) {
      const ok = await call.run(
        () =>
          bapi.post<{ id: string }>('/v1/ai/sessions', {
            body: { title: name.trim().slice(0, 200), projectId: c.projectId },
            idempotencyKey: keys.current.session,
          }),
        (s) => {
          c.sessionId = s.id;
        },
        () => {
          setPartial(true);
        },
      );
      if (!ok) return;
    }
    await call.run(
      () =>
        bapi.post<{ id: string }>('/v1/ai/runs', {
          body: {
            sessionId: c.sessionId,
            kind: 'mobile',
            projectId: c.projectId,
            input: { description: description.trim() },
          },
          idempotencyKey: keys.current.run,
        }),
      () => router.push(`/builder/projects/${c.projectId}`),
      (p) => {
        // a definitive refusal frees the key; an uncertain network failure (599) keeps it so a retry cannot start a second run
        if (p.status !== 599) keys.current.run = newKey();
        setPartial(true);
      },
    );
  }

  return (
    <form aria-labelledby="mobile-start-h" onSubmit={(e) => void submit(e)} noValidate>
      <h2 id="mobile-start-h" className="nz-h2">
        {t(locale, 'mobile.start.hero')}
      </h2>
      <p className="nz-muted">{t(locale, 'mobile.start.sub')}</p>
      <Field
        id="mobile-name"
        label={t(locale, 'mobile.start.name')}
        help={t(locale, 'mobile.start.nameHelp')}
        error={errors.name ? t(locale, 'mobile.start.nameErr') : undefined}
      >
        {(a) => (
          <Input
            {...a}
            dir="auto"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <fieldset>
        <legend>{t(locale, 'mobile.start.languages')}</legend>
        {(['ar', 'en'] as const).map((l) => (
          <label key={l} className="nzc-prompt-check">
            <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(l)} />{' '}
            {t(locale, l === 'ar' ? 'mobile.wizard.arLabel' : 'mobile.wizard.enLabel')}
          </label>
        ))}
        {errors.langs && (
          <span className="nz-error-text" role="alert">
            {t(locale, 'mobile.start.languagesErr')}
          </span>
        )}
      </fieldset>
      <Field
        id="mobile-description"
        label={t(locale, 'mobile.start.description')}
        help={t(locale, 'mobile.start.descriptionHelp', {
          min: DESCRIPTION_MIN,
          max: DESCRIPTION_MAX,
        })}
        error={
          errors.description
            ? t(locale, 'mobile.start.descriptionErr', {
                min: DESCRIPTION_MIN,
                max: DESCRIPTION_MAX,
              })
            : undefined
        }
      >
        {(a) => (
          <textarea
            {...a}
            className="nz-input"
            dir="auto"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <Banner tone="warn">{t(locale, 'mobile.start.modelNote')}</Banner>
      <p className="nz-muted">{t(locale, 'mobile.start.next')}</p>
      <p>
        <Button type="submit" disabled={call.busy} aria-busy={call.busy}>
          {call.busy ? t(locale, 'mobile.start.busy') : t(locale, 'mobile.start.go')}
        </Button>
      </p>
      {call.problem && <MobileProblem locale={locale} problem={call.problem} />}
      {partial && !call.problem && (
        <p className="nz-error-text" role="alert">
          {t(locale, 'mobile.start.partial')}
        </p>
      )}
      {partial && call.problem && <p className="nz-muted">{t(locale, 'mobile.start.partial')}</p>}
    </form>
  );
}
