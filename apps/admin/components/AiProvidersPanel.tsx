'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import {
  attestBody,
  blockers,
  configureBody,
  configureFormOf,
  enableBlock,
  isDevReference,
  killSwitchBody,
  rateCardRows,
  requestBlock,
  termsOf,
  type ConfigureError,
  type ConfigureForm,
  type ProviderRow,
  type Tri,
} from '../lib/ai';
import { browserApi } from '../lib/client';
import { Note, useStaffAction } from './BillingAdminPanels';

type Body = Record<string, unknown>;
const post = (body: Body) =>
  browserApi().POST('/v1/admin/ai/model-providers', { body: body as { action: 'configure' } });

const overrides = (locale: Locale) => ({
  403: t(locale, 'aia.err.forbidden'),
  404: t(locale, 'aia.err.notFound'),
  409: t(locale, 'aia.err.state'),
  422: t(locale, 'aia.err.refused'),
});

const triText = (locale: Locale, v: Tri) =>
  v === true ? t(locale, 'aia.yes') : v === false ? t(locale, 'aia.no') : t(locale, 'aia.unknown');

const CONFIGURE_ERROR = {
  code: 'aia.cfg.err.code',
  adapter: 'aia.cfg.err.adapter',
  displayName: 'aia.cfg.err.displayName',
  region: 'aia.cfg.err.region',
  vault: 'aia.cfg.err.vault',
  rateCard: 'aia.cfg.err.rateCard',
  egress: 'aia.cfg.err.egress',
} as const satisfies Record<ConfigureError, string>;

/**
 * The GLOBAL (or per-organization) AI kill switch. It stops every model call on the next call; turning it on or off asks for confirmation first, then for a
 * fresh MFA code when the session's is old. The API does not report the current state, so the screen only shows the result of what was done here.
 */
function KillSwitchCard({ locale, mfaFactorId }: { locale: Locale; mfaFactorId: string | null }) {
  const a = useStaffAction(locale, mfaFactorId);
  const [org, setOrg] = useState('');
  const [pending, setPending] = useState<boolean | null>(null);
  const [orgErr, setOrgErr] = useState(false);
  const [last, setLast] = useState<{ on: boolean; scope: 'global' | 'org' } | null>(null);
  const scope: 'global' | 'org' = org.trim() === '' ? 'global' : 'org';

  function ask(on: boolean) {
    const ok = killSwitchBody(on, org) !== null;
    setOrgErr(!ok);
    if (ok) setPending(on);
  }
  function confirm() {
    if (pending === null) return;
    const body = killSwitchBody(pending, org);
    if (!body) return;
    const on = pending;
    void a.run(
      () => post(body),
      () => {
        setPending(null);
        setLast({ on, scope });
        a.setNotice({ tone: 'ok', text: t(locale, on ? 'aia.ks.done.on' : 'aia.ks.done.off') });
      },
      overrides(locale),
    );
  }
  return (
    <section className="nz-card" aria-labelledby="aia-ks-h" style={{ marginBlockEnd: 16 }}>
      <h2 id="aia-ks-h" className="nz-h2">
        {t(locale, 'aia.ks.title')}
      </h2>
      <p>{t(locale, 'aia.ks.explain')}</p>
      <Field
        id="aia-ks-org"
        label={t(locale, 'aia.ks.org')}
        help={t(locale, 'aia.ks.orgHelp')}
        error={orgErr ? t(locale, 'aia.ks.orgInvalid') : undefined}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            value={org}
            disabled={pending !== null}
            onChange={(e) => setOrg(e.target.value)}
          />
        )}
      </Field>
      {pending === null ? (
        <div className="nz-row">
          <Button variant="danger" disabled={a.busy} onClick={() => ask(true)}>
            {t(locale, 'aia.ks.engage')}
          </Button>
          <Button variant="secondary" disabled={a.busy} onClick={() => ask(false)}>
            {t(locale, 'aia.ks.release')}
          </Button>
        </div>
      ) : (
        <div role="group" aria-labelledby="aia-ks-confirm-h" className="nz-card">
          <h3 id="aia-ks-confirm-h" className="nz-h3">
            {t(locale, 'aia.ks.confirmTitle')}
          </h3>
          <p>{t(locale, pending ? `aia.ks.confirm.on.${scope}` : `aia.ks.confirm.off.${scope}`)}</p>
          <div className="nz-row">
            <Button variant={pending ? 'danger' : 'primary'} disabled={a.busy} onClick={confirm}>
              {t(locale, pending ? 'aia.ks.confirmOn' : 'aia.ks.confirmOff')}
            </Button>
            <Button variant="secondary" disabled={a.busy} onClick={() => setPending(null)}>
              {t(locale, 'action.cancel')}
            </Button>
          </div>
        </div>
      )}
      <Note n={a.notice} />
      {last && (
        <p>
          {t(locale, last.on ? `aia.ks.last.on.${last.scope}` : `aia.ks.last.off.${last.scope}`)}
        </p>
      )}
      <p className="nz-muted">{t(locale, 'aia.ks.stateUnknown')}</p>
      {a.panel}
    </section>
  );
}

