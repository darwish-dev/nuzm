'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { dnetBody, dnetFormOf, type DnetAccountView, type DnetForm } from '../lib/dnet';
import { Note, useStaffAction } from './BillingAdminPanels';

/**
 * Admin → Domains → Registrars → DNet: the connection settings of the DNet registrar. Non-secret settings are shown and editable; the API key and secret are
 * WRITE-ONLY (never filled from the server, emptied as soon as they are sent). Saving disables the account until it is verified again. There is no DNet adapter
 * until DNet's API documentation is supplied (HG-07-03), so nothing here claims a working connection.
 */
export function DnetSettings({
  locale,
  account,
  canManage,
  mfaFactorId,
}: {
  locale: Locale;
  account: DnetAccountView | null;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(locale, mfaFactorId);
  const [f, setF] = useState<DnetForm>(() => dnetFormOf(account));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof DnetForm>(k: K, v: DnetForm[K]) => setF((p) => ({ ...p, [k]: v }));

  function save(ev: FormEvent) {
    ev.preventDefault();
    const r = dnetBody(f);
    if (!r.ok) return setErr(t(locale, `dom.dnet.err.${r.error}` as 'dom.dnet.err.label'));
    setErr(null);
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/registrars/dnet', {
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

  return (
    <form className="nz-card nzc-dense" onSubmit={save} aria-label={t(locale, 'dom.dnet.title')}>
      <div className="nzc-panel-head">
        <div>
          <h2 className="nz-h2">{t(locale, 'dom.dnet.title')}</h2>
          <p className="nz-muted">{t(locale, 'dom.dnet.help')}</p>
        </div>
        <span role="status" className="nz-row">
          <Badge tone={account?.credentialStored ? 'success' : 'warn'}>
            {account?.credentialStored
              ? t(locale, 'dom.dnet.cred.stored')
              : t(locale, 'dom.dnet.cred.none')}
          </Badge>
          <Badge tone="warn">{t(locale, 'dom.dnet.notConnected')}</Badge>
        </span>
      </div>
      <Banner tone="warn">{t(locale, 'dom.dnet.blocked')}</Banner>
      <fieldset disabled={!canManage || a.busy} className="nzc-form-grid nzc-form-grid--3">
        <Field id="dnet-label" label={t(locale, 'dom.dnet.f.label')}>
          {(x) => (
            <Input
              {...x}
              value={f.label}
              maxLength={100}
              onChange={(e) => set('label', e.target.value)}
            />
          )}
        </Field>
        <Field id="dnet-env" label={t(locale, 'dom.dnet.f.env')}>
          {(x) => (
            <Select
              {...x}
              value={f.environment}
              onChange={(e) => set('environment', e.target.value as DnetForm['environment'])}
            >
              <option value="sandbox">{t(locale, 'dom.dnet.env.sandbox')}</option>
              <option value="production">{t(locale, 'dom.dnet.env.production')}</option>
            </Select>
          )}
        </Field>
        <Field
          id="dnet-url"
          label={t(locale, 'dom.dnet.f.url')}
          help={t(locale, 'dom.dnet.f.urlHint')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://"
              value={f.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
            />
          )}
        </Field>
        <Field id="dnet-reseller" label={t(locale, 'dom.dnet.f.reseller')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              maxLength={64}
              value={f.resellerId}
              onChange={(e) => set('resellerId', e.target.value)}
            />
          )}
        </Field>
        <Field id="dnet-timeout" label={t(locale, 'dom.dnet.f.timeout')}>
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
          id="dnet-key"
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
        <Field id="dnet-secret" label={t(locale, 'dom.dnet.f.secret')}>
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
          id="dnet-vault"
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
      </div>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}
