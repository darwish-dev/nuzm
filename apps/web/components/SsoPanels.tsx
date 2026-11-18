'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { JIT_ROLES, createSsoBody, type SsoFields } from '../lib/sso';
import { NoticeText } from './Feedback';

const key = () => crypto.randomUUID();
const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={5} {...p} />
);

/** A read-only value (a DNS record name or value, an entity id) with a copy button. The value is shown left-to-right inside RTL text. */
export function CopyValue(p: { locale: Locale; id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(p.value);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the value stays selectable in the field
    }
  }
  return (
    <Field id={p.id} label={p.label}>
      {(x) => (
        <div className="nz-row">
          <Input
            {...x}
            readOnly
            dir="ltr"
            value={p.value}
            style={{ flex: 1, minInlineSize: 220 }}
          />
          <Button
            variant="secondary"
            aria-label={t(p.locale, 'm12.sso.copyLabel', { label: p.label })}
            onClick={() => void copy()}
          >
            {t(p.locale, 'action.copy')}
          </Button>
          {copied && <span role="status">{t(p.locale, 'm12.sso.copied')}</span>}
        </div>
      )}
    </Field>
  );
}

/** Create a connection: SAML (metadata XML or URL) or OIDC (issuer, client id, vault reference). Secrets are never accepted, only `vault://` references. */
export function SsoCreateForm(p: { locale: Locale; orgId: string; mfaFactorId: string | null }) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState<SsoFields>({
    protocol: 'saml',
    name: '',
    domains: '',
    xml: '',
    metadataUrl: '',
    issuer: '',
    clientId: '',
    clientSecretRef: '',
    jitEnabled: false,
    jitRole: 'viewer',
  });
  const [detail, setDetail] = useState<string | null>(null);
  const [idem, setIdem] = useState(key());
  const set =
    <K extends keyof SsoFields>(k: K) =>
    (e: { target: { value: string } }) =>
      setF({ ...f, [k]: e.target.value } as SsoFields);
  function submit(e: FormEvent) {
    e.preventDefault();
    setDetail(null);
    const b = createSsoBody(f);
    if (!b.body) return a.setNotice({ tone: 'error', text: t(p.locale, 'm12.sso.err.invalid') });
    const body = b.body;
    void a.run(
      async () => {
        const r = await browserApi().POST('/v1/organizations/{orgId}/sso-connections', {
          params: { path: { orgId: p.orgId }, header: { 'Idempotency-Key': idem } },
          body,
        });
        const code = (r.error as { code?: string } | undefined)?.code;
        if (!r.response.ok)
          setDetail(
            code === 'invalid_sso_metadata'
              ? t(p.locale, 'm12.sso.err.metadata')
              : code === 'credential_value_rejected'
                ? t(p.locale, 'm12.sso.err.secret')
                : code === 'domain_claimed'
                  ? t(p.locale, 'm12.sso.err.domainClaimed')
                  : null,
          );
        return r;
      },
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.sso.created') });
        setIdem(key());
        setF({ ...f, name: '', domains: '', xml: '', metadataUrl: '', clientSecretRef: '' });
        router.refresh();
      },
      { 404: t(p.locale, 'm12.sso.flagOff.title'), 422: t(p.locale, 'm12.sso.err.invalid') },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(p.locale, 'm12.sso.create.title')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(p.locale, 'm12.sso.create.title')}</h2>
      <Field id="sso-name" label={t(p.locale, 'm12.sso.create.name')}>
        {(x) => <Input {...x} value={f.name} maxLength={120} onChange={set('name')} required />}
      </Field>
      <Field id="sso-protocol" label={t(p.locale, 'm12.sso.protocol')}>
        {(x) => (
          <Select {...x} value={f.protocol} onChange={set('protocol')}>
            <option value="saml">{t(p.locale, 'm12.sso.protocol.saml')}</option>
            <option value="oidc">{t(p.locale, 'm12.sso.protocol.oidc')}</option>
          </Select>
        )}
      </Field>
      <Field
        id="sso-domains"
        label={t(p.locale, 'm12.sso.create.domains')}
        help={t(p.locale, 'm12.sso.create.domainsHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.domains} onChange={set('domains')} required />}
      </Field>
      {f.protocol === 'saml' ? (
        <>
          <Field
            id="sso-xml"
            label={t(p.locale, 'm12.sso.create.xml')}
            help={t(p.locale, 'm12.sso.create.metadataHelp')}
          >
            {(x) => <TextArea {...x} dir="ltr" value={f.xml} onChange={set('xml')} />}
          </Field>
          <Field id="sso-url" label={t(p.locale, 'm12.sso.create.metadataUrl')}>
            {(x) => <Input {...x} dir="ltr" value={f.metadataUrl} onChange={set('metadataUrl')} />}
          </Field>
        </>
      ) : (
        <>
          <Field id="sso-issuer" label={t(p.locale, 'm12.sso.create.issuer')}>
            {(x) => <Input {...x} dir="ltr" value={f.issuer} onChange={set('issuer')} required />}
          </Field>
          <Field id="sso-client" label={t(p.locale, 'm12.sso.create.clientId')}>
            {(x) => (
              <Input {...x} dir="ltr" value={f.clientId} onChange={set('clientId')} required />
            )}
          </Field>
          <Field
            id="sso-secret"
            label={t(p.locale, 'm12.sso.create.secretRef')}
            help={t(p.locale, 'm12.sso.create.secretHelp')}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                autoComplete="off"
                placeholder="vault://"
                value={f.clientSecretRef}
                onChange={set('clientSecretRef')}
                required
              />
            )}
          </Field>
        </>
      )}
      <div className="nz-field">
        <label>
          <input
            type="checkbox"
            checked={f.jitEnabled}
            onChange={(e) => setF({ ...f, jitEnabled: e.target.checked })}
          />{' '}
          {t(p.locale, 'm12.sso.jit.enable')}
        </label>
      </div>
      <Field
        id="sso-jit-role"
        label={t(p.locale, 'm12.sso.jit.role')}
        help={t(p.locale, 'm12.sso.jit.help')}
      >
        {(x) => (
          <Select {...x} value={f.jitRole} onChange={set('jitRole')}>
            {JIT_ROLES.map((r) => (
              <option key={r} value={r}>
                {tDynamic(p.locale, `role.${r}`, r)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm12.sso.create.submit')}
      </Button>
      {detail && (
        <p role="alert" className="nz-error-text">
          {detail}
        </p>
      )}
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

/**
 * Per-connection controls: the just-in-time toggle with its default role, the enforcement toggle, and the test-login control, which is shown DISABLED
 * (the sign-in endpoints are not approved yet, SCR-M12-05). Enforcement can be turned on only after a successful test login (`canEnforce`).
 */
export function SsoConnectionControls(p: {
  locale: Locale;
  orgId: string;
  mfaFactorId: string | null;
  connectionId: string;
  jit: { enabled: boolean; defaultRole: string };
  enforce: boolean;
  canEnforce: boolean;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [jitEnabled, setJitEnabled] = useState(p.jit.enabled);
  const [jitRole, setJitRole] = useState(p.jit.defaultRole);
  const post = (
    body:
      | { jit: { enabled: boolean; defaultRole: 'viewer' | 'developer' | 'billing_admin' } }
      | { enforce: boolean },
  ) =>
    void a.run(
      () =>
        browserApi().POST('/v1/organizations/{orgId}/sso-connections', {
          params: { path: { orgId: p.orgId }, header: { 'Idempotency-Key': key() } },
          body: { connectionId: p.connectionId, ...body },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm12.sso.saved') });
        router.refresh();
      },
      { 422: t(p.locale, 'm12.sso.err.enforce'), 404: t(p.locale, 'm12.sso.flagOff.title') },
    );
  return (
    <div>
      <h3>{t(p.locale, 'm12.sso.jit.title')}</h3>
      <div className="nz-field">
        <label>
          <input
            type="checkbox"
            checked={jitEnabled}
            onChange={(e) => setJitEnabled(e.target.checked)}
          />{' '}
          {t(p.locale, 'm12.sso.jit.enable')}
        </label>
      </div>
      <Field
        id={`jit-role-${p.connectionId}`}
        label={t(p.locale, 'm12.sso.jit.role')}
        help={t(p.locale, 'm12.sso.jit.help')}
      >
        {(x) => (
          <Select {...x} value={jitRole} onChange={(e) => setJitRole(e.target.value)}>
            {JIT_ROLES.map((r) => (
              <option key={r} value={r}>
                {tDynamic(p.locale, `role.${r}`, r)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          post({
            jit: {
              enabled: jitEnabled,
              defaultRole: (JIT_ROLES as readonly string[]).includes(jitRole)
                ? (jitRole as (typeof JIT_ROLES)[number])
                : 'viewer',
            },
          })
        }
      >
        {t(p.locale, 'm12.sso.jit.save')}
      </Button>

      <h3>{t(p.locale, 'm12.sso.enforce.title')}</h3>
      <p>{p.enforce ? t(p.locale, 'm12.sso.enforce.on') : t(p.locale, 'm12.sso.enforce.off')}</p>
      {p.enforce ? (
        <Button variant="danger" disabled={a.busy} onClick={() => post({ enforce: false })}>
          {t(p.locale, 'm12.sso.enforce.disable')}
        </Button>
      ) : (
        <>
          <Button
            disabled={a.busy || !p.canEnforce}
            aria-describedby={`enf-why-${p.connectionId}`}
            onClick={() => post({ enforce: true })}
          >
            {t(p.locale, 'm12.sso.enforce.enable')}
          </Button>
          <p className="nz-muted" id={`enf-why-${p.connectionId}`}>
            {p.canEnforce
              ? t(p.locale, 'm12.sso.enforce.warning')
              : t(p.locale, 'm12.sso.enforce.unavailable')}
          </p>
        </>
      )}

      <h3>{t(p.locale, 'm12.sso.test.title')}</h3>
      <Button variant="secondary" disabled aria-describedby={`test-why-${p.connectionId}`}>
        {t(p.locale, 'm12.sso.test.button')}
      </Button>
      <p className="nz-muted" id={`test-why-${p.connectionId}`}>
        {t(p.locale, 'm12.sso.test.unavailable')}
      </p>
      <NoticeText notice={a.notice} />
      {a.panel}
    </div>
  );
}