/** Create or edit a provider. The credential is a vault REFERENCE only: there is no field for a secret value. */
function ConfigureCard(p: {
  locale: Locale;
  mfaFactorId: string | null;
  edit: ProviderRow | null;
  onDone: () => void;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useStaffAction(locale, p.mfaFactorId);
  const [f, setF] = useState<ConfigureForm>(() => configureFormOf(p.edit));
  const [err, setErr] = useState<ConfigureError | null>(null);
  const set = (k: keyof ConfigureForm) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const r = configureBody(f);
    setErr(r.error ?? null);
    if (!r.body) return;
    const body = r.body;
    void a.run(
      () => post(body),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'aia.cfg.done') });
        if (p.edit) p.onDone();
        else setF(configureFormOf(null));
        router.refresh();
      },
      overrides(locale),
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'aia.cfg.title')}
      style={{ maxInlineSize: 680, marginBlockEnd: 16 }}
    >
      <h2 className="nz-h2">
        {p.edit ? t(locale, 'aia.cfg.editing', { code: p.edit.code }) : t(locale, 'aia.cfg.title')}
      </h2>
      <p className="nz-muted">{t(locale, 'aia.cfg.help')}</p>
      <Field id="aia-code" label={t(locale, 'aia.cfg.code')} help={t(locale, 'aia.cfg.codeHelp')}>
        {(x) => (
          <Input {...x} dir="ltr" value={f.code} disabled={!!p.edit} onChange={set('code')} />
        )}
      </Field>
      <Field id="aia-adapter" label={t(locale, 'aia.cfg.adapter')}>
        {(x) => <Input {...x} dir="ltr" value={f.adapter} onChange={set('adapter')} />}
      </Field>
      <Field id="aia-name" label={t(locale, 'aia.cfg.displayName')}>
        {(x) => <Input {...x} value={f.displayName} onChange={set('displayName')} />}
      </Field>
      <Field
        id="aia-region"
        label={t(locale, 'aia.cfg.region')}
        help={t(locale, 'aia.cfg.regionHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.region} onChange={set('region')} />}
      </Field>
      <Field
        id="aia-vault"
        label={t(locale, 'aia.cfg.vault')}
        help={t(locale, 'aia.cfg.vaultHelp')}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            placeholder="vault://…"
            value={f.vaultRef}
            onChange={set('vaultRef')}
          />
        )}
      </Field>
      <Field id="aia-rcv" label={t(locale, 'aia.cfg.rateVersion')}>
        {(x) => (
          <Input {...x} dir="ltr" value={f.rateCardVersion} onChange={set('rateCardVersion')} />
        )}
      </Field>
      <Field
        id="aia-rc"
        label={t(locale, 'aia.cfg.rateCard')}
        help={t(locale, 'aia.cfg.rateCardHelp')}
      >
        {(x) => (
          <textarea
            {...x}
            className="nz-input"
            dir="ltr"
            rows={6}
            value={f.rateCard}
            placeholder='{"models":{"model-id":{"creditsPerMillionInput":"0","creditsPerMillionOutput":"0"}}}'
            onChange={set('rateCard')}
          />
        )}
      </Field>
      <Field
        id="aia-egress"
        label={t(locale, 'aia.cfg.egress')}
        help={t(locale, 'aia.cfg.egressHelp')}
      >
        {(x) => <Input {...x} dir="ltr" value={f.egress} onChange={set('egress')} />}
      </Field>
      <p className="nz-muted">{t(locale, 'aia.cfg.resets')}</p>
      {err && (
        <p role="alert" className="nz-error-text">
          {t(locale, CONFIGURE_ERROR[err])}
        </p>
      )}
      <div className="nz-row">
        <Button type="submit" disabled={a.busy}>
          {t(locale, 'action.save')}
        </Button>
        {p.edit && (
          <Button variant="secondary" onClick={p.onDone}>
            {t(locale, 'action.cancel')}
          </Button>
        )}
      </div>
      <Note n={a.notice} />
      {a.panel}
    </form>
  );
}

