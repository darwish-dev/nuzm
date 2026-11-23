'use client';
import { useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Banner, Button, ButtonLink, Card, Field, Input, Ltr, Select } from '@nuzm/ui';
import { problemOf } from '../lib/builder';
import { bapi, newKey } from '../lib/builder-client';
import {
  MODES,
  defaultProjectName,
  reasonLabel,
  reasonsOf,
  startProblemKey,
  type AdaptationMode,
  type FromTemplateResult,
} from '../lib/templates';

/**
 * "Start a project from this template" (S-K7). The pinned version the customer is looking at is what gets copied, into a NEW web-app project of the organization; the
 * template never changes. A refusal is shown by its reason (never raw server text) and nothing is created. The same action keeps its `Idempotency-Key`; changing the name
 * or the mode is a new action and takes a new one.
 */
export function TemplateStart({
  locale,
  resourceId,
  versionId,
  versionSeq,
  templateName,
  canWrite,
  appsEnabled,
  generationEnabled = false,
}: {
  locale: Locale;
  resourceId: string;
  versionId: string;
  versionSeq?: number;
  templateName: string;
  /** `builder:write` */
  canWrite: boolean;
  /** `app_builder.enabled` for the organization: a copy is a web-app project */
  appsEnabled: boolean;
  /** `knowledge.generation` is on for the organization: the result links to the template workspace (S-K6) */
  generationEnabled?: boolean;
}) {
  const [name, setName] = useState(defaultProjectName(templateName));
  const [mode, setMode] = useState<AdaptationMode>('ADAPTIVE');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<FromTemplateResult | null>(null);
  const [failure, setFailure] = useState<{
    key: MessageKey;
    reasons: string[];
    trace?: string;
  } | null>(null);
  const key = useRef(newKey());
  const fresh = () => {
    key.current = newKey();
    setFailure(null);
  };

  if (!canWrite || !appsEnabled)
    return (
      <Card aria-labelledby="tpl-start-h">
        <h2 className="nz-h2" id="tpl-start-h">
          {t(locale, 'tpl.start.title')}
        </h2>
        <p className="nz-muted" role="status">
          {t(locale, canWrite ? 'tpl.start.appsOff' : 'tpl.start.readonly')}
        </p>
      </Card>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || n.length > 100 || busy) return;
    setBusy(true);
    setFailure(null);
    const r = await bapi.post<FromTemplateResult>('/v1/builder/projects/from-template', {
      body: { resourceId, versionId, name: n, adaptationMode: mode },
      idempotencyKey: key.current,
    });
    setBusy(false);
    if (r.response.ok && r.data) {
      setDone(r.data);
      return;
    }
    const p = problemOf(r);
    const reasons = reasonsOf(r.error);
    setFailure({ key: startProblemKey(p, reasons), reasons, trace: p.traceId });
  }

  if (done) {
    const skipped = done.files?.skipped ?? [];
    return (
      <Card aria-labelledby="tpl-done-h" data-testid="tpl-done">
        <h2 className="nz-h2" id="tpl-done-h" tabIndex={-1} ref={(el) => el?.focus()}>
          {t(locale, 'tpl.done.title')}
        </h2>
        <p role="status">
          {t(locale, 'tpl.done.body', {
            copied: done.files?.copied ?? 0,
            name: done.project?.name ?? name,
          })}
        </p>
        <p className="nz-muted">
          {done.license?.spdx
            ? t(locale, 'tpl.done.license', { spdx: done.license.spdx })
            : t(locale, 'tpl.done.license.none')}
        </p>
        {skipped.length > 0 && (
          <>
            <p>{t(locale, 'tpl.done.skipped', { n: skipped.length })}</p>
            <ul className="kni-list">
              {skipped.slice(0, 20).map((s) => (
                <li key={s.path ?? ''}>
                  <Ltr>{s.path}</Ltr> —{' '}
                  {tDynamic(locale, `tpl.done.skip.${s.reason ?? ''}`, s.reason ?? '')}
                </li>
              ))}
            </ul>
          </>
        )}
        {done.project?.id && (
          <p>
            <ButtonLink href={`/${locale}/builder/projects/${done.project.id}`}>
              {t(locale, 'tpl.done.open')}
            </ButtonLink>{' '}
            {generationEnabled && (
              <ButtonLink
                variant="secondary"
                href={`/${locale}/builder/projects/${done.project.id}/template`}
              >
                {t(locale, 'gen.link')}
              </ButtonLink>
            )}
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card aria-labelledby="tpl-start-h">
      <h2 className="nz-h2" id="tpl-start-h">
        {t(locale, 'tpl.start.title')}
      </h2>
      <p className="nz-muted">{t(locale, 'tpl.start.intro', { n: versionSeq ?? 1 })}</p>
      <form onSubmit={submit} className="knd" aria-busy={busy}>
        <Field
          id="tpl-name"
          label={t(locale, 'tpl.start.name')}
          help={t(locale, 'tpl.start.name.help')}
        >
          {(a) => (
            <Input
              {...a}
              value={name}
              maxLength={100}
              required
              onChange={(e) => {
                setName(e.target.value);
                fresh();
              }}
            />
          )}
        </Field>
        <Field
          id="tpl-mode"
          label={t(locale, 'tpl.start.mode')}
          help={t(locale, `tpl.start.mode.help.${mode}` as MessageKey)}
        >
          {(a) => (
            <Select
              {...a}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as AdaptationMode);
                fresh();
              }}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(locale, `kr.mode.${m}` as MessageKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {failure && (
          <Banner tone="danger">
            <span role="alert">
              {t(locale, failure.key)}
              {failure.reasons.length > 0 && (
                <>
                  {' '}
                  {t(locale, 'tpl.err.reasons')}{' '}
                  {failure.reasons.map((r) => reasonLabel(locale, r)).join('، ')}
                </>
              )}
              {failure.trace && (
                <>
                  {' '}
                  <Ltr>{failure.trace}</Ltr>
                </>
              )}
            </span>
          </Banner>
        )}
        <div>
          <Button type="submit" disabled={busy || name.trim().length === 0}>
            {busy ? t(locale, 'tpl.start.busy') : t(locale, 'tpl.start.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
