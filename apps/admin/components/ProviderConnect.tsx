'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { CREDENTIAL_PROVIDERS, credentialsBody, kindsOf } from '../lib/provider-credentials';
import type { ProviderDto } from '../lib/providers';
import { Note, useStaffAction } from './BillingAdminPanels';

/** The key inputs of one provider and key kind. Every input is write-only: type=password, never filled from the server, emptied once sent. */
function KeyFields(p: {
  locale: Locale;
  idPrefix: string;
  providerKey: string;
  kind: string;
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
}) {
  const fields = kindsOf(p.providerKey).find((k) => k.id === p.kind)?.fields ?? [];
  return (
    <>
      {fields.map((f) => (
        <Field
          key={`${p.providerKey}-${f}`}
          id={`${p.idPrefix}-${f}`}
          label={tDynamic(p.locale, `prov.cred.f.${f}`, f)}
        >
          {(x) => (
            <Input
              {...x}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={400}
              value={p.values[f] ?? ''}
              onChange={(e) => p.onChange(f, e.target.value)}
            />
          )}
        </Field>
      ))}
    </>
  );
}

const noValues: Record<string, string> = {};

/**
 * Admin → Providers → Accounts: connect Contabo, Huawei Cloud or Alibaba Cloud with the keys typed here. The keys are write-only (sealed on the server, only a vault reference is
 * kept); the region notes say what the platform will and will not claim until the provider's own probe shows it.
 */
export function ConnectProviderForm(p: {
  locale: Locale;
  providers: ProviderDto[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const choices = p.providers.filter((v) => CREDENTIAL_PROVIDERS.includes(v.key));
  const [providerId, setProviderId] = useState(choices[0]?.id ?? '');
  const providerKey = choices.find((v) => v.id === providerId)?.key ?? '';
  const [kind, setKind] = useState('keypair');
  const [name, setName] = useState('');
  const [values, setValues] = useState(noValues);
  const [err, setErr] = useState<string | null>(null);
  if (choices.length === 0) return null;
  const kinds = kindsOf(providerKey);
  const activeKind = kinds.some((k) => k.id === kind) ? kind : (kinds[0]?.id ?? 'keypair');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return setErr(t(p.locale, 'prov.cred.err.name'));
    const credentials = credentialsBody(providerKey, activeKind, values);
    if (!credentials) return setErr(t(p.locale, 'prov.cred.err.field'));
    setErr(null);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/provider-accounts/connect', {
          body: { providerId, name: name.trim(), credentials },
        }),
      () => {
        setValues(noValues);
        setName('');
        a.setNotice({ tone: 'ok', text: t(p.locale, 'prov.cred.saved') });
        router.refresh();
      },
      { 409: t(p.locale, 'prov.cred.err.conflict'), 422: t(p.locale, 'prov.cred.err.refused') },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(p.locale, 'prov.cred.title')}
      noValidate
    >
      <h2 className="nz-h2">{t(p.locale, 'prov.cred.title')}</h2>
      <p className="nz-muted">{t(p.locale, 'prov.cred.help')}</p>
      <fieldset disabled={a.busy} className="nzc-form-grid nzc-form-grid--3">
        <Field id="pc-provider" label={t(p.locale, 'prov.cred.provider')}>
          {(x) => (
            <Select
              {...x}
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setValues(noValues);
              }}
            >
              {choices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.key}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="pc-name" label={t(p.locale, 'prov.cred.name')}>
          {(x) => (
            <Input {...x} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        {kinds.length > 1 && (
          <Field id="pc-kind" label={t(p.locale, 'prov.cred.type')}>
            {(x) => (
              <Select
                {...x}
                value={activeKind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setValues(noValues);
                }}
              >
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {t(p.locale, k.id === 'iam' ? 'prov.cred.type.iam' : 'prov.cred.type.keypair')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <KeyFields
          locale={p.locale}
          idPrefix="pc"
          providerKey={providerKey}
          kind={activeKind}
          values={values}
          onChange={(f, v) => setValues((s) => ({ ...s, [f]: v }))}
        />
      </fieldset>
      {providerKey && (
        <Banner tone="warn">{tDynamic(p.locale, `prov.cred.hint.${providerKey}`, '')}</Banner>
      )}
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'prov.cred.submit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

/** Account page: replace the keys of one account (rotation). The account must be verified again afterwards. */
export function ReplaceCredentialsForm(p: {
  locale: Locale;
  accountId: string;
  providerKey: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const kinds = kindsOf(p.providerKey);
  const [kind, setKind] = useState(kinds[0]?.id ?? 'keypair');
  const [values, setValues] = useState(noValues);
  const [err, setErr] = useState<string | null>(null);
  if (kinds.length === 0) return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const credentials = credentialsBody(p.providerKey, kind, values);
    if (!credentials) return setErr(t(p.locale, 'prov.cred.err.field'));
    setErr(null);
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/provider-accounts/{id}/credentials', {
          params: { path: { id: p.accountId } },
          body: { credentials },
        }),
      () => {
        setValues(noValues);
        a.setNotice({ tone: 'ok', text: t(p.locale, 'prov.cred.rotated') });
        router.refresh();
      },
      { 422: t(p.locale, 'prov.cred.err.refused') },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(p.locale, 'prov.cred.rotate')}
      noValidate
    >
      <h2 className="nz-h2">{t(p.locale, 'prov.cred.rotate')}</h2>
      <p className="nz-muted">{t(p.locale, 'prov.cred.help')}</p>
      <fieldset disabled={a.busy} className="nzc-form-grid nzc-form-grid--3">
        {kinds.length > 1 && (
          <Field id="rc-kind" label={t(p.locale, 'prov.cred.type')}>
            {(x) => (
              <Select
                {...x}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setValues(noValues);
                }}
              >
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {t(p.locale, k.id === 'iam' ? 'prov.cred.type.iam' : 'prov.cred.type.keypair')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <KeyFields
          locale={p.locale}
          idPrefix="rc"
          providerKey={p.providerKey}
          kind={kind}
          values={values}
          onChange={(f, v) => setValues((s) => ({ ...s, [f]: v }))}
        />
      </fieldset>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'prov.cred.rotateSubmit')}
      </Button>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