/** The actions of one provider: attest (human data-terms attestation), request enabling, enable (a DIFFERENT person), disable. Each is one POST with an `action`. */
function RowActions(p: {
  locale: Locale;
  row: ProviderRow;
  me: { id: string; can: (perm: string) => boolean };
  mfaFactorId: string | null;
  onEdit: (r: ProviderRow) => void;
}) {
  const { locale, row: r, me } = p;
  const router = useRouter();
  const a = useStaffAction(locale, p.mfaFactorId);
  const [ref, setRef] = useState(r.attestationRef ?? '');
  const [retains, setRetains] = useState('');
  const [trains, setTrains] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const canManage = me.can('admin:ai:manage');
  const canApprove = me.can('admin:ai:approve');
  const block = enableBlock(r, me);
  const reqBlock = requestBlock(r);
  const act = (body: Body, ok: Parameters<typeof t>[1]) =>
    void a.run(
      () => post(body),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, ok) });
        router.refresh();
      },
      overrides(locale),
    );

  /** The key goes to the API once and is dropped from the screen at once (the field is write-only: it is never filled from the server). */
  function saveKey(ev: FormEvent) {
    ev.preventDefault();
    const key = apiKey.trim();
    if (!/^[\x21-\x7E]{20,400}$/.test(key)) return setErr(t(locale, 'aia.key.err'));
    setErr(null);
    void a.run(
      () => post({ action: 'set_credential', id: r.id, apiKey: key }),
      () => {
        setApiKey('');
        a.setNotice({ tone: 'ok', text: t(locale, 'aia.done.keySet') });
        router.refresh();
      },
      { ...overrides(locale), 422: t(locale, 'aia.key.unavailable') },
    );
  }
  function attest(ev: FormEvent) {
    ev.preventDefault();
    const x = attestBody(r.id, { ref, retains, trains });
    if (!x.body)
      return setErr(t(locale, x.error === 'ref' ? 'aia.att.err.ref' : 'aia.att.err.terms'));
    setErr(null);
    act(x.body, 'aia.done.attest');
  }
  const triSelect = (id: string, value: string, set: (v: string) => void, label: string) => (
    <Field id={id} label={label}>
      {(x) => (
        <Select {...x} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{t(locale, 'aia.att.choose')}</option>
          <option value="true">{t(locale, 'aia.yes')}</option>
          <option value="false">{t(locale, 'aia.no')}</option>
          <option value="unknown">{t(locale, 'aia.unknown')}</option>
        </Select>
      )}
    </Field>
  );
  return (
    <details>
      <summary>{t(locale, 'aia.actions')}</summary>
      <div style={{ minInlineSize: 280 }}>
        <div className="nz-row">
          {canManage && !r.enabled && (
            <Button variant="secondary" onClick={() => p.onEdit(r)}>
              {t(locale, 'aia.edit')}
            </Button>
          )}
          {canManage && r.enabled && (
            <Button
              variant="danger"
              disabled={a.busy}
              onClick={() => act({ action: 'disable', id: r.id }, 'aia.done.disable')}
            >
              {t(locale, 'aia.disable')}
            </Button>
          )}
        </div>
        {canManage && !isDevReference(r.code) && (
          <form onSubmit={saveKey} noValidate aria-label={t(locale, 'aia.key.title')}>
            <h3 className="nz-h3">{t(locale, 'aia.key.title')}</h3>
            <p className="nz-muted">{t(locale, 'aia.key.help')}</p>
            <p className="nz-muted" role="status">
              {r.vaultRef
                ? t(locale, 'aia.key.stored', { ref: r.vaultRef })
                : t(locale, 'aia.key.none')}
            </p>
            <Field id={`key-${r.id}`} label={t(locale, 'aia.key.field')}>
              {(x) => (
                <Input
                  {...x}
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={400}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              )}
            </Field>
            <div className="nz-row">
              <Button type="submit" variant="secondary" disabled={a.busy || apiKey.trim() === ''}>
                {t(locale, 'aia.key.save')}
              </Button>
              {r.vaultRef && (
                <Button
                  variant="danger"
                  disabled={a.busy}
                  onClick={() =>
                    act({ action: 'clear_credential', id: r.id }, 'aia.done.keyRemoved')
                  }
                >
                  {t(locale, 'aia.key.remove')}
                </Button>
              )}
            </div>
          </form>
        )}
        {canApprove && !r.enabled && !isDevReference(r.code) && (
          <form onSubmit={attest} noValidate aria-label={t(locale, 'aia.att.title')}>
            <h3 className="nz-h3">{t(locale, 'aia.att.title')}</h3>
            <p className="nz-muted">{t(locale, 'aia.att.help')}</p>
            <Field id={`att-ref-${r.id}`} label={t(locale, 'aia.att.ref')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  autoComplete="off"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              )}
            </Field>
            {triSelect(`att-ret-${r.id}`, retains, setRetains, t(locale, 'aia.att.retains'))}
            {triSelect(`att-trn-${r.id}`, trains, setTrains, t(locale, 'aia.att.trains'))}
            <Button type="submit" variant="secondary" disabled={a.busy}>
              {t(locale, 'aia.att.submit')}
            </Button>
          </form>
        )}
        {canManage && !r.enabled && (
          <>
            <Button
              variant="secondary"
              disabled={a.busy || reqBlock.length > 0}
              aria-describedby={`req-why-${r.id}`}
              onClick={() => act({ action: 'request_enable', id: r.id }, 'aia.done.request')}
            >
              {t(locale, 'aia.request')}
            </Button>
            <p id={`req-why-${r.id}`} className="nz-muted">
              {reqBlock.length > 0
                ? t(locale, 'aia.request.blocked')
                : r.enableRequestedBy
                  ? t(locale, 'aia.request.already')
                  : t(locale, 'aia.request.ready')}
            </p>
          </>
        )}
        {!r.enabled && (
          <>
            <Button
              disabled={a.busy || block !== null}
              aria-describedby={`en-why-${r.id}`}
              onClick={() => act({ action: 'enable', id: r.id }, 'aia.done.enable')}
            >
              {t(locale, 'aia.enable')}
            </Button>
            <p id={`en-why-${r.id}`} className="nz-muted">
              {block === 'no_permission'
                ? t(locale, 'aia.enable.noPerm')
                : block === 'two_person'
                  ? t(locale, 'aia.enable.twoPerson')
                  : block === 'blocked'
                    ? t(locale, 'aia.enable.blocked')
                    : t(locale, 'aia.enable.ready')}
            </p>
          </>
        )}
        {err && (
          <p role="alert" className="nz-error-text">
            {err}
          </p>
        )}
        <Note n={a.notice} />
        {a.panel}
      </div>
    </details>
  );
}

