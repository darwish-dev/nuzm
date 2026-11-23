'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  dynadotBody,
  dynadotFormOf,
  type DynadotAccountView,
  type DynadotForm,
} from '../lib/dynadot';
import { Note, useStaffAction } from './BillingAdminPanels';

/**
 * Admin → Domains → Registrars → Dynadot: the connection settings of the Dynadot registrar. Non-secret settings are shown and editable; the API key (and the optional
 * secret) are WRITE-ONLY: never filled from the server, emptied as soon as they are sent. Saving disables the account until it is tested again; "Test and enable" probes
 * the account (read-only calls) and enables it only when search and register are supported and the evidence allows it. Nothing here claims a verified connection.
 */
export function DynadotSettings({
  locale,
  account,
  canManage,
  mfaFactorId,
}: {
  locale: Locale;
  account: DynadotAccountView | null;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [f, setF] = useState<DynadotForm>(() => dynadotFormOf(account));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof DynadotForm>(k: K, v: DynadotForm[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  function save(ev: FormEvent) {
    ev.preventDefault();
    const r = dynadotBody(f);
    if (!r.ok) return setErr(t(locale, `dom.dynadot.err.${r.error}` as 'dom.dynadot.err.region'));
    setErr(null);
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/registrars/dynadot', {
          body: r.body as { environment: 'sandbox' },
        }),
      () => {
        setF((p) => ({ ...p, apiKey: '', apiSecret: '', vaultRef: '' }));
        a.setNotice({ tone: 'ok', text: t(locale, 'dom.dnet.saved') });
        router.refresh();
      },
      { 422: t(locale, 'dom.dnet.err.refused') },
    );
  }

  function verify(enable: boolean) {
    if (!account) return setErr(t(locale, 'dom.dynadot.err.noAccount'));
    setErr(null);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/registrars/{id}/verification', {
          params: { path: { id: account.id }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { enable },
        }),
      () => {
        a.setNotice({
          tone: 'ok',
          text: t(locale, enable ? 'dom.dynadot.enabled' : 'dom.dynadot.tested'),
        });
        router.refresh();
      },
      {
        422: t(locale, 'dom.dynadot.err.unsupported'),
        503: t(locale, 'dom.dynadot.err.unsupported'),
      },
    );
  }

  return (
    <form className="nz-card nzc-dense" onSubmit={save} aria-label={t(locale, 'dom.dynadot.title')}>
      <div className="nzc-panel-head">
        <div>
          <h2 className="nz-h2">{t(locale, 'dom.dynadot.title')}</h2>
          <p className="nz-muted">{t(locale, 'dom.dynadot.help')}</p>
        </div>
        <span role="status" className="nz-row">
          <Badge tone={account?.credentialStored ? 'success' : 'warn'}>
            {account?.credentialStored
              ? t(locale, 'dom.dnet.cred.stored')
              : t(locale, 'dom.dnet.cred.none')}
          </Badge>
          <Badge tone={account?.enabled ? 'success' : 'warn'}>
            {account?.enabled
              ? t(locale, 'dom.dynadot.state.enabled')
              : t(locale, 'dom.dynadot.state.disabled')}
          </Badge>
        </span>
      </div>
      <Banner tone="warn">{t(locale, 'dom.dynadot.banner')}</Banner>
      <fieldset disabled={!canManage || a.busy} className="nzc-form-grid nzc-form-grid--3">
        <Field id="dyn-label" label={t(locale, 'dom.dnet.f.label')}>
          {(x) => (
            <Input
              {...x}
              value={f.label}
              maxLength={100}
              onChange={(e) => set('label', e.target.value)}
            />
          )}
        </Field>
        <Field id="dyn-env" label={t(locale, 'dom.dnet.f.env')}>
          {(x) => (
            <Select
              {...x}
              value={f.environment}
              onChange={(e) => set('environment', e.target.value as DynadotForm['environment'])}
            >
              <option value="sandbox">{t(locale, 'dom.dnet.env.sandbox')}</option>
              <option value="production">{t(locale, 'dom.dnet.env.production')}</option>
            </Select>
          )}
        </Field>
        <Field id="dyn-timeout" label={t(locale, 'dom.dnet.f.timeout')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={f.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dyn-batch"
          label={t(locale, 'dom.dynadot.f.batch')}
          help={t(locale, 'dom.dynadot.f.batchHint')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={f.searchBatch}
              onChange={(e) => set('searchBatch', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dyn-region"
          label={t(locale, 'dom.dynadot.f.region')}
          help={t(locale, 'dom.dynadot.f.regionHint')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={40}
              autoComplete="off"
              value={f.dataRegion}
              onChange={(e) => set('dataRegion', e.target.value)}
            />
          )}
        </Field>
        <Field id="dyn-currency" label={t(locale, 'dom.dynadot.f.currency')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={3}
              autoComplete="off"
              value={f.currency}
              onChange={(e) => set('currency', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dyn-key"
          label={t(locale, 'dom.dnet.f.key')}
          help={t(locale, 'dom.dnet.f.keyHint')}
        >
          {(x) => (
            <Input
              {...x}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={400}
              value={f.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dyn-secret"
          label={t(locale, 'dom.dynadot.f.secret')}
          help={t(locale, 'dom.dynadot.f.secretHint')}
        >
          {(x) => (
            <Input
              {...x}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={400}
              value={f.apiSecret}
              onChange={(e) => set('apiSecret', e.target.value)}
            />
          )}
        </Field>
        <Field
          id="dyn-vault"
          label={t(locale, 'dom.dnet.f.vault')}
          help={t(locale, 'dom.dnet.f.vaultHint')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              placeholder="vault://"
              value={f.vaultRef}
              onChange={(e) => set('vaultRef', e.target.value)}
            />
          )}
        </Field>
      </fieldset>
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
        </p>
      )}
      <div className="nz-row">
        <Button type="submit" disabled={!canManage || a.busy}>
          {t(locale, 'dom.dnet.save')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canManage || a.busy || !account}
          onClick={() => verify(false)}
        >
          {t(locale, 'dom.dynadot.verify')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canManage || a.busy || !account}
          onClick={() => verify(true)}
        >
          {t(locale, 'dom.dynadot.verifyEnable')}
        </Button>
      </div>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
