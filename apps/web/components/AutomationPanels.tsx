'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { ifMatch, newKey } from '../lib/data';
import {
  EVENT_TOPICS,
  connectorTone,
  parseJsonObject,
  type ConnectorDto,
  type WebhookEndpointDto,
  type WorkflowDto,
} from '../lib/m11';
import { Note } from './DataUi';
import { IssueList, SecretOnce, useM11Call } from './M11Ui';

/* ------------------------------------------------------------------ UI-M11-02 / 03: workflow status and manual run */

/** Activate or pause a workflow (PATCH with If-Match). A workflow paused by an administrator cannot be resumed by the organization: the button says so and stays off. */
export function WorkflowStatusActions({
  locale,
  workflow,
  actingOrgId,
  canWrite,
  mfaFactorId,
}: {
  locale: Locale;
  workflow: WorkflowDto;
  actingOrgId?: string;
  canWrite: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const set = (status: 'active' | 'paused') =>
    void call.run(
      () =>
        browserApi().PATCH('/v1/workflows/{id}', {
          params: {
            path: { id: workflow.id },
            header: { 'If-Match': ifMatch(workflow.etag), 'X-Nuzm-Acting-Org': actingOrgId },
          },
          body: { status },
        }),
      () => router.refresh(),
    );
  const adminLocked = workflow.status === 'paused' && workflow.pausedByAdmin;
  if (!canWrite || workflow.status === 'disabled') return null;
  return (
    <div>
      <div className="nz-row">
        {workflow.status !== 'active' && (
          <Button
            disabled={call.busy || adminLocked || !workflow.activeVersionId}
            onClick={() => set('active')}
          >
            {t(locale, 'm11.wf.status.activate')}
          </Button>
        )}
        {workflow.status === 'active' && (
          <Button variant="secondary" disabled={call.busy} onClick={() => set('paused')}>
            {t(locale, 'm11.wf.status.pause')}
          </Button>
        )}
      </div>
      {adminLocked && <p className="nz-muted">{t(locale, 'm11.wf.status.adminPaused')}</p>}
      <Note n={call.notice} />
      {call.panel}
    </div>
  );
}

/** Start a manual execution (202 + durable operation). A repeated dedupe key answers with the ORIGINAL run and says so. */
export function RunWorkflowForm({
  locale,
  workflow,
  actingOrgId,
  mfaFactorId,
}: {
  locale: Locale;
  workflow: WorkflowDto;
  actingOrgId?: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [input, setInput] = useState('{}');
  const [err, setErr] = useState<string | undefined>();
  const [dedupe, setDedupe] = useState(newKey());
  const [started, setStarted] = useState<{ id: string; duplicate: boolean } | null>(null);
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const r = parseJsonObject(input);
    if (!r.ok) return setErr(t(locale, 'm11.wf.json.invalid', { message: r.message }));
    setErr(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/workflows/{id}/executions', {
          params: {
            path: { id: workflow.id },
            header: { 'Idempotency-Key': newKey(), 'X-Nuzm-Acting-Org': actingOrgId },
          },
          body: { input: r.value, dedupeKey: dedupe },
        }),
      (e) => {
        const x = e as unknown as { id: string; duplicate?: boolean };
        setStarted({ id: x.id, duplicate: x.duplicate === true });
        setDedupe(newKey());
        router.refresh();
      },
    );
  }
  return (
    <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'm11.run.title')}>
      <h2 className="nz-h2">{t(locale, 'm11.run.title')}</h2>
      {workflow.status !== 'active' && <p className="nz-muted">{t(locale, 'm11.run.notActive')}</p>}
      <Field
        id="run-input"
        label={t(locale, 'm11.run.input')}
        help={t(locale, 'm11.run.inputHelp')}
        error={err}
      >
        {(a) => (
          <textarea
            {...a}
            className="nz-input"
            dir="ltr"
            rows={4}
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm11.run.action')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
      {started && (
        <p role="status">
          {t(locale, started.duplicate ? 'm11.run.duplicate' : 'm11.run.started')}{' '}
          <a href={`/${locale}/automation/executions/${started.id}`}>{t(locale, 'm11.run.open')}</a>
        </p>
      )}
    </form>
  );
}