const short = (id: string | null | undefined) => (id ? <Ltr>{id.slice(0, 8)}</Ltr> : '—');

export function AiProvidersPanel(p: {
  locale: Locale;
  items: unknown[];
  meId: string;
  canManage: boolean;
  canApprove: boolean;
  mfaFactorId: string | null;
}) {
  const { locale } = p;
  const [edit, setEdit] = useState<ProviderRow | null>(null);
  const rows = p.items as ProviderRow[];
  // functions cannot cross the server/client boundary: the two platform permissions arrive as booleans
  const me = {
    id: p.meId,
    can: (perm: string) =>
      perm === 'admin:ai:manage' ? p.canManage : perm === 'admin:ai:approve' ? p.canApprove : false,
  };
  return (
    <>
      <Banner tone="warn">{t(locale, 'aia.noSelection')}</Banner>
      {p.canManage && <KillSwitchCard locale={locale} mfaFactorId={p.mfaFactorId} />}
      {p.canManage && (
        <ConfigureCard
          key={edit?.id ?? 'new'}
          locale={locale}
          mfaFactorId={p.mfaFactorId}
          edit={edit}
          onDone={() => setEdit(null)}
        />
      )}
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'aia.rows')}
      </h2>
      {rows.length === 0 ? (
        <EmptyState title={t(locale, 'aia.empty')} body={t(locale, 'aia.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'aia.rows')}
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'p',
              header: t(locale, 'aia.col.provider'),
              render: (r) => (
                <>
                  <strong>{r.displayName}</strong>
                  <p className="nz-muted">
                    <Ltr>{r.code}</Ltr> · <Ltr>{r.adapter}</Ltr>
                  </p>
                  {isDevReference(r.code) && <Badge tone="warn">{t(locale, 'aia.devRef')}</Badge>}
                </>
              ),
            },
            { key: 'r', header: t(locale, 'aia.col.region'), render: (r) => <Ltr>{r.region}</Ltr> },
            {
              key: 's',
              header: t(locale, 'field.status'),
              render: (r) => (
                <>
                  <Badge tone={r.enabled ? 'success' : undefined}>
                    {r.enabled ? t(locale, 'aia.enabled') : t(locale, 'aia.disabled')}
                  </Badge>
                  <p className="nz-muted">
                    {r.adapterRegistered
                      ? t(locale, 'aia.adapter.registered')
                      : t(locale, 'aia.adapter.missing')}
                  </p>
                </>
              ),
            },
            {
              key: 'd',
              header: t(locale, 'aia.col.terms'),
              render: (r) => {
                const terms = termsOf(r);
                return (
                  <>
                    <Badge tone={terms.attested ? 'success' : 'warn'}>
                      {terms.attested ? t(locale, 'aia.attested') : t(locale, 'aia.notAttested')}
                    </Badge>
                    <p className="nz-muted">
                      {t(locale, 'aia.att.ref')}:{' '}
                      {r.attestationRef ? <Ltr>{r.attestationRef}</Ltr> : '—'}
                    </p>
                    <p className="nz-muted">
                      {t(locale, 'aia.att.retains')}: {triText(locale, terms.retainsPrompts)}
                    </p>
                    <p className="nz-muted">
                      {t(locale, 'aia.att.trains')}: {triText(locale, terms.trainsOnData)}
                    </p>
                  </>
                );
              },
            },
            {
              key: 'c',
              header: t(locale, 'aia.col.rateCard'),
              render: (r) => {
                const rc = rateCardRows(r);
                return rc.length === 0 ? (
                  t(locale, 'aia.noRateCard')
                ) : (
                  <details>
                    <summary>
                      {t(locale, 'aia.rateCard.summary', {
                        count: rc.length,
                        version: r.rateCardVersion ?? '—',
                      })}
                    </summary>
                    <ul>
                      {rc.map((m) => (
                        <li key={m.model}>
                          <Ltr>{`${m.model}: ${m.input} / ${m.output}`}</Ltr>
                        </li>
                      ))}
                    </ul>
                    <p className="nz-muted">{t(locale, 'aia.rateCard.unit')}</p>
                  </details>
                );
              },
            },
            {
              key: 'v',
              header: t(locale, 'aia.col.vault'),
              render: (r) => (r.vaultRef ? <Ltr>{r.vaultRef}</Ltr> : '—'),
            },
            {
              key: 'tp',
              header: t(locale, 'aia.col.twoPerson'),
              render: (r) => (
                <>
                  <p>
                    {t(locale, 'aia.requestedBy')}: {short(r.enableRequestedBy)}
                  </p>
                  <p>
                    {t(locale, 'aia.enabledBy')}: {short(r.enabledBy)}
                  </p>
                </>
              ),
            },
            {
              key: 'b',
              header: t(locale, 'aia.col.blockers'),
              render: (r) => {
                const b = blockers(r);
                return r.enabled ? (
                  '—'
                ) : b.length === 0 ? (
                  <Badge tone="success">{t(locale, 'aia.noBlockers')}</Badge>
                ) : (
                  <ul>
                    {b.map((x) => (
                      <li key={x}>{tDynamic(locale, `aia.blocker.${x}`, x)}</li>
                    ))}
                  </ul>
                );
              },
            },
            {
              key: 'x',
              header: t(locale, 'field.action'),
              render: (r) => (
                <RowActions
                  locale={locale}
                  row={r}
                  me={me}
                  mfaFactorId={p.mfaFactorId}
                  onEdit={setEdit}
                />
              ),
            },
          ]}
        />
      )}
      <p className="nz-muted">{t(locale, 'aia.enableRules')}</p>
    </>
  );
}
