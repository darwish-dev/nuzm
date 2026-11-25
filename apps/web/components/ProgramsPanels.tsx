'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { ifMatch, newKey } from '../lib/data';
import {
  ACTING_COOKIE,
  DEFAULT_GRANT_DAYS,
  DELEGABLE_SCOPES,
  MAX_GRANT_DAYS,
  SCOPE_KEY,
  bpsToPercent,
  checkExpiry,
  dateIn,
  defaultEffectiveFrom,
  effectiveFromIso,
  effectiveFromOk,
  expiryOf,
  isBelowCost,
  isUuid,
  marginPreview,
  moneyText,
  percentToBps,
  retailPreview,
  type Markup,
  type RuleSetDto,
} from '../lib/m11';
import { Note } from './DataUi';
import { IssueList, useM11Call } from './M11Ui';

/* ------------------------------------------------------------------ profiles */

/** Create the agency or reseller profile of the current organization (the API requires the organization type to match). */
export function CreateProfileButton({
  locale,
  kind,
  mfaFactorId,
}: {
  locale: Locale;
  kind: 'agency' | 'reseller';
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  return (
    <div>
      <Button
        disabled={call.busy}
        onClick={() =>
          void call.run(
            () =>
              kind === 'agency'
                ? browserApi().POST('/v1/agencies', {
                    params: { header: { 'Idempotency-Key': newKey() } },
                    body: {},
                  })
                : browserApi().POST('/v1/resellers', {
                    params: { header: { 'Idempotency-Key': newKey() } },
                    body: {},
                  }),
            () => router.refresh(),
          )
        }
      >
        {t(locale, kind === 'agency' ? 'm11.ag.createProfile' : 'm11.rs.createProfile')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
    </div>
  );
}

/* ------------------------------------------------------------------ UI-M11-11: invite a client */

export function InviteClientForm({
  locale,
  agencyId,
  mfaFactorId,
}: {
  locale: Locale;
  agencyId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [org, setOrg] = useState('');
  const [err, setErr] = useState<string | undefined>();
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!isUuid(org.trim())) return setErr(t(locale, 'm11.ag.errOrgId'));
    setErr(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/agencies/{id}/clients', {
          params: { path: { id: agencyId }, header: { 'Idempotency-Key': newKey() } },
          body: { clientOrgId: org.trim().toLowerCase() },
        }),
      () => {
        setOrg('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.ag.invited') });
        router.refresh();
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.ag.invite')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.ag.invite')}</h2>
      <p className="nz-muted">{t(locale, 'm11.ag.inviteHelp')}</p>
      <Field
        id="ag-client"
        label={t(locale, 'm11.ag.clientOrgId')}
        help={t(locale, 'm11.ag.clientOrgIdHelp')}
        error={err}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            autoComplete="off"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm11.ag.inviteAction')}
      </Button>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M11-12: propose a grant */

/**
 * Propose delegated access to one client: scopes from the delegable catalogue and a MANDATORY expiry (default 90 days, at most 365). The proposal does nothing until the client's administrator
 * accepts it. Scopes and expiry never change after creation, and revoking is SCR-M11-01 (not available): the page shows that as a disabled control.
 */
