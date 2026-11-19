'use client';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select } from '@nuzm/ui';
import { bapi, newKey } from '../lib/builder-client';
import { problemOf, type BuilderProblem } from '../lib/builder';
import {
  RELEASE_STEPS,
  emptyReleaseForm,
  missingItemsOf,
  releaseBody,
  releaseTone,
  stepOf,
  validateReleaseForm,
  type MobileBuild,
  type MobileRelease,
  type ReleaseForm,
  type ReleaseFormError,
  type ShotRow,
} from '../lib/mobile';
import { MissingList, MobileProblem, NoSubmitNotice } from './MobileParts';

const ERR: Record<ReleaseFormError, MessageKey> = {
  build: 'mobile.wizard.err.build',
  store: 'mobile.wizard.err.store',
  versionName: 'mobile.wizard.err.versionName',
  versionCode: 'mobile.wizard.err.versionCode',
};

/** The four steps of a release and where a record is. The third has no endpoint yet; the fourth is never an action of Nuzm. */
export function ReleaseSteps({ locale, status }: { locale: Locale; status: string | null }) {
  const at = status ? stepOf(status) : 0;
  return (
    <ol aria-label={t(locale, 'mobile.wizard.steps')}>
      {RELEASE_STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={at === i + 1 ? 'step' : undefined}
          style={at === i + 1 ? { fontWeight: 600 } : undefined}
        >
          {t(locale, `mobile.wizard.step.${s}` as MessageKey)}
        </li>
      ))}
    </ol>
  );
}

/**
 * UI-M10-17: release preparation. Everything is optional for a draft; "Mark as prepared" asks the service to check every item and shows each missing one by name.
 * The page has two buttons that save a record and NO button that sends anything anywhere: owner approval has no endpoint yet (SCR-M10B-02) and the store submission
 * is a step the person takes in the store console.
 */
