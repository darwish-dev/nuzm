'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  ENVIRONMENTS,
  SERVICES,
  capabilitySummary,
  configureBody,
  enableBlock,
  isDevReference,
  probeOf,
  validAdr,
  validEvidenceRef,
  verifiedAtIso,
  type ProviderRow,
} from '../lib/data-providers';
import { Note, useStaffAction } from './BillingAdminPanels';

const overrides = (locale: Locale) => ({
  403: t(locale, 'm8.adm.forbiddenAction'),
  404: t(locale, 'm8.adm.notFound'),
  409: t(locale, 'm8.adm.conflict'),
  422: t(locale, 'm8.adm.refused'),
});

/** Actions of one provider row. Each is one POST with an `action`; the API enforces the permissions, the two-person rule and the enabling preconditions. */
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
  const [adr, setAdr] = useState(r.adrRef ?? '');
  const [evidence, setEvidence] = useState('');
  const [when, setWhen] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const act = (body: Record<string, unknown>, ok: string) =>
    void a.run(
      () => browserApi().POST('/v1/admin/data-providers', { body: body as { action: 'probe' } }),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, ok as 'm8.adm.done.probe') });
        router.refresh();
      },
      overrides(locale),
    );
  const canManage = me.can('admin:data:manage');
  const canApprove = me.can('admin:data:approve');
  const block = enableBlock(r, me);

  function requestEnable(ev: FormEvent) {
    ev.preventDefault();
    const iso = verifiedAtIso(when);
    if (!validEvidenceRef(evidence) || !iso) return setErr(t(locale, 'm8.adm.err.evidence'));
    setErr(undefined);
    act(
      { action: 'request_enable', id: r.id, evidenceRef: evidence.trim(), verifiedAt: iso },
      'm8.adm.done.request',
    );
  }
  function recordAdr(ev: FormEvent) {
    ev.preventDefault();
    if (!validAdr(adr)) return setErr(t(locale, 'm8.adm.err.adr'));
    setErr(undefined);
    act({ action: 'record_adr', id: r.id, adrRef: adr.trim() }, 'm8.adm.done.adr');
  }
  return (
    <details>
      <summary>{t(locale, 'm8.adm.actions')}</summary>
      <div style={{ minInlineSize: 260 }}>
        <div className="nz-row">
          {canManage && (
            <Button
              variant="secondary"
              disabled={a.busy}
              onClick={() => act({ action: 'probe', id: r.id }, 'm8.adm.done.probe')}
            >
              {t(locale, 'm8.adm.probe')}
            </Button>
          )}
          {canManage && !r.enabled && (
            <Button variant="secondary" onClick={() => p.onEdit(r)}>
              {t(locale, 'm8.adm.edit')}
            </Button>
          )}
          {canManage && r.enabled && (
            <Button
              variant="danger"
              disabled={a.busy}
              onClick={() => act({ action: 'disable', id: r.id }, 'm8.adm.done.disable')}
            >
              {t(locale, 'm8.adm.disable')}
            </Button>
          )}
        </div>
        {canApprove && !r.enabled && (
          <form onSubmit={recordAdr} noValidate aria-label={t(locale, 'm8.adm.recordAdr')}>
            <Field
              id={`adr-${r.id}`}
              label={t(locale, 'm8.adm.adrRef')}
              help={t(locale, 'm8.adm.adrHelp')}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  value={adr}
                  placeholder="ADR-000"
                  onChange={(e) => setAdr(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary" disabled={a.busy}>
              {t(locale, 'm8.adm.recordAdr')}
            </Button>
          </form>
        )}
        {canManage && !r.enabled && (
          <form onSubmit={requestEnable} noValidate aria-label={t(locale, 'm8.adm.requestEnable')}>
            <Field
              id={`ev-${r.id}`}
              label={t(locale, 'm8.adm.evidenceRef')}
              help={t(locale, 'm8.adm.evidenceHelp')}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              )}
            </Field>
            <Field id={`vt-${r.id}`} label={t(locale, 'm8.adm.verifiedAt')}>
              {(x) => (
                <Input
                  {...x}
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary" disabled={a.busy}>
              {t(locale, 'm8.adm.requestEnable')}
            </Button>
          </form>
        )}
        {!r.enabled && (
          <>
            <Button
              disabled={a.busy || block !== null}
              onClick={() => act({ action: 'enable', id: r.id }, 'm8.adm.done.enable')}
              aria-describedby={`en-why-${r.id}`}
            >
              {t(locale, 'm8.adm.enable')}
            </Button>
            <p id={`en-why-${r.id}`} className="nz-muted">
              {block === 'no_permission'
                ? t(locale, 'm8.adm.enableNoPerm')
                : block === 'two_person'
                  ? t(locale, 'm8.adm.enableTwoPerson')
                  : block === 'blocked'
                    ? t(locale, 'm8.adm.enableBlocked')
                    : t(locale, 'm8.adm.enableReady')}
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

/** Create or edit a provider selection row. Credentials are vault references only. */
function ConfigureForm(p: {
  locale: Locale;
  mfaFactorId: string | null;
  edit: ProviderRow | null;
  onDone: () => void;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useStaffAction(locale, p.mfaFactorId);
  const [f, setF] = useState({
    service: p.edit?.service ?? 'database',
    family: p.edit?.family ?? '',
    providerCode: p.edit?.providerCode ?? '',
    account: p.edit?.providerAccountId ?? '',
    environment: p.edit?.environment ?? 'staging',
    adrRef: p.edit?.adrRef ?? '',
    config: '',
  });
  const [err, setErr] = useState<string | undefined>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const r = configureBody({ ...f, id: p.edit?.id });
    if (!r.body) return setErr(t(locale, `m8.adm.err.${r.error}` as 'm8.adm.err.config'));
    setErr(undefined);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/data-providers', { body: r.body as { action: 'configure' } }),
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'm8.adm.done.configure') });
        p.onDone();
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
      aria-label={t(locale, 'm8.adm.configure')}
      style={{ maxInlineSize: 640 }}
    >
      <h2 className="nz-h2">
        {p.edit
          ? t(locale, 'm8.adm.editing', { code: p.edit.providerCode })
          : t(locale, 'm8.adm.configure')}
      </h2>
      <p className="nz-muted">{t(locale, 'm8.adm.configureHelp')}</p>
      <Field id="dp-service" label={t(locale, 'm8.adm.service')}>
        {(x) => (
          <Select {...x} value={f.service} disabled={!!p.edit} onChange={set('service')}>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {tDynamic(locale, `m8.adm.svc.${s}`, s)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="dp-family" label={t(locale, 'm8.adm.family')}>
        {(x) => <Input {...x} dir="ltr" value={f.family} onChange={set('family')} />}
      </Field>
      <Field id="dp-code" label={t(locale, 'm8.adm.code')} help={t(locale, 'm8.adm.codeHelp')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.providerCode}
            disabled={!!p.edit}
            onChange={set('providerCode')}
          />
        )}
      </Field>
      <Field id="dp-account" label={t(locale, 'm8.adm.account')}>
        {(x) => <Input {...x} dir="ltr" value={f.account} onChange={set('account')} />}
      </Field>
      <Field id="dp-env" label={t(locale, 'm8.adm.env')}>
        {(x) => (
          <Select {...x} value={f.environment} onChange={set('environment')}>
            {ENVIRONMENTS.map((e) => (
              <option key={e} value={e}>
                {tDynamic(locale, `m8.adm.env.${e}`, e)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="dp-adr" label={t(locale, 'm8.adm.adrRef')}>
        {(x) => (
          <Input {...x} dir="ltr" value={f.adrRef} placeholder="ADR-000" onChange={set('adrRef')} />
        )}
      </Field>
      <Field
        id="dp-config"
        label={t(locale, 'm8.adm.config')}
        help={t(locale, 'm8.adm.configHelp')}
      >
        {(x) => (
          <textarea
            {...x}
            className="nz-input"
            dir="ltr"
            rows={4}
            value={f.config}
            placeholder='{"credentialRef": "vault://…"}'
            onChange={set('config')}
          />
        )}
      </Field>
      {p.edit && <p className="nz-muted">{t(locale, 'm8.adm.resetsProbe')}</p>}
      {err && (
        <p role="alert" className="nz-error-text">
          {err}
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

export function DataProvidersPanel(p: {
  locale: Locale;
  items: Schemas['DataProvider'][];
  meId: string;
  canManage: boolean;
  canApprove: boolean;
  mfaFactorId: string | null;
}) {
  const { locale, canManage } = p;
  const [edit, setEdit] = useState<ProviderRow | null>(null);
  const rows = p.items as unknown as ProviderRow[];
  // functions cannot cross the server/client boundary: the two platform permissions arrive as booleans
  const me = {
    id: p.meId,
    can: (perm: string) =>
      perm === 'admin:data:manage'
        ? p.canManage
        : perm === 'admin:data:approve'
          ? p.canApprove
          : false,
  };
  return (
    <>
      <Banner tone="warn">{t(locale, 'm8.adm.noSelection')}</Banner>
      {canManage && (
        <ConfigureForm
          key={edit?.id ?? 'new'}
          locale={locale}
          mfaFactorId={p.mfaFactorId}
          edit={edit}
          onDone={() => setEdit(null)}
        />
      )}
      <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
        {t(locale, 'm8.adm.rows')}
      </h2>
      {rows.length === 0 ? (
        <EmptyState title={t(locale, 'm8.adm.empty')} body={t(locale, 'm8.adm.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm8.adm.rows')}
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'p',
              header: t(locale, 'm8.adm.col.provider'),
              render: (r) => (
                <>
                  <Ltr>{`${r.providerCode}`}</Ltr>
                  <p className="nz-muted">
                    {tDynamic(locale, `m8.adm.svc.${r.service}`, r.service)} · <Ltr>{r.family}</Ltr>
                    {r.providerAccountId ? (
                      <>
                        {' · '}
                        <Ltr>{r.providerAccountId}</Ltr>
                      </>
                    ) : null}
                  </p>
                  {isDevReference(r) && <Badge tone="warn">{t(locale, 'm8.adm.devRef')}</Badge>}
                </>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'm8.adm.env'),
              render: (r) => tDynamic(locale, `m8.adm.env.${r.environment}`, r.environment),
            },
            {
              key: 's',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (r) => (
                <>
                  <Badge tone={r.enabled ? 'success' : undefined}>
                    {r.enabled ? t(locale, 'm8.adm.enabled') : t(locale, 'm8.adm.disabled')}
                  </Badge>
                  {r.enabled && r.enabledAt && (
                    <p className="nz-muted">{formatDateTime(r.enabledAt, locale)}</p>
                  )}
                </>
              ),
            },
            {
              key: 'pr',
              header: t(locale, 'm8.adm.probe'),
              render: (r) => {
                const pr = probeOf(r.probe);
                if (!pr) return t(locale, 'm8.adm.notProbed');
                const cs = capabilitySummary(pr.capabilities);
                return (
                  <>
                    <Badge tone={pr.passed ? 'success' : 'danger'}>
                      {pr.passed
                        ? t(locale, 'm8.adm.probePassed')
                        : t(locale, 'm8.adm.probeFailed')}
                    </Badge>
                    <p className="nz-muted">
                      {t(locale, 'm8.adm.evidenceKinds')}:{' '}
                      {pr.evidenceKinds.length === 0
                        ? '—'
                        : pr.evidenceKinds
                            .map((k) => tDynamic(locale, `m8.adm.kind.${k}`, k))
                            .join(', ')}
                    </p>
                    {pr.probedAt && (
                      <p className="nz-muted">{formatDateTime(pr.probedAt, locale)}</p>
                    )}
                    <details>
                      <summary>
                        {t(locale, 'm8.adm.capabilities', { ok: cs.supported, total: cs.total })}
                      </summary>
                      <ul>
                        {pr.capabilities.map(([k, v]) => (
                          <li key={k}>
                            <Ltr>{k}</Ltr>: {tDynamic(locale, `m8.adm.cap.${v}`, v)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </>
                );
              },
            },
            {
              key: 'a',
              header: t(locale, 'm8.adm.adr'),
              render: (r) => (
                <>
                  {r.adrRef ? <Ltr>{r.adrRef}</Ltr> : '—'}{' '}
                  <Badge tone={r.adrAcceptedAt ? 'success' : 'warn'}>
                    {r.adrAcceptedAt
                      ? t(locale, 'm8.adm.adrAccepted')
                      : t(locale, 'm8.adm.adrNotAccepted')}
                  </Badge>
                  <p className="nz-muted">
                    {t(locale, 'm8.adm.evidence')}:{' '}
                    {r.evidenceRef ? <Ltr>{r.evidenceRef}</Ltr> : '—'}
                    {r.verifiedAt ? ` · ${formatDateTime(r.verifiedAt, locale)}` : ''}
                  </p>
                </>
              ),
            },
            {
              key: 'tp',
              header: t(locale, 'm8.adm.twoPerson'),
              render: (r) => (
                <>
                  <p>
                    {t(locale, 'm8.adm.requestedBy')}:{' '}
                    {r.requestedBy ? <Ltr>{r.requestedBy.slice(0, 8)}</Ltr> : '—'}
                  </p>
                  <p>
                    {t(locale, 'm8.adm.approvedBy')}:{' '}
                    {r.approvedBy ? <Ltr>{r.approvedBy.slice(0, 8)}</Ltr> : '—'}
                  </p>
                </>
              ),
            },
            {
              key: 'b',
              header: t(locale, 'm8.adm.blockers'),
              icon: 'shield',
              render: (r) =>
                r.enabled ? (
                  '—'
                ) : r.blockers.length === 0 ? (
                  <Badge tone="success">{t(locale, 'm8.adm.noBlockers')}</Badge>
                ) : (
                  <ul>
                    {r.blockers.map((b) => (
                      <li key={b}>{tDynamic(locale, `m8.adm.blocker.${b}`, b)}</li>
                    ))}
                  </ul>
                ),
            },
            {
              key: 'x',
              header: t(locale, 'field.action'),
              icon: 'code',
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
      <p className="nz-muted">{t(locale, 'm8.adm.enableRules')}</p>
    </>
  );
}