export function ProposeGrantForm({
  locale,
  agencyId,
  clientOrgId,
  mfaFactorId,
}: {
  locale: Locale;
  agencyId: string;
  clientOrgId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [scopes, setScopes] = useState<string[]>([]);
  const [day, setDay] = useState(dateIn(DEFAULT_GRANT_DAYS));
  const [err, setErr] = useState<{ scopes?: string; expiry?: string }>({});
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const s of DELEGABLE_SCOPES)
      g.set(s.split(':')[0]!, [...(g.get(s.split(':')[0]!) ?? []), s]);
    return [...g.entries()];
  }, []);
  const toggle = (s: string) =>
    setScopes((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const e: { scopes?: string; expiry?: string } = {};
    if (scopes.length === 0) e.scopes = t(locale, 'm11.gr.errScopes');
    const c = checkExpiry(day);
    if (c !== 'ok') e.expiry = t(locale, `m11.gr.errExpiry.${c}`, { max: MAX_GRANT_DAYS });
    setErr(e);
    if (e.scopes || e.expiry) return;
    void call.run(
      () =>
        browserApi().POST('/v1/agencies/{id}/delegated-access', {
          params: { path: { id: agencyId }, header: { 'Idempotency-Key': newKey() } },
          body: { clientOrgId, scopes, expiresAt: expiryOf(day) },
        }),
      () => {
        setScopes([]);
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.gr.proposed') });
        router.refresh();
      },
    );
  }
  return (
    <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'm11.gr.propose')}>
      <h2 className="nz-h2">{t(locale, 'm11.gr.propose')}</h2>
      <p className="nz-muted">{t(locale, 'm11.gr.proposeHelp')}</p>
      <fieldset aria-describedby={err.scopes ? 'gr-scopes-err' : undefined}>
        <legend>{t(locale, 'm11.gr.scopes')}</legend>
        <p className="nz-help">{t(locale, 'm11.gr.scopesHelp')}</p>
        {groups.map(([g, list]) => (
          <fieldset key={g}>
            <legend>
              <Ltr>{g}</Ltr>
            </legend>
            <div className="nz-row">
              {list.map((s) => (
                <label key={s} className="nz-row">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                  <Ltr>{s}</Ltr>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {err.scopes && (
          <p id="gr-scopes-err" role="alert" className="nz-error-text">
            {err.scopes}
          </p>
        )}
      </fieldset>
      <Field
        id="gr-expiry"
        label={t(locale, 'm11.gr.expiry')}
        help={t(locale, 'm11.gr.expiryHelp', { default: DEFAULT_GRANT_DAYS, max: MAX_GRANT_DAYS })}
        error={err.expiry}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            type="date"
            required
            min={dateIn(1)}
            max={dateIn(MAX_GRANT_DAYS - 1)}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm11.gr.proposeAction')}
      </Button>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M11-13: acting as a client */

const setActing = (id: string | null) => {
  document.cookie = id
    ? `${ACTING_COOKIE}=${id}; path=/; samesite=lax`
    : `${ACTING_COOKIE}=; path=/; max-age=0; samesite=lax`;
};

/** Start or stop acting in a client organization (the choice is a cookie hint; the API checks the link, the grant and its expiry on every request that carries the header). */
export function ActingControls({
  locale,
  clientOrgId,
  active,
  canAct,
}: {
  locale: Locale;
  clientOrgId: string;
  active: boolean;
  canAct: boolean;
}) {
  const router = useRouter();
  return active ? (
    <Button
      variant="secondary"
      onClick={() => {
        setActing(null);
        router.refresh();
      }}
    >
      {t(locale, 'm11.act.stop')}
    </Button>
  ) : (
    <Button
      disabled={!canAct}
      onClick={() => {
        setActing(clientOrgId);
        router.refresh();
      }}
    >
      {t(locale, 'm11.act.start')}
    </Button>
  );
}

/** Switch between the clients that may be acted in (or back to the agency's own context). */
export function ActingSwitcher({
  locale,
  current,
  clients,
}: {
  locale: Locale;
  current: string | undefined;
  clients: { clientOrgId: string }[];
}) {
  const router = useRouter();
  return (
    <label>
      <span className="nz-sr">{t(locale, 'm11.act.switcher')}</span>
      <select
        className="nz-input"
        aria-label={t(locale, 'm11.act.switcher')}
        value={current ?? ''}
        onChange={(e) => {
          setActing(e.target.value || null);
          if (e.target.value) router.push(`/agency/acting/${e.target.value}`);
          else router.refresh();
        }}
      >
        <option value="">{t(locale, 'm11.act.own')}</option>
        {clients.map((c) => (
          <option key={c.clientOrgId} value={c.clientOrgId}>
            {c.clientOrgId}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The persistent client-context banner: shown on EVERY page of the console while an agency member is acting in a client organization. */
export function ActingBanner({ locale, clientOrgId }: { locale: Locale; clientOrgId: string }) {
  const router = useRouter();
  return (
    <div className="nz-banner" data-tone="danger" role="status" data-testid="acting-banner">
      <span className="nz-row">
        <strong>{t(locale, 'm11.act.banner', { client: clientOrgId })}</strong>
        <span>{t(locale, 'm11.act.bannerScope')}</span>
        <a href={`/agency/acting/${clientOrgId}`}>{t(locale, 'm11.act.manage')}</a>
        <Button
          variant="secondary"
          onClick={() => {
            setActing(null);
            router.refresh();
          }}
        >
          {t(locale, 'm11.act.stop')}
        </Button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ UI-M11-19 (client side): answer link requests and grant proposals */

export function AnswerRequest({
  locale,
  kind,
  agencyId,
  id,
  mfaFactorId,
  resellerId,
}: {
  locale: Locale;
  kind: 'link' | 'grant' | 'reseller';
  agencyId: string;
  id: string;
  mfaFactorId: string | null;
  resellerId?: string;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const answer = (decision: 'accept' | 'decline') =>
    void call.run(
      () =>
        kind === 'link'
          ? browserApi().POST('/v1/agencies/{id}/clients', {
              params: { path: { id: agencyId }, header: { 'Idempotency-Key': newKey() } },
              body: { linkId: id, decision },
            })
          : kind === 'grant'
            ? browserApi().POST('/v1/agencies/{id}/delegated-access', {
                params: { path: { id: agencyId }, header: { 'Idempotency-Key': newKey() } },
                body: { grantId: id, decision },
              })
            : browserApi().POST('/v1/resellers/{id}/sub-organizations', {
                params: {
                  path: { id: resellerId ?? agencyId },
                  header: { 'Idempotency-Key': newKey() },
                },
                body: { linkId: id, decision },
              }),
      () => router.refresh(),
    );
  return (
    <div>
      <div className="nz-row">
        <Button disabled={call.busy} onClick={() => answer('accept')}>
          {t(locale, 'm11.pt.accept')}
        </Button>
        <Button variant="secondary" disabled={call.busy} onClick={() => answer('decline')}>
          {t(locale, 'm11.pt.decline')}
        </Button>
      </div>
      <Note n={call.notice} />
      {call.panel}
    </div>
  );
}

/* ------------------------------------------------------------------ UI-M11-16: link a sub-organization */

export function LinkSubOrgForm({
  locale,
  resellerId,
  mfaFactorId,
}: {
  locale: Locale;
  resellerId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [org, setOrg] = useState('');
  const [book, setBook] = useState('');
  const [err, setErr] = useState<string | undefined>();
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!isUuid(org.trim())) return setErr(t(locale, 'm11.ag.errOrgId'));
    setErr(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/resellers/{id}/sub-organizations', {
          params: { path: { id: resellerId }, header: { 'Idempotency-Key': newKey() } },
          body: {
            subOrgId: org.trim().toLowerCase(),
            ...(book.trim() ? { priceBookRef: book.trim() } : {}),
          },
        }),
      () => {
        setOrg('');
        setBook('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.rs.linked') });
        router.refresh();
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.rs.link')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.rs.link')}</h2>
      <p className="nz-muted">{t(locale, 'm11.rs.linkHelp')}</p>
      <Banner tone="warn">{t(locale, 'm11.rs.createUnavailable')}</Banner>
      <Field
        id="rs-sub"
        label={t(locale, 'm11.rs.subOrgId')}
        help={t(locale, 'm11.ag.clientOrgIdHelp')}
        error={err}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            autoComplete="off"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
        )}
      </Field>
      <Field
        id="rs-book"
        label={t(locale, 'm11.rs.priceBookRef')}
        help={t(locale, 'm11.rs.priceBookRefHelp')}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            maxLength={200}
            value={book}
            onChange={(e) => setBook(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm11.rs.linkAction')}
      </Button>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M11-17: price rules */

interface Row {
  key: string;
  scope: 'plan' | 'meter';
  scopeKey: string;
  type: 'percent' | 'fixed';
  value: string;
  day: string;
}
const rowFromRule = (r: RuleSetDto['rules'][number], i: number): Row => ({
  key: `r${i}`,
  scope: r.scope,
  scopeKey: r.scopeKey,
  type: r.markup.type,
  value: r.markup.type === 'percent' ? bpsToPercent(r.markup.bps) : r.markup.amountMinor,
  day: r.effectiveFrom.slice(0, 10),
});

/** The markup a row describes, or null when its value is not a valid figure; a negative value is returned as negative (it is blocked, not coerced). */
function markupOf(r: Row, currency: string): Markup | null {
  if (r.type === 'percent') {
    const bps = percentToBps(r.value);
    return bps === null ? null : { type: 'percent', bps };
  }
  return /^-?\d{1,15}$/.test(r.value.trim())
    ? { type: 'fixed', amountMinor: r.value.trim(), currency }
    : null;
}

/**
 * The price-rule editor with a margin preview. retail = wholesale + markup is computed here for a SAMPLE wholesale figure only to show what a rule does; the API is the authority. A rule
 * that would sell BELOW COST (a negative markup) is blocked here and refused by the API (`below_cost`). Saving replaces the whole rule set with a new version (`If-Match` = the version
 * you loaded; another save in between answers 412).
 */
export function PriceRulesEditor({
  locale,
  resellerId,
  currency,
  ruleSet,
  canEdit,
  mfaFactorId,
}: {
  locale: Locale;
  resellerId: string;
  currency: string;
  ruleSet: RuleSetDto;
  canEdit: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [rows, setRows] = useState<Row[]>(ruleSet.rules.map(rowFromRule));
  // a new version from the server (after a save) replaces the rows; the notice and the other state stay (the page no longer remounts this editor by version)
  const [seenVersion, setSeenVersion] = useState(ruleSet.version);
  if (ruleSet.version !== seenVersion) {
    setSeenVersion(ruleSet.version);
    setRows(ruleSet.rules.map(rowFromRule));
  }
  const [sample, setSample] = useState('10000');
  const [shown, setShown] = useState(false);
  const patch = (key: string, p: Partial<Row>) =>
    setRows((l) => l.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const sampleOk = /^\d{1,12}$/.test(sample.trim());

  const view = rows.map((r) => {
    const m = markupOf(r, currency);
    const errors: string[] = [];
    if (!SCOPE_KEY.test(r.scopeKey.trim())) errors.push(t(locale, 'm11.pr.errKey'));
    if (m === null)
      errors.push(t(locale, r.type === 'percent' ? 'm11.pr.errPercent' : 'm11.pr.errFixed'));
    const below = m !== null && isBelowCost(m);
    if (below) errors.push(t(locale, 'm11.pr.belowCost'));
    if (!effectiveFromOk(r.day)) errors.push(t(locale, 'm11.pr.errDate'));
    if (
      rows.filter((x) => x.scope === r.scope && x.scopeKey.trim() === r.scopeKey.trim()).length > 1
    )
      errors.push(t(locale, 'm11.pr.errDuplicate'));
    return {
      r,
      m,
      below,
      errors,
      retail: m && sampleOk ? retailPreview(sample.trim(), m) : null,
      margin: m && sampleOk ? marginPreview(sample.trim(), m) : null,
    };
  });
  const blocked = view.some((v) => v.errors.length > 0) || rows.length === 0;

  function save() {
    setShown(true);
    if (blocked) return;
    const rules = view.map((v) => ({
      scope: v.r.scope,
      scopeKey: v.r.scopeKey.trim(),
      markup: v.m!,
      effectiveFrom: effectiveFromIso(v.r.day),
    }));
    void call.run(
      () =>
        browserApi().PUT('/v1/resellers/{id}/price-rules', {
          params: { path: { id: resellerId }, header: { 'If-Match': ifMatch(ruleSet.version) } },
          body: { rules },
        }),
      () => {
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.pr.saved') });
        router.refresh();
      },
    );
  }
  return (
    <div>
      <Field
        id="pr-sample"
        label={t(locale, 'm11.pr.sample')}
        help={t(locale, 'm11.pr.sampleHelp', { currency })}
        error={sampleOk ? undefined : t(locale, 'm11.pr.errSample')}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            inputMode="numeric"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
        )}
      </Field>
      {rows.length === 0 && <p className="nz-muted">{t(locale, 'm11.pr.empty')}</p>}
      <div style={{ display: 'grid', gap: 12 }}>
        {view.map((v, i) => (
          <fieldset
            key={v.r.key}
            className="nz-card"
            aria-label={t(locale, 'm11.pr.rule', { n: i + 1 })}
          >
            <legend>{t(locale, 'm11.pr.rule', { n: i + 1 })}</legend>
            <div className="nz-row">
              <Field id={`pr-scope-${v.r.key}`} label={t(locale, 'm11.pr.scope')}>
                {(a) => (
                  <Select
                    {...a}
                    disabled={!canEdit}
                    value={v.r.scope}
                    onChange={(e) => patch(v.r.key, { scope: e.target.value as Row['scope'] })}
                  >
                    <option value="plan">{t(locale, 'm11.pr.scope.plan')}</option>
                    <option value="meter">{t(locale, 'm11.pr.scope.meter')}</option>
                  </Select>
                )}
              </Field>
              <Field id={`pr-key-${v.r.key}`} label={t(locale, 'm11.pr.scopeKey')}>
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    disabled={!canEdit}
                    value={v.r.scopeKey}
                    onChange={(e) => patch(v.r.key, { scopeKey: e.target.value })}
                  />
                )}
              </Field>
              <Field id={`pr-type-${v.r.key}`} label={t(locale, 'm11.pr.type')}>
                {(a) => (
                  <Select
                    {...a}
                    disabled={!canEdit}
                    value={v.r.type}
                    onChange={(e) =>
                      patch(v.r.key, { type: e.target.value as Row['type'], value: '' })
                    }
                  >
                    <option value="percent">{t(locale, 'm11.pr.type.percent')}</option>
                    <option value="fixed">{t(locale, 'm11.pr.type.fixed')}</option>
                  </Select>
                )}
              </Field>
              <Field
                id={`pr-val-${v.r.key}`}
                label={t(
                  locale,
                  v.r.type === 'percent' ? 'm11.pr.value.percent' : 'm11.pr.value.fixed',
                  { currency },
                )}
              >
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={v.r.value}
                    onChange={(e) => patch(v.r.key, { value: e.target.value })}
                  />
                )}
              </Field>
              <Field id={`pr-day-${v.r.key}`} label={t(locale, 'm11.pr.effective')}>
                {(a) => (
                  <Input
                    {...a}
                    dir="ltr"
                    type="date"
                    min={dateIn(1)}
                    disabled={!canEdit}
                    value={v.r.day}
                    onChange={(e) => patch(v.r.key, { day: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <p aria-live="polite" data-testid={`preview-${i}`}>
              {v.retail !== null && v.margin !== null ? (
                <>
                  {t(locale, 'm11.pr.preview', {
                    wholesale: moneyText(sample.trim(), currency, locale),
                    retail: moneyText(v.retail, currency, locale),
                    margin: moneyText(v.margin, currency, locale),
                  })}
                </>
              ) : (
                <span className="nz-muted">{t(locale, 'm11.pr.previewNone')}</span>
              )}
            </p>
            {v.below && (
              <p role="alert" className="nz-error-text">
                <Badge tone="danger">{t(locale, 'm11.pr.blocked')}</Badge>{' '}
                {t(locale, 'm11.pr.belowCost')}
              </p>
            )}
            {shown &&
              v.errors
                .filter((e) => !(v.below && e === t(locale, 'm11.pr.belowCost')))
                .map((e) => (
                  <p key={e} role="alert" className="nz-error-text">
                    {e}
                  </p>
                ))}
            {canEdit && (
              <Button
                variant="secondary"
                onClick={() => setRows((l) => l.filter((x) => x.key !== v.r.key))}
              >
                {t(locale, 'm11.pr.remove')}
              </Button>
            )}
          </fieldset>
        ))}
      </div>
      {canEdit && (
        <div className="nz-row" style={{ marginBlockStart: 12 }}>
          <Button
            variant="secondary"
            onClick={() =>
              setRows((l) => [
                ...l,
                {
                  key: `n${Date.now()}${l.length}`,
                  scope: 'meter',
                  scopeKey: '',
                  type: 'percent',
                  value: '10',
                  day: defaultEffectiveFrom(),
                },
              ])
            }
          >
            {t(locale, 'm11.pr.add')}
          </Button>
          <Button disabled={call.busy || view.some((v) => v.below)} onClick={save}>
            {t(locale, 'm11.pr.save', { version: ruleSet.version })}
          </Button>
        </div>
      )}
      {blocked && shown && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'm11.pr.fixFirst')}
        </p>
      )}
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </div>
  );
}