/** Reload the execution (the timeline is read when the page loads; a running execution is refreshed by hand, not polled). */
export function RefreshButton({ locale }: { locale: Locale }) {
  const router = useRouter();
  return (
    <Button variant="secondary" onClick={() => router.refresh()}>
      {t(locale, 'm11.exec.refresh')}
    </Button>
  );
}

/* ------------------------------------------------------------------ UI-M11-04: connectors */

const splitList = (v: string) => [
  ...new Set(
    v
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

export function NewConnectorForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [type, setType] = useState<ConnectorDto['type']>('http');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState('');
  const [hosts, setHosts] = useState('');
  const [authType, setAuthType] = useState('bearer');
  const [headerName, setHeaderName] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [redirects, setRedirects] = useState('');
  const [perMinute, setPerMinute] = useState('60');
  const [burst, setBurst] = useState('10');
  const [err, setErr] = useState<string | undefined>();
  const [idem, setIdem] = useState(newKey());

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const sc = splitList(scopes);
    if (name.trim() === '') return setErr(t(locale, 'm11.cn.errName'));
    if (type === 'nuzm' && sc.length === 0) return setErr(t(locale, 'm11.cn.errScopes'));
    if (type === 'http' && splitList(hosts).length === 0)
      return setErr(t(locale, 'm11.cn.errHosts'));
    if (
      type === 'oauth2' &&
      (authUrl.trim() === '' || tokenUrl.trim() === '' || clientId.trim() === '')
    )
      return setErr(t(locale, 'm11.cn.errOauth'));
    const pm = Number(perMinute);
    const bu = Number(burst);
    if (
      !Number.isInteger(pm) ||
      pm < 1 ||
      pm > 6000 ||
      !Number.isInteger(bu) ||
      bu < 1 ||
      bu > 1000
    )
      return setErr(t(locale, 'm11.cn.errRate'));
    setErr(undefined);
    const config: Record<string, unknown> =
      type === 'http'
        ? {
            allowedHosts: splitList(hosts),
            authType,
            ...(authType === 'header' && headerName.trim()
              ? { headerName: headerName.trim() }
              : {}),
          }
        : type === 'oauth2'
          ? {
              authorizationUrl: authUrl.trim(),
              tokenUrl: tokenUrl.trim(),
              clientId: clientId.trim(),
              ...(splitList(redirects).length ? { redirectUris: splitList(redirects) } : {}),
            }
          : {};
    void call.run(
      () =>
        browserApi().POST('/v1/connectors', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            type,
            name: name.trim(),
            scopes: sc,
            rateLimit: { perMinute: pm, burst: bu },
            config,
          },
        }),
      () => {
        setIdem(newKey());
        setName('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.cn.created') });
        router.refresh();
      },
      () => setIdem(newKey()),
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.cn.new')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.cn.new')}</h2>
      <p className="nz-muted">{t(locale, 'm11.cn.scopeNote')}</p>
      <Field
        id="cn-type"
        label={t(locale, 'm11.cn.type')}
        help={t(locale, `m11.cn.typeHelp.${type}`)}
      >
        {(a) => (
          <Select
            {...a}
            value={type}
            onChange={(e) => setType(e.target.value as ConnectorDto['type'])}
          >
            {(['http', 'oauth2', 'nuzm', 'email'] as const).map((x) => (
              <option key={x} value={x}>
                {t(locale, `m11.cn.type.${x}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="cn-name" label={t(locale, 'field.name')} error={err}>
        {(a) => (
          <Input {...a} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <Field
        id="cn-scopes"
        label={t(locale, 'm11.cn.scopes')}
        help={t(locale, 'm11.cn.scopesHelp')}
      >
        {(a) => (
          <Input {...a} dir="ltr" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        )}
      </Field>
      {type === 'http' && (
        <>
          <Field
            id="cn-hosts"
            label={t(locale, 'm11.cn.hosts')}
            help={t(locale, 'm11.cn.hostsHelp')}
          >
            {(a) => (
              <Input {...a} dir="ltr" value={hosts} onChange={(e) => setHosts(e.target.value)} />
            )}
          </Field>
          <Field id="cn-auth" label={t(locale, 'm11.cn.authType')}>
            {(a) => (
              <Select {...a} value={authType} onChange={(e) => setAuthType(e.target.value)}>
                {['bearer', 'header', 'none'].map((x) => (
                  <option key={x} value={x}>
                    {t(locale, `m11.cn.authType.${x as 'bearer' | 'header' | 'none'}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {authType === 'header' && (
            <Field id="cn-header" label={t(locale, 'm11.cn.headerName')}>
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                />
              )}
            </Field>
          )}
        </>
      )}
      {type === 'oauth2' && (
        <>
          <Field id="cn-authurl" label={t(locale, 'm11.cn.authUrl')}>
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                type="url"
                value={authUrl}
                onChange={(e) => setAuthUrl(e.target.value)}
              />
            )}
          </Field>
          <Field id="cn-tokenurl" label={t(locale, 'm11.cn.tokenUrl')}>
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                type="url"
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
              />
            )}
          </Field>
          <Field
            id="cn-clientid"
            label={t(locale, 'm11.cn.clientId')}
            help={t(locale, 'm11.cn.clientIdHelp')}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            )}
          </Field>
          <Field
            id="cn-redirects"
            label={t(locale, 'm11.cn.redirects')}
            help={t(locale, 'm11.cn.redirectsHelp')}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                value={redirects}
                onChange={(e) => setRedirects(e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      <div className="nz-row">
        <Field id="cn-pm" label={t(locale, 'm11.cn.perMinute')}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              inputMode="numeric"
              value={perMinute}
              onChange={(e) => setPerMinute(e.target.value)}
            />
          )}
        </Field>
        <Field id="cn-burst" label={t(locale, 'm11.cn.burst')}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              inputMode="numeric"
              value={burst}
              onChange={(e) => setBurst(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'action.create')}
      </Button>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}