export function ReleaseWizard({
  locale,
  projectId,
  builds,
  declared,
}: {
  locale: Locale;
  projectId: string;
  builds: MobileBuild[];
  declared: string[];
}) {
  const ok = builds.filter((b) => b.status === 'succeeded');
  const [f, setF] = useState<ReleaseForm>(() => ({
    ...emptyReleaseForm(declared),
    buildId: ok[0]?.id ?? '',
  }));
  const [errors, setErrors] = useState<ReleaseFormError[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BuilderProblem | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [saved, setSaved] = useState<MobileRelease | null>(null);
  const [key, setKey] = useState(newKey());

  const set = <K extends keyof ReleaseForm>(k: K, v: ReleaseForm[K]) =>
    setF((cur) => ({ ...cur, [k]: v }));
  const bi = (k: 'title' | 'shortDescription' | 'fullDescription', l: 'ar' | 'en', v: string) =>
    setF((cur) => ({ ...cur, [k]: { ...cur[k], [l]: v } }));
  const shot = (i: number, patch: Partial<ShotRow>) =>
    setF((cur) => ({
      ...cur,
      screenshots: cur.screenshots.map((s, n) => (n === i ? { ...s, ...patch } : s)),
    }));

  async function save(status: 'draft' | 'prepared') {
    if (busy) return;
    const e = validateReleaseForm(f);
    setErrors(e);
    if (e.length) return;
    setBusy(true);
    setProblem(null);
    setMissing([]);
    setSaved(null);
    let r;
    try {
      r = await bapi.post<MobileRelease>('/v1/mobile/releases', {
        body: releaseBody(projectId, f, status),
        idempotencyKey: key,
      });
    } catch {
      r = { response: { ok: false, status: 0, headers: new Headers() }, error: {} } as never;
    }
    setBusy(false);
    setKey(newKey());
    if (r.response.ok && r.data) {
      setSaved(r.data);
      setMissing(r.data.missing);
      return;
    }
    const p = problemOf(r);
    setProblem(p);
    setMissing(missingItemsOf(r.error));
  }

  if (ok.length === 0)
    return (
      <>
        <NoSubmitNotice locale={locale} />
        <EmptyState
          title={t(locale, 'mobile.wizard.buildNone')}
          body={t(locale, 'mobile.builds.empty.body')}
        />
      </>
    );

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void save('draft');
  };

  return (
    <>
      <NoSubmitNotice locale={locale} />
      <ReleaseSteps locale={locale} status={saved?.status ?? null} />
      <Banner tone="warn">{t(locale, 'mobile.wizard.ownerNote')}</Banner>
      <p>{t(locale, 'mobile.wizard.intro')}</p>
      <form onSubmit={submit} noValidate autoComplete="off">
        <Field
          id="mw-build"
          label={t(locale, 'mobile.wizard.build')}
          error={errors.includes('build') ? t(locale, ERR.build) : undefined}
        >
          {(a) => (
            <Select {...a} value={f.buildId} onChange={(e) => set('buildId', e.target.value)}>
              {ok.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(locale, 'mobile.wizard.buildOption', {
                    platform: t(locale, `mobile.platform.${b.platform}`),
                    profile: t(locale, `mobile.profile.${b.profile}`),
                    when: formatDateTime(b.createdAt, locale),
                  })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="mw-store"
          label={t(locale, 'mobile.wizard.store')}
          error={errors.includes('store') ? t(locale, ERR.store) : undefined}
        >
          {(a) => (
            <Select {...a} value={f.store} onChange={(e) => set('store', e.target.value)}>
              <option value="google_play">{t(locale, 'mobile.releases.store.google_play')}</option>
              <option value="app_store">{t(locale, 'mobile.releases.store.app_store')}</option>
            </Select>
          )}
        </Field>
        <div className="nz-row">
          <Field
            id="mw-vname"
            label={t(locale, 'mobile.wizard.versionName')}
            help={t(locale, 'mobile.wizard.versionNameHelp')}
            error={errors.includes('versionName') ? t(locale, ERR.versionName) : undefined}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                value={f.versionName}
                onChange={(e) => set('versionName', e.target.value)}
              />
            )}
          </Field>
          <Field
            id="mw-vcode"
            label={t(locale, 'mobile.wizard.versionCode')}
            help={t(locale, 'mobile.wizard.versionCodeHelp')}
            error={errors.includes('versionCode') ? t(locale, ERR.versionCode) : undefined}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                inputMode="numeric"
                value={f.versionCode}
                onChange={(e) => set('versionCode', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field
          id="mw-privacy"
          label={t(locale, 'mobile.wizard.privacy')}
          help={t(locale, 'mobile.wizard.privacyHelp')}
        >
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              type="url"
              placeholder="https://"
              value={f.privacyPolicyUrl}
              onChange={(e) => set('privacyPolicyUrl', e.target.value)}
            />
          )}
        </Field>

        <fieldset>
          <legend>{t(locale, 'mobile.wizard.permissions')}</legend>
          <p className="nz-muted">{t(locale, 'mobile.wizard.permissionsHelp')}</p>
          {Object.keys(f.permissions).map((p) => (
            <Field
              key={p}
              id={`mw-perm-${p}`}
              label={`${tDynamic(locale, `mobile.wizard.permission.${p}`, p)} — ${t(locale, 'mobile.wizard.justification')}`}
            >
              {(a) => (
                <Input
                  {...a}
                  dir="auto"
                  maxLength={300}
                  value={f.permissions[p] ?? ''}
                  onChange={(e) =>
                    setF((cur) => ({
                      ...cur,
                      permissions: { ...cur.permissions, [p]: e.target.value },
                    }))
                  }
                />
              )}
            </Field>
          ))}
        </fieldset>

        <fieldset>
          <legend>{t(locale, 'mobile.wizard.screenshots')}</legend>
          <p className="nz-muted">{t(locale, 'mobile.wizard.screenshotsHelp')}</p>
          {f.screenshots.map((s, i) => (
            <div key={i} className="nz-row">
              <Field id={`mw-shot-l-${i}`} label={t(locale, 'mobile.wizard.shotLocale')}>
                {(a) => (
                  <Select
                    {...a}
                    value={s.locale}
                    onChange={(e) => shot(i, { locale: e.target.value === 'en' ? 'en' : 'ar' })}
                  >
                    <option value="ar">{t(locale, 'mobile.wizard.arLabel')}</option>
                    <option value="en">{t(locale, 'mobile.wizard.enLabel')}</option>
                  </Select>
                )}
              </Field>
              <Field id={`mw-shot-d-${i}`} label={t(locale, 'mobile.wizard.shotDevice')}>
                {(a) => (
                  <Select
                    {...a}
                    value={s.device}
                    onChange={(e) =>
                      shot(i, { device: e.target.value === 'tablet' ? 'tablet' : 'phone' })
                    }
                  >
                    <option value="phone">{t(locale, 'mobile.wizard.device.phone')}</option>
                    <option value="tablet">{t(locale, 'mobile.wizard.device.tablet')}</option>
                  </Select>
                )}
              </Field>
              <Field id={`mw-shot-r-${i}`} label={t(locale, 'mobile.wizard.shotRef')}>
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    value={s.ref}
                    onChange={(e) => shot(i, { ref: e.target.value })}
                  />
                )}
              </Field>
              <Field id={`mw-shot-h-${i}`} label={t(locale, 'mobile.wizard.shotSha')}>
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    value={s.sha256}
                    maxLength={64}
                    onChange={(e) => shot(i, { sha256: e.target.value })}
                  />
                )}
              </Field>
              <Button
                variant="secondary"
                onClick={() =>
                  setF((cur) => ({
                    ...cur,
                    screenshots: cur.screenshots.filter((_, n) => n !== i),
                  }))
                }
              >
                {t(locale, 'mobile.wizard.shotRemove', { n: i + 1 })}
              </Button>
            </div>
          ))}
          <p>
            <Button
              variant="secondary"
              onClick={() =>
                setF((cur) => ({
                  ...cur,
                  screenshots: [
                    ...cur.screenshots,
                    { locale: 'ar', device: 'phone', ref: '', sha256: '' },
                  ],
                }))
              }
            >
              {t(locale, 'mobile.wizard.shotAdd')}
            </Button>
          </p>
        </fieldset>

        <fieldset>
          <legend>{t(locale, 'mobile.wizard.compliance')}</legend>
          {(Object.keys(f.compliance) as (keyof ReleaseForm['compliance'])[]).map((k) => (
            <label key={k} className="nzc-prompt-check" style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={f.compliance[k]}
                onChange={(e) =>
                  setF((cur) => ({
                    ...cur,
                    compliance: { ...cur.compliance, [k]: e.target.checked },
                  }))
                }
              />{' '}
              {t(locale, `mobile.wizard.compliance.${k}` as MessageKey)}
            </label>
          ))}
          <Field id="mw-iap" label={t(locale, 'mobile.wizard.iap')}>
            {(a) => (
              <Select
                {...a}
                value={f.iapPolicy}
                onChange={(e) =>
                  set(
                    'iapPolicy',
                    e.target.value === 'not_applicable'
                      ? 'not_applicable'
                      : e.target.value === 'assessed'
                        ? 'assessed'
                        : '',
                  )
                }
              >
                <option value="">{t(locale, 'mobile.wizard.iap.none')}</option>
                <option value="not_applicable">
                  {t(locale, 'mobile.wizard.iap.not_applicable')}
                </option>
                <option value="assessed">{t(locale, 'mobile.wizard.iap.assessed')}</option>
              </Select>
            )}
          </Field>
          {f.iapPolicy === 'assessed' && (
            <Field id="mw-iap-ref" label={t(locale, 'mobile.wizard.iap.ref')}>
              {(a) => (
                <Input
                  {...a}
                  dir="auto"
                  maxLength={200}
                  value={f.iapAssessmentRef}
                  onChange={(e) => set('iapAssessmentRef', e.target.value)}
                />
              )}
            </Field>
          )}
        </fieldset>

        <fieldset>
          <legend>{t(locale, 'mobile.wizard.metadata')}</legend>
          <p className="nz-muted">{t(locale, 'mobile.wizard.copyHint')}</p>
          {(['title', 'shortDescription', 'fullDescription'] as const).map((k) =>
            (['ar', 'en'] as const).map((l) => (
              <Field
                key={`${k}-${l}`}
                id={`mw-${k}-${l}`}
                label={`${t(locale, `mobile.wizard.${k}`)} (${t(locale, l === 'ar' ? 'mobile.wizard.arLabel' : 'mobile.wizard.enLabel')})`}
              >
                {(a) =>
                  k === 'fullDescription' ? (
                    <textarea
                      {...a}
                      className="nz-input"
                      rows={4}
                      lang={l}
                      dir={l === 'ar' ? 'rtl' : 'ltr'}
                      maxLength={4000}
                      value={f[k][l]}
                      onChange={(e) => bi(k, l, e.target.value)}
                    />
                  ) : (
                    <Input
                      {...a}
                      lang={l}
                      dir={l === 'ar' ? 'rtl' : 'ltr'}
                      maxLength={k === 'title' ? 30 : 80}
                      value={f[k][l]}
                      onChange={(e) => bi(k, l, e.target.value)}
                    />
                  )
                }
              </Field>
            )),
          )}
          <Field id="mw-support" label={t(locale, 'mobile.wizard.supportUrl')}>
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                type="url"
                placeholder="https://"
                value={f.supportUrl}
                onChange={(e) => set('supportUrl', e.target.value)}
              />
            )}
          </Field>
        </fieldset>

        <p className="nz-row">
          <Button type="submit" disabled={busy} aria-busy={busy}>
            {t(locale, 'mobile.wizard.saveDraft')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void save('prepared')}>
            {t(locale, 'mobile.wizard.savePrepared')}
          </Button>
        </p>
      </form>

      {problem && <MobileProblem locale={locale} problem={problem} items={missing} />}
      {saved && (
        <section aria-live="polite" aria-labelledby="mw-saved-h">
          <h2 className="nz-h2" id="mw-saved-h">
            {t(locale, 'mobile.wizard.saved')}
          </h2>
          <p>
            <Badge tone={releaseTone(saved.status)}>
              {tDynamic(locale, `mobile.releases.status.${saved.status}`, saved.status)}
            </Badge>{' '}
            <Ltr>{`${saved.versionName} (${saved.versionCode})`}</Ltr>
          </p>
          {saved.status === 'draft' && (
            <>
              <h3>{t(locale, 'mobile.releases.missing')}</h3>
              <MissingList locale={locale} items={missing} />
            </>
          )}
        </section>
      )}
    </>
  );
}
