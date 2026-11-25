'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Banner, Button, Card, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  CORS_METHODS,
  POLICY_ACTIONS,
  SIGNED_DEFAULT_TTL,
  SIGNED_MAX_TTL,
  SIGNED_METHODS,
  dataError,
  draftToPolicy,
  draftToRules,
  emptyRule,
  ifMatch,
  needsPublicConfirm,
  newKey,
  offerKey,
  policyToDraft,
  positiveInt,
  reservedBucketName,
  rulesToDraft,
  signedUrlBody,
  validResourceName,
  type CorsMethod,
  type LifecycleCaps,
  type PolicyAction,
  type PolicyDoc,
  type PolicyDraft,
} from '../lib/data';
import { ConfirmDialog, CopyButton, Note, useCall, type DataNotice } from './DataUi';
import { QuoteSummary } from './DataParts';

type Bucket = Schemas['Bucket'];

/* ------------------------------------------------------------------ UI-M08-06 */

/** Create a bucket: estimate (quote kind storage) → confirm. Buckets are private by default; the namespace comes from the organization. */
export function NewBucketForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [name, setName] = useState('');
  const [gb, setGb] = useState('10');
  const [region, setRegion] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Schemas['Quote'] | null>(null);
  const [quoted, setQuoted] = useState('');
  const [refused, setRefused] = useState<Record<string, NonNullable<DataNotice>>>({});
  const [quoteKey, setQuoteKey] = useState(newKey());
  const [createKey, setCreateKey] = useState(newKey());

  const item: Record<string, unknown> = {
    estimatedGb: Number(gb),
    ...(region.trim() ? { region: region.trim() } : {}),
  };
  const current = `${offerKey({ engine: 'storage', ...item })}|${name}|${versioning}`;
  const stale = quote !== null && quoted !== current;
  const refusal = refused[offerKey({ engine: 'storage', ...item })];

  function validate() {
    const e: Record<string, string> = {};
    if (!validResourceName(name) || reservedBucketName(name)) e.name = t(locale, 'm8.stn.err.name');
    if (!positiveInt(gb, 999_999)) e.gb = t(locale, 'm8.stn.err.gb');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function estimate(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setQuote(null);
    void call.run(
      () =>
        browserApi().POST('/v1/quotes', {
          params: { header: { 'Idempotency-Key': quoteKey } },
          body: { kind: 'storage', items: [item] },
        }),
      (q) => {
        setQuote(q);
        setQuoted(current);
        setQuoteKey(newKey());
      },
      (p) => {
        setQuoteKey(newKey());
        if (
          p.code === 'unsupported_capability' ||
          p.code === 'residency_denied' ||
          p.code === 'kind_not_available'
        ) {
          const m = dataError(locale, p);
          setRefused((r) => ({
            ...r,
            [offerKey({ engine: 'storage', ...item })]: {
              tone: 'error',
              text: m.text,
              detail: m.detail,
            },
          }));
          return true; // shown once, as the greyed-out reason
        }
      },
    );
  }

  function confirm() {
    if (!quote || stale) return;
    void call.run(
      () =>
        browserApi().POST('/v1/storage/buckets', {
          params: { header: { 'Idempotency-Key': createKey } },
          body: {
            name,
            quoteId: quote.id,
            versioning,
            ...(region.trim() ? { region: region.trim() } : {}),
          },
        }),
      (b) => {
        setCreateKey(newKey());
        router.push(`/storage/buckets/${b.id}`);
        router.refresh();
      },
    );
  }

  return (
    <>
      <form
        onSubmit={estimate}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm8.stn.title')}
        style={{ maxInlineSize: 600 }}
      >
        <Field
          id="stn-name"
          label={t(locale, 'field.name')}
          help={t(locale, 'm8.stn.nameHelp')}
          error={errors.name}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
          )}
        </Field>
        <Field
          id="stn-gb"
          label={t(locale, 'm8.stn.estimatedGb')}
          help={t(locale, 'm8.stn.estimatedHelp')}
          error={errors.gb}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={gb}
              onChange={(e) => setGb(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="stn-region"
          label={t(locale, 'm8.dbn.region')}
          help={t(locale, 'm8.dbn.regionHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              value={region}
              maxLength={60}
              onChange={(e) => setRegion(e.target.value)}
            />
          )}
        </Field>
        <label className="nz-row">
          <input
            type="checkbox"
            checked={versioning}
            onChange={(e) => setVersioning(e.target.checked)}
          />
          {t(locale, 'm8.stn.versioning')}
        </label>
        <p className="nz-muted">{t(locale, 'm8.stn.privateDefault')}</p>
        {refusal && (
          <Banner tone="warn">
            {refusal.text}
            {refusal.detail && (
              <>
                {' '}
                <bdi dir="auto">{refusal.detail}</bdi>
              </>
            )}
          </Banner>
        )}
        <Button type="submit" disabled={call.busy || !!refusal}>
          {t(locale, 'm8.q.request')}
        </Button>
        {refusal && <p className="nz-muted">{t(locale, 'm8.dbn.greyed')}</p>}
        {!quote && <Note n={call.notice} />}
      </form>
      {call.panel}
      {quote && (
        <>
          <QuoteSummary locale={locale} quote={quote} />
          {stale && <Banner tone="warn">{t(locale, 'm8.q.changed')}</Banner>}
          <p>
            <Button disabled={call.busy || stale} onClick={confirm}>
              {t(locale, 'm8.q.confirm')}
            </Button>
          </p>
          <Note n={call.notice} />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-07 */

const toggle = <T,>(list: T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/**
 * Access policy editor: a structured form for the deny-by-default subset (access, allow statements, CORS). Choosing public-read always goes through
 * a warning dialog with an explicit confirmation (`confirmPublic`) and, when the API asks, an MFA step-up. The If-Match header is the policy's ETag.
 */
export function PolicyEditor({
  locale,
  bucketId,
  policy,
  etag,
  canAdmin,
  mfaFactorId,
}: {
  locale: Locale;
  bucketId: string;
  policy: PolicyDoc;
  etag: string;
  canAdmin: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [draft, setDraft] = useState<PolicyDraft>(policyToDraft(policy));
  const [error, setError] = useState<string | undefined>();
  const [warn, setWarn] = useState<PolicyDoc | null>(null);
  const [ack, setAck] = useState(false);
  // a new policy version from the server (after a save) replaces the draft; the notice stays (the page no longer remounts this editor by ETag)
  const [seenEtag, setSeenEtag] = useState(etag);
  if (etag !== seenEtag) {
    setSeenEtag(etag);
    setDraft(policyToDraft(policy));
    setError(undefined);
    setWarn(null);
    setAck(false);
  }

  const put = (doc: PolicyDoc, confirmPublic: boolean) =>
    void call.run(
      () =>
        browserApi().PUT('/v1/storage/buckets/{id}/access-policy', {
          params: { path: { id: bucketId }, header: { 'If-Match': ifMatch(etag) } },
          body: { policy: doc, ...(confirmPublic ? { confirmPublic: true } : {}) },
        }),
      () => {
        setWarn(null);
        setAck(false);
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.stb.policySaved') });
        router.refresh();
      },
      (p) => {
        if (p.status === 412) {
          setWarn(null);
          call.setNotice({ tone: 'error', text: t(locale, 'm8.err.stale') });
          return true;
        }
      },
    );

  function save(ev: FormEvent) {
    ev.preventDefault();
    const r = draftToPolicy(draft);
    if (!r.policy) {
      return setError(
        t(locale, `m8.stb.err.${r.error}` as 'm8.stb.err.actions', { n: (r.index ?? 0) + 1 }),
      );
    }
    setError(undefined);
    if (needsPublicConfirm(r.policy.access)) {
      setWarn(r.policy);
      return;
    }
    put(r.policy, false);
  }

  const setStatement = (i: number, patch: Partial<PolicyDraft['statements'][number]>) =>
    setDraft((d) => ({
      ...d,
      statements: d.statements.map((s, k) => (k === i ? { ...s, ...patch } : s)),
    }));
  const setCors = (i: number, patch: Partial<PolicyDraft['cors'][number]>) =>
    setDraft((d) => ({ ...d, cors: d.cors.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));

  return (
    <>
      <form onSubmit={save} noValidate className="nz-card" aria-label={t(locale, 'm8.stb.policy')}>
        <h2 className="nz-h2">{t(locale, 'm8.stb.policy')}</h2>
        <p className="nz-muted">{t(locale, 'm8.stb.policyHelp')}</p>
        <Field id="pol-access" label={t(locale, 'm8.stb.access')}>
          {(x) => (
            <Select
              {...x}
              value={draft.access}
              disabled={!canAdmin}
              onChange={(e) =>
                setDraft({ ...draft, access: e.target.value as PolicyDraft['access'] })
              }
            >
              <option value="private">{t(locale, 'm8.stb.access.private')}</option>
              <option value="public-read">{t(locale, 'm8.stb.access.public')}</option>
            </Select>
          )}
        </Field>
        {draft.access === 'public-read' && (
          <Banner tone="danger">{t(locale, 'm8.stb.publicWarning')}</Banner>
        )}

        <h3>{t(locale, 'm8.stb.statements')}</h3>
        {draft.statements.length === 0 && (
          <p className="nz-muted">{t(locale, 'm8.stb.noStatements')}</p>
        )}
        {draft.statements.map((s, i) => (
          <fieldset key={i} className="nz-card" style={{ marginBlockEnd: 8 }}>
            <legend>{t(locale, 'm8.stb.statement', { n: i + 1 })}</legend>
            <div className="nz-row">
              {POLICY_ACTIONS.map((a: PolicyAction) => (
                <label key={a} className="nz-row">
                  <input
                    type="checkbox"
                    disabled={!canAdmin}
                    checked={s.actions.includes(a)}
                    onChange={() => setStatement(i, { actions: toggle(s.actions, a) })}
                  />
                  {t(locale, `m8.stb.action.${a}`)}
                </label>
              ))}
            </div>
            <Field
              id={`pol-prefix-${i}`}
              label={t(locale, 'm8.stb.prefix')}
              help={t(locale, 'm8.stb.prefixHelp')}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  disabled={!canAdmin}
                  value={s.prefix}
                  onChange={(e) => setStatement(i, { prefix: e.target.value })}
                />
              )}
            </Field>
            {canAdmin && (
              <Button
                variant="secondary"
                onClick={() =>
                  setDraft({ ...draft, statements: draft.statements.filter((_, k) => k !== i) })
                }
              >
                {t(locale, 'action.remove')}
              </Button>
            )}
          </fieldset>
        ))}
        {canAdmin && (
          <p>
            <Button
              variant="secondary"
              onClick={() =>
                setDraft({
                  ...draft,
                  statements: [...draft.statements, { actions: ['read'], prefix: '' }],
                })
              }
            >
              {t(locale, 'm8.stb.addStatement')}
            </Button>
          </p>
        )}

        <h3>{t(locale, 'm8.stb.cors')}</h3>
        {draft.cors.length === 0 && <p className="nz-muted">{t(locale, 'm8.stb.noCors')}</p>}
        {draft.cors.map((c, i) => (
          <fieldset key={i} className="nz-card" style={{ marginBlockEnd: 8 }}>
            <legend>{t(locale, 'm8.stb.corsRule', { n: i + 1 })}</legend>
            <Field
              id={`cors-o-${i}`}
              label={t(locale, 'm8.stb.origins')}
              help={t(locale, 'm8.stb.originsHelp')}
            >
              {(x) => (
                <textarea
                  {...x}
                  className="nz-input"
                  dir="ltr"
                  rows={2}
                  disabled={!canAdmin}
                  value={c.origins}
                  onChange={(e) => setCors(i, { origins: e.target.value })}
                />
              )}
            </Field>
            <div className="nz-row">
              {CORS_METHODS.map((m: CorsMethod) => (
                <label key={m} className="nz-row">
                  <input
                    type="checkbox"
                    disabled={!canAdmin}
                    checked={c.methods.includes(m)}
                    onChange={() => setCors(i, { methods: toggle(c.methods, m) })}
                  />
                  <Ltr>{m}</Ltr>
                </label>
              ))}
            </div>
            <Field id={`cors-a-${i}`} label={t(locale, 'm8.stb.maxAge')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="numeric"
                  disabled={!canAdmin}
                  value={c.maxAge}
                  onChange={(e) => setCors(i, { maxAge: e.target.value })}
                />
              )}
            </Field>
            {canAdmin && (
              <Button
                variant="secondary"
                onClick={() => setDraft({ ...draft, cors: draft.cors.filter((_, k) => k !== i) })}
              >
                {t(locale, 'action.remove')}
              </Button>
            )}
          </fieldset>
        ))}
        {canAdmin && (
          <p>
            <Button
              variant="secondary"
              onClick={() =>
                setDraft({
                  ...draft,
                  cors: [...draft.cors, { origins: '', methods: ['GET'], maxAge: '3600' }],
                })
              }
            >
              {t(locale, 'm8.stb.addCors')}
            </Button>
          </p>
        )}
        {error && (
          <p role="alert" className="nz-error-text">
            {error}
          </p>
        )}
        {canAdmin ? (
          <Button type="submit" disabled={call.busy}>
            {t(locale, 'm8.stb.savePolicy')}
          </Button>
        ) : (
          <p className="nz-muted">{t(locale, 'm8.c.noPermission')}</p>
        )}
        <Note n={call.notice} />
      </form>
      {warn === null && call.panel}
      <ConfirmDialog
        open={warn !== null}
        title={t(locale, 'm8.stb.publicTitle')}
        onClose={() => {
          setWarn(null);
          setAck(false);
        }}
      >
        <Banner tone="danger">{t(locale, 'm8.stb.publicWarning')}</Banner>
        <label className="nz-row">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {t(locale, 'm8.stb.publicAck')}
        </label>
        <Note n={call.notice} />
        <div className="nz-row">
          <Button
            variant="danger"
            disabled={!ack || call.busy}
            onClick={() => warn && put(warn, true)}
          >
            {t(locale, 'm8.stb.publicConfirm')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setWarn(null);
              setAck(false);
            }}
          >
            {t(locale, 'action.cancel')}
          </Button>
        </div>
        {call.panel}
      </ConfirmDialog>
    </>
  );
}

/** Lifecycle rules. Only the actions the provider reports as supported are shown (`capabilities`); nothing hidden is ever sent. */
export function LifecycleEditor({
  locale,
  bucketId,
  rules,
  caps,
  canWrite,
  mfaFactorId,
}: {
  locale: Locale;
  bucketId: string;
  rules: Schemas['LifecycleRule'][];
  caps: LifecycleCaps;
  canWrite: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [drafts, setDrafts] = useState(rulesToDraft(rules));
  const [error, setError] = useState<string | undefined>();
  const any = !!(caps.expiry || caps.abortMultipart || caps.transition);
  const set = (i: number, patch: Partial<(typeof drafts)[number]>) =>
    setDrafts((d) => d.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  function save(ev: FormEvent) {
    ev.preventDefault();
    const r = draftToRules(drafts, caps);
    if (!r.rules)
      return setError(
        t(locale, `m8.stb.lc.err.${r.error}` as 'm8.stb.lc.err.id', { n: (r.index ?? 0) + 1 }),
      );
    setError(undefined);
    void call.run(
      () =>
        browserApi().PUT('/v1/storage/buckets/{id}/lifecycle', {
          params: { path: { id: bucketId } },
          body: { rules: r.rules as never },
        }),
      () => {
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.stb.lc.saved') });
        router.refresh();
      },
    );
  }

  return (
    <form onSubmit={save} noValidate className="nz-card" aria-label={t(locale, 'm8.stb.lifecycle')}>
      <h2 className="nz-h2">{t(locale, 'm8.stb.lifecycle')}</h2>
      {!any && <Banner tone="warn">{t(locale, 'm8.stb.lc.none')}</Banner>}
      {any && drafts.length === 0 && <p className="nz-muted">{t(locale, 'm8.stb.lc.empty')}</p>}
      {any &&
        drafts.map((r, i) => (
          <fieldset key={i} className="nz-card" style={{ marginBlockEnd: 8 }}>
            <legend>{t(locale, 'm8.stb.lc.rule', { n: i + 1 })}</legend>
            <Field id={`lc-id-${i}`} label={t(locale, 'm8.stb.lc.id')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  disabled={!canWrite}
                  value={r.id}
                  onChange={(e) => set(i, { id: e.target.value })}
                />
              )}
            </Field>
            <Field id={`lc-prefix-${i}`} label={t(locale, 'm8.stb.prefix')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  disabled={!canWrite}
                  value={r.prefix}
                  onChange={(e) => set(i, { prefix: e.target.value })}
                />
              )}
            </Field>
            {caps.expiry && (
              <Field id={`lc-exp-${i}`} label={t(locale, 'm8.stb.lc.expire')}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    inputMode="numeric"
                    disabled={!canWrite}
                    value={r.expireDays}
                    onChange={(e) => set(i, { expireDays: e.target.value })}
                  />
                )}
              </Field>
            )}
            {caps.abortMultipart && (
              <Field id={`lc-abort-${i}`} label={t(locale, 'm8.stb.lc.abort')}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    inputMode="numeric"
                    disabled={!canWrite}
                    value={r.abortDays}
                    onChange={(e) => set(i, { abortDays: e.target.value })}
                  />
                )}
              </Field>
            )}
            {caps.transition && (
              <>
                <Field id={`lc-td-${i}`} label={t(locale, 'm8.stb.lc.transitionDays')}>
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      inputMode="numeric"
                      disabled={!canWrite}
                      value={r.transitionDays}
                      onChange={(e) => set(i, { transitionDays: e.target.value })}
                    />
                  )}
                </Field>
                <Field id={`lc-tc-${i}`} label={t(locale, 'm8.stb.lc.transitionClass')}>
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      disabled={!canWrite}
                      value={r.transitionClass}
                      onChange={(e) => set(i, { transitionClass: e.target.value })}
                    />
                  )}
                </Field>
              </>
            )}
            {canWrite && (
              <Button
                variant="secondary"
                onClick={() => setDrafts((d) => d.filter((_, k) => k !== i))}
              >
                {t(locale, 'action.remove')}
              </Button>
            )}
          </fieldset>
        ))}
      {any && canWrite && (
        <p>
          <Button
            variant="secondary"
            onClick={() => setDrafts((d) => [...d, emptyRule(d.length + 1)])}
          >
            {t(locale, 'm8.stb.lc.add')}
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="nz-error-text">
          {error}
        </p>
      )}
      {any && canWrite && (
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'action.save')}
        </Button>
      )}
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}