/**
 * Authorize one connector. A credential is NEVER typed here: the person gives the reference of a secret that already lives in the organization's vault (`vault://…`), or runs the OAuth2
 * authorization-code flow (the secret exchange happens on the server). The vault reference of an existing authorization is never shown back.
 */
export function ConnectorAuthorize({
  locale,
  connector,
  orgId,
  mfaFactorId,
}: {
  locale: Locale;
  connector: ConnectorDto;
  orgId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [expires, setExpires] = useState('');
  const [redirect, setRedirect] = useState(
    ((connector.config.redirectUris as string[] | undefined) ?? [])[0] ?? '',
  );
  const [started, setStarted] = useState<{ url: string; state: string } | null>(null);
  const [state, setState] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const post = (body: Record<string, unknown>, ok: (r: Record<string, unknown>) => void) =>
    void call.run(
      () =>
        browserApi().POST('/v1/connectors/{id}/authorization', {
          params: { path: { id: connector.id }, header: { 'Idempotency-Key': newKey() } },
          body,
        }),
      (r) => ok(r as unknown as Record<string, unknown>),
    );
  const done = () => {
    call.setNotice({ tone: 'ok', text: t(locale, 'm11.cn.authorized') });
    setOpen(false);
    router.refresh();
  };
  const dead = connector.status === 'revoked' || connector.status === 'disabled';
  if (dead) return <span className="nz-muted">—</span>;
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t(locale, 'm11.cn.authorize')}
      </Button>
    );
  return (
    <div
      className="nz-card"
      role="group"
      aria-label={t(locale, 'm11.cn.authorizeTitle', { name: connector.name })}
    >
      <h3 className="nz-h2">{t(locale, 'm11.cn.authorizeTitle', { name: connector.name })}</h3>
      <p className="nz-muted">{t(locale, 'm11.cn.neverSecret')}</p>
      {connector.type === 'email' && (
        <Button disabled={call.busy} onClick={() => post({ kind: 'credential' }, done)}>
          {t(locale, 'm11.cn.authorizeEmail')}
        </Button>
      )}
      {(connector.type === 'http' || connector.type === 'nuzm') && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!ref.trim().startsWith(`vault://`) || !ref.includes(`tenant-${orgId}-`))
              return setErr(t(locale, 'm11.cn.errVaultRef', { org: orgId }));
            setErr(undefined);
            post(
              {
                kind: 'credential',
                vaultRef: ref.trim(),
                ...(expires ? { expiresAt: `${expires}T23:59:59.000Z` } : {}),
              },
              done,
            );
          }}
        >
          <Field
            id={`vr-${connector.id}`}
            label={t(locale, 'm11.cn.vaultRef')}
            help={t(locale, 'm11.cn.vaultRefHelp', { org: orgId })}
            error={err}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                autoComplete="off"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            )}
          </Field>
          <Field
            id={`ve-${connector.id}`}
            label={t(locale, 'm11.cn.expires')}
            help={t(locale, 'm11.cn.expiresHelp')}
          >
            {(a) => (
              <Input
                {...a}
                dir="ltr"
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={call.busy}>
            {t(locale, 'm11.cn.authorizeAction')}
          </Button>
        </form>
      )}
      {connector.type === 'oauth2' && (
        <>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!/^https:\/\//.test(redirect.trim()))
                return setErr(t(locale, 'm11.cn.errRedirect'));
              setErr(undefined);
              post({ kind: 'oauth2_start', redirectUri: redirect.trim() }, (r) => {
                setStarted({ url: String(r.authorizationUrl ?? ''), state: String(r.state ?? '') });
                setState(String(r.state ?? ''));
              });
            }}
          >
            <Field id={`ro-${connector.id}`} label={t(locale, 'm11.cn.redirectUri')} error={err}>
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  type="url"
                  value={redirect}
                  onChange={(e) => setRedirect(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={call.busy}>
              {t(locale, 'm11.cn.oauthStart')}
            </Button>
          </form>
          {started && /^https:\/\//.test(started.url) && (
            <p>
              <a href={started.url} target="_blank" rel="noopener noreferrer">
                {t(locale, 'm11.cn.oauthOpen')}
              </a>
            </p>
          )}
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!state.trim() || !code.trim())
                return setErr(t(locale, 'm11.cn.errOauthComplete'));
              setErr(undefined);
              post({ kind: 'oauth2_complete', state: state.trim(), code: code.trim() }, done);
            }}
          >
            <p className="nz-muted">{t(locale, 'm11.cn.oauthCompleteHelp')}</p>
            <Field id={`os-${connector.id}`} label={t(locale, 'm11.cn.oauthState')}>
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  autoComplete="off"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                />
              )}
            </Field>
            <Field id={`oc-${connector.id}`} label={t(locale, 'm11.cn.oauthCode')}>
              {(a) => (
                <Input
                  {...a}
                  dir="ltr"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={call.busy}>
              {t(locale, 'm11.cn.oauthComplete')}
            </Button>
          </form>
        </>
      )}
      <Note n={call.notice} />
      {call.panel}
      <Button variant="secondary" onClick={() => setOpen(false)}>
        {t(locale, 'action.cancel')}
      </Button>
    </div>
  );
}