/** Signed URL tool: the URL is shown once, can be copied, and is never stored (state only; it is dropped on leaving the page). */
export function SignedUrlTool({
  locale,
  bucketId,
  canWrite,
  mfaFactorId,
}: {
  locale: Locale;
  bucketId: string;
  canWrite: boolean;
  mfaFactorId: string | null;
}) {
  const call = useCall(locale, mfaFactorId);
  const [key, setKey] = useState('');
  const [method, setMethod] = useState<string>('GET');
  const [ttl, setTtl] = useState(String(SIGNED_DEFAULT_TTL));
  const [idem, setIdem] = useState(newKey());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ url: string; expiresAt: string; method: string } | null>(
    null,
  );
  useEffect(() => () => setResult(null), []);

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const b = signedUrlBody({ key, method, ttl });
    if (!b.body) {
      setErrors(
        b.error === 'key'
          ? { key: t(locale, 'm8.stb.su.err.key') }
          : { ttl: t(locale, 'm8.stb.su.err.ttl', { max: SIGNED_MAX_TTL }) },
      );
      return;
    }
    setErrors({});
    setResult(null);
    void call.run(
      () =>
        browserApi().POST('/v1/storage/buckets/{id}/signed-urls', {
          params: { path: { id: bucketId }, header: { 'Idempotency-Key': idem } },
          body: b.body as never,
        }),
      (r) => {
        setIdem(newKey());
        setResult(r);
      },
      () => setIdem(newKey()),
    );
  }

  return (
    <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'm8.stb.signed')}>
      <h2 className="nz-h2">{t(locale, 'm8.stb.signed')}</h2>
      <p className="nz-muted">{t(locale, 'm8.stb.signedHelp')}</p>
      <Field id="su-key" label={t(locale, 'm8.stb.su.key')} error={errors.key}>
        {(x) => <Input {...x} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />}
      </Field>
      <Field id="su-method" label={t(locale, 'm8.stb.su.method')}>
        {(x) => (
          <Select {...x} value={method} onChange={(e) => setMethod(e.target.value)}>
            {SIGNED_METHODS.map((m) => (
              <option key={m} value={m} disabled={!canWrite && (m === 'PUT' || m === 'DELETE')}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="su-ttl"
        label={t(locale, 'm8.stb.su.ttl')}
        help={t(locale, 'm8.stb.su.ttlHelp', { def: SIGNED_DEFAULT_TTL, max: SIGNED_MAX_TTL })}
        error={errors.ttl}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm8.stb.su.create')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
      {result && (
        <Card aria-label={t(locale, 'm8.stb.su.result')}>
          <p>{t(locale, 'm8.stb.su.once')}</p>
          <p>
            <output data-testid="signed-url" style={{ overflowWrap: 'anywhere' }}>
              <Ltr>{result.url}</Ltr>
            </output>
          </p>
          <div className="nz-row">
            <CopyButton locale={locale} text={result.url} label={t(locale, 'm8.stb.su.copy')} />
            <Button variant="secondary" onClick={() => setResult(null)}>
              {t(locale, 'm8.stb.su.clear')}
            </Button>
          </div>
        </Card>
      )}
    </form>
  );
}

/** Delete a bucket: type its name; deleting with objects (force) needs `data:storage:admin` and a recent MFA check (the API asks for it). */
export function DeleteBucket({
  locale,
  bucket,
  canAdmin,
  mfaFactorId,
}: {
  locale: Locale;
  bucket: Bucket;
  canAdmin: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [typed, setTyped] = useState('');
  const [force, setForce] = useState(false);
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (typed.trim() !== bucket.name) return;
    void call.run(
      () =>
        browserApi().DELETE('/v1/storage/buckets/{id}', {
          params: {
            path: { id: bucket.id },
            query: { confirmName: typed.trim(), ...(force ? { force: 'true' } : {}) },
          },
        }),
      () => {
        router.push(`/storage/buckets`);
        router.refresh();
      },
      (p) => {
        if (p.status === 409 && p.code !== 'name_taken') {
          call.setNotice({ tone: 'error', text: t(locale, 'm8.stb.notEmpty') });
          return true;
        }
      },
    );
  }
  return (
    <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'm8.stb.delete')}>
      <h2 className="nz-h2">{t(locale, 'm8.stb.delete')}</h2>
      <p>{t(locale, 'm8.stb.deleteHelp')}</p>
      <Field id="bk-confirm" label={t(locale, 'm8.stb.typeName', { name: bucket.name })}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
      </Field>
      {canAdmin && (
        <label className="nz-row">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          {t(locale, 'm8.stb.force')}
        </label>
      )}
      <Button type="submit" variant="danger" disabled={call.busy || typed.trim() !== bucket.name}>
        {t(locale, 'm8.stb.deleteAction')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}