/** Authorization state of a connector as a badge plus its expiry. */
export function AuthState({ locale, c }: { locale: Locale; c: ConnectorDto }) {
  const a = c.authorization;
  const st = a?.status ?? 'none';
  return (
    <>
      <Badge tone={connectorTone(st)}>{tDynamic(locale, `m11.cn.auth.${st}`, st)}</Badge>
      {a?.expiresAt && (
        <p className="nz-muted">
          {t(locale, 'm11.cn.expiresAt', { time: formatDateTime(a.expiresAt, locale) })}
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ UI-M11-05: outbound webhook endpoints */

function EventPicker({
  locale,
  value,
  onChange,
}: {
  locale: Locale;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{t(locale, 'm11.wh.events')}</legend>
      <div className="nz-row">
        {EVENT_TOPICS.map((tp) => (
          <label key={tp} className="nz-row">
            <input
              type="checkbox"
              checked={value.includes(tp)}
              onChange={() =>
                onChange(value.includes(tp) ? value.filter((x) => x !== tp) : [...value, tp])
              }
            />
            <Ltr>{tp}</Ltr>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function NewWebhookForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([EVENT_TOPICS[0]]);
  const [err, setErr] = useState<string | undefined>();
  const [secret, setSecret] = useState<{ value: string; url: string } | null>(null);
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!/^https:\/\//i.test(url.trim())) return setErr(t(locale, 'm11.wh.errUrl'));
    if (events.length === 0) return setErr(t(locale, 'm11.wh.errEvents'));
    setErr(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/webhook-endpoints', {
          params: { header: { 'Idempotency-Key': newKey() } },
          body: {
            url: url.trim(),
            events,
            ...(description.trim() ? { description: description.trim() } : {}),
          },
        }),
      (r) => {
        const x = r as unknown as WebhookEndpointDto;
        if (x.secret) setSecret({ value: x.secret, url: x.url });
        setUrl('');
        setDescription('');
        router.refresh();
      },
    );
  }
  return (
    <>
      <form
        onSubmit={submit}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm11.wh.new')}
        style={{ maxInlineSize: 640 }}
      >
        <h2 className="nz-h2">{t(locale, 'm11.wh.new')}</h2>
        <Field
          id="wh-url"
          label={t(locale, 'm11.wh.url')}
          help={t(locale, 'm11.wh.urlHelp')}
          error={err}
        >
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <Field id="wh-desc" label={t(locale, 'm11.wh.description')}>
          {(a) => (
            <Input
              {...a}
              maxLength={200}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <EventPicker locale={locale} value={events} onChange={setEvents} />
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'action.create')}
        </Button>
        <Note n={call.notice} />
        <IssueList locale={locale} issues={call.issues} />
        {call.panel}
      </form>
      {secret && (
        <SecretOnce
          locale={locale}
          label={t(locale, 'm11.wh.secretTitle')}
          value={secret.value}
          extra={
            <p>
              {t(locale, 'm11.wh.secretFor')} <Ltr>{secret.url}</Ltr>
            </p>
          }
          onDone={() => setSecret(null)}
        />
      )}
    </>
  );
}

/** Rotate the signing secret of an endpoint: POST with `secretRotation`; both secrets sign during the overlap. The new secret is shown once. */
export function RotateSecret({
  locale,
  endpoint,
  mfaFactorId,
}: {
  locale: Locale;
  endpoint: WebhookEndpointDto;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('24');
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | undefined>();
  if (secret)
    return (
      <SecretOnce
        locale={locale}
        label={t(locale, 'm11.wh.rotatedTitle')}
        value={secret}
        extra={<p>{t(locale, 'm11.wh.rotatedBody', { hours })}</p>}
        onDone={() => {
          setSecret(null);
          router.refresh();
        }}
      />
    );
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t(locale, 'm11.wh.rotate')}
      </Button>
    );
  return (
    <form
      noValidate
      aria-label={t(locale, 'm11.wh.rotate')}
      onSubmit={(e) => {
        e.preventDefault();
        const h = Number(hours);
        if (!Number.isInteger(h) || h < 0 || h > 168) return setErr(t(locale, 'm11.wh.errOverlap'));
        setErr(undefined);
        void call.run(
          () =>
            browserApi().POST('/v1/webhook-endpoints', {
              params: { header: { 'Idempotency-Key': newKey() } },
              body: {
                url: endpoint.url,
                events: endpoint.events,
                secretRotation: { overlapHours: h },
              },
            }),
          (r) => setSecret((r as unknown as WebhookEndpointDto).secret ?? null),
        );
      }}
    >
      <Field
        id={`ov-${endpoint.id}`}
        label={t(locale, 'm11.wh.overlap')}
        help={t(locale, 'm11.wh.overlapHelp')}
        error={err}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            inputMode="numeric"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        )}
      </Field>
      <div className="nz-row">
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'm11.wh.rotateAction')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t(locale, 'action.cancel')}
        </Button>
      </div>
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}
