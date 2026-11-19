'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Select } from '@nuzm/ui';
import { errorText } from '../lib/actions';
import { browserApi } from '../lib/client';
import { removeFromCart } from '../lib/cart-client';
import {
  contactBody,
  countdown,
  emptyContact,
  money,
  parseRecordValue,
  showValue,
  type ContactForm,
} from '../lib/domains';
import { NoticeText } from './Feedback';

type Notice = { tone: 'error' | 'ok'; text: string } | null;
const key = () => crypto.randomUUID();
const code = (r: { error?: unknown }) => (r.error as { code?: string } | undefined)?.code;

/** The contact fields of one registrant (shared by checkout, contacts and transfers). */
export function ContactFields({
  locale,
  value,
  onChange,
  disabled,
}: {
  locale: Locale;
  value: ContactForm;
  onChange: (c: ContactForm) => void;
  disabled?: boolean;
}) {
  const set = (k: keyof ContactForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const f = (
    id: string,
    k: keyof ContactForm,
    label: string,
    extra: Record<string, string> = {},
  ) => (
    <Field id={`ct-${id}`} label={t(locale, label as 'dom.f.first')}>
      {(x) => <Input {...x} value={value[k]} onChange={set(k)} disabled={disabled} {...extra} />}
    </Field>
  );
  return (
    <>
      {f('first', 'firstName', 'dom.f.first', { autoComplete: 'given-name' })}
      {f('last', 'lastName', 'dom.f.last', { autoComplete: 'family-name' })}
      {f('org', 'organization', 'dom.f.org')}
      {f('email', 'email', 'dom.f.email', { type: 'email', dir: 'ltr', autoComplete: 'email' })}
      {f('phone', 'phone', 'dom.f.phone', { dir: 'ltr', autoComplete: 'tel' })}
      {f('street', 'street', 'dom.f.street')}
      {f('city', 'city', 'dom.f.city')}
      {f('postal', 'postalCode', 'dom.f.postal', { dir: 'ltr' })}
      {f('country', 'country', 'dom.f.country', { maxLength: '2', dir: 'ltr' })}
    </>
  );
}

/** UI-M07-03: quote → (approval) → contacts and consent → confirm. The countdown stops the form when the quote expires. */
export function CheckoutForm({
  locale,
  name,
  years: y0,
  privacyAvailable,
  crossBorder,
  orgId,
  basketLineId,
}: {
  locale: Locale;
  name: string;
  /** Set when this registration finishes a basket line: the line is removed once the order is placed. */
  orgId?: string;
  basketLineId?: string;
  years: number;
  privacyAvailable: boolean;
  crossBorder: boolean;
}) {
  const router = useRouter();
  const [years, setYears] = useState(y0);
  const [quote, setQuote] = useState<{
    id: string;
    expiresAt: string;
    subtotalMinor: string;
    totalMinor: string;
    currency: string;
    taxEstimate: { taxMinor: string };
    requiresApproval: boolean;
  } | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [contact, setContact] = useState<ContactForm>(emptyContact());
  const [privacy, setPrivacy] = useState(privacyAvailable);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  const [idem, setIdem] = useState(key());
  useEffect(() => {
    if (!quote) return;
    const tick = () => setLeft(countdown(quote.expiresAt));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [quote]);
  const expired = quote !== null && left === null;

  async function getQuote() {
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/quotes', {
      params: { header: { 'Idempotency-Key': key() } },
      body: { kind: 'domain', items: [{ name, years, action: 'register' }] } as never,
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text:
          code(r) === 'unsupported_capability' || code(r) === 'eligibility_blocked'
            ? t(locale, 'dom.search.reason.other')
            : errorText(locale, r.response.status, code(r)),
      });
    setQuote(r.data as never);
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!quote) return;
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/domains', {
      params: { header: { 'Idempotency-Key': idem } },
      body: {
        quoteId: quote.id,
        contacts: { registrant: contactBody(contact) },
        privacy,
        autoRenew: false,
      } as never,
    });
    setBusy(false);
    if (!r.response.ok) {
      const c = code(r);
      return setN({
        tone: 'error',
        text:
          r.response.status === 402
            ? t(locale, 'dom.checkout.funds')
            : c === 'approval_required'
              ? t(locale, 'dom.checkout.approval')
              : c === 'quote_expired'
                ? t(locale, 'dom.checkout.expired')
                : c === 'domain_unavailable'
                  ? t(locale, 'dom.search.taken')
                  : c === 'consent_required'
                    ? t(locale, 'dom.contacts.public')
                    : errorText(locale, r.response.status, c),
      });
    }
    setIdem(key());
    const d = (r.data as { domain?: { id: string; status: string } }).domain;
    setN({
      tone: 'ok',
      text: t(locale, 'dom.checkout.placed', {
        state: tDynamic(locale, `dom.state.${d?.status ?? 'pending'}`, d?.status ?? 'pending'),
      }),
    });
    if (orgId && basketLineId) removeFromCart(orgId, basketLineId);
    router.push(d ? `/${locale}/domains/${d.id}` : `/${locale}/domains`);
  }
  return (
    <div className="nz-stack" style={{ maxInlineSize: 640 }}>
      <form
        className="nz-card"
        onSubmit={(e) => (e.preventDefault(), void getQuote())}
        aria-label={t(locale, 'dom.checkout.title')}
      >
        <p>
          <strong>{t(locale, 'dom.checkout.name')}:</strong> <bdi dir="ltr">{name}</bdi>
        </p>
        <Field id="co-years" label={t(locale, 'dom.checkout.years')}>
          {(x) => (
            <Select
              {...x}
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
              disabled={quote !== null}
            >
              {[1, 2, 3, 5, 10].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!quote && (
          <Button type="submit" disabled={busy}>
            {t(locale, 'dom.checkout.quote')}
          </Button>
        )}
      </form>
      {quote && (
        <form
          className="nz-card"
          onSubmit={confirm}
          noValidate
          aria-label={t(locale, 'dom.checkout.confirm')}
        >
          <dl>
            <dt>{t(locale, 'dom.checkout.subtotal')}</dt>
            <dd>
              <bdi dir="ltr">{money(quote.subtotalMinor, quote.currency)}</bdi>
            </dd>
            <dt>{t(locale, 'dom.checkout.tax')}</dt>
            <dd>
              <bdi dir="ltr">{money(quote.taxEstimate.taxMinor, quote.currency)}</bdi>
            </dd>
            <dt>{t(locale, 'dom.checkout.total')}</dt>
            <dd>
              <strong>
                <bdi dir="ltr">{money(quote.totalMinor, quote.currency)}</bdi>
              </strong>
            </dd>
          </dl>
          <p role="timer" aria-live="off">
            {expired
              ? t(locale, 'dom.checkout.expired')
              : t(locale, 'dom.checkout.expires', { time: left ?? '' })}
          </p>
          {quote.requiresApproval && (
            <Banner tone="warn">{t(locale, 'dom.checkout.approval')}</Banner>
          )}
          {crossBorder && <Banner tone="warn">{t(locale, 'dom.checkout.crossBorder')}</Banner>}
          <h3>{t(locale, 'dom.checkout.contacts')}</h3>
          <ContactFields locale={locale} value={contact} onChange={setContact} disabled={expired} />
          {privacyAvailable ? (
            <label className="nz-row">
              <input
                type="checkbox"
                checked={privacy}
                onChange={(e) => setPrivacy(e.target.checked)}
              />{' '}
              {t(locale, 'dom.checkout.privacy')}
            </label>
          ) : (
            <>
              <p className="nz-muted">{t(locale, 'dom.checkout.privacyNA')}</p>
              <label className="nz-row">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />{' '}
                {t(locale, 'dom.checkout.consent')}
              </label>
            </>
          )}
          <Button
            type="submit"
            disabled={busy || expired || quote.requiresApproval || (!privacyAvailable && !consent)}
          >
            {t(locale, 'dom.checkout.confirm')}
          </Button>
        </form>
      )}
      <NoticeText notice={n} />
    </div>
  );
}

/** UI-M07-04: nameservers, transfer lock and auto-renew with the domain's ETag; capability-gated fields are disabled with the reason. */
export function DomainSettings({
  locale,
  id,
  version,
  nameservers,
  locked,
  autoRenew,
  caps,
}: {
  locale: Locale;
  id: string;
  version: number;
  nameservers: string[];
  locked: boolean;
  autoRenew: boolean;
  caps: Record<string, boolean>;
}) {
  const router = useRouter();
  const [ns, setNs] = useState(nameservers.join('\n'));
  const [lock, setLock] = useState(locked);
  const [auto, setAuto] = useState(autoRenew);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setN(null);
    const body: Record<string, unknown> = { autoRenew: auto };
    if (caps.lock) body.lock = lock;
    const list = ns.split(/\s+/).filter(Boolean);
    if (caps.nameservers && list.join() !== nameservers.join()) body.nameservers = list;
    const r = await browserApi().PATCH('/v1/domains/{id}', {
      params: { path: { id }, header: { 'If-Match': `"${version}"` } },
      body: body as never,
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text:
          r.response.status === 412
            ? t(locale, 'dom.detail.conflict')
            : code(r) === 'unsupported_capability'
              ? t(locale, 'dom.detail.unsupported')
              : errorText(locale, r.response.status, code(r)),
      });
    setN({
      tone: 'ok',
      text:
        r.response.status === 202
          ? t(locale, 'dom.detail.reconciling')
          : t(locale, 'dom.detail.saved'),
    });
    router.refresh();
  }
  return (
    <form
      onSubmit={save}
      className="nz-card"
      noValidate
      aria-label={t(locale, 'dom.detail.settings')}
    >
      <div className="nzc-form-grid">
        <Field
          id="dm-ns"
          label={t(locale, 'dom.detail.nameservers')}
          help={caps.nameservers ? undefined : t(locale, 'dom.detail.unsupported')}
        >
          {(x) => (
            <textarea
              {...x}
              className="nz-input"
              rows={4}
              dir="ltr"
              value={ns}
              disabled={!caps.nameservers}
              onChange={(e) => setNs(e.target.value)}
            />
          )}
        </Field>
        <div style={{ display: 'grid', gap: 14, alignContent: 'start', paddingBlockStart: 30 }}>
          <label className="nzc-switch-row">
            <span>
              {t(locale, 'dom.detail.lock')}
              {!caps.lock && (
                <span className="nz-muted"> — {t(locale, 'dom.detail.unsupported')}</span>
              )}
            </span>
            <input
              type="checkbox"
              role="switch"
              className="nzc-switch-input"
              checked={lock}
              disabled={!caps.lock}
              onChange={(e) => setLock(e.target.checked)}
            />
          </label>
          <label className="nzc-switch-row">
            <span>{t(locale, 'dom.col.autoRenew')}</span>
            <input
              type="checkbox"
              role="switch"
              className="nzc-switch-input"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
          </label>
        </div>
      </div>
      <div className="nzc-form-foot">
        <span />
        <Button type="submit" disabled={busy}>
          {t(locale, 'dom.detail.save')}
        </Button>
      </div>
      <NoticeText notice={n} />
    </form>
  );
}

export function RenewButton({ locale, id, name }: { locale: Locale; id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function go() {
    setBusy(true);
    setN(null);
    const q = await browserApi().POST('/v1/quotes', {
      params: { header: { 'Idempotency-Key': key() } },
      body: { kind: 'domain', items: [{ name, years: 1, action: 'renew' }] } as never,
    });
    if (!q.response.ok) {
      setBusy(false);
      return setN({ tone: 'error', text: errorText(locale, q.response.status, code(q)) });
    }
    const r = await browserApi().POST('/v1/domains/{id}/renewals', {
      params: { path: { id }, header: { 'Idempotency-Key': key() } },
      body: { quoteId: (q.data as { id: string }).id, years: 1 } as never,
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text:
          r.response.status === 402
            ? t(locale, 'dom.checkout.funds')
            : code(r) === 'approval_required'
              ? t(locale, 'dom.checkout.approval')
              : errorText(locale, r.response.status, code(r)),
      });
    setN({ tone: 'ok', text: t(locale, 'dom.detail.pending') });
    router.refresh();
  }
  return (
    <>
      <Button type="button" disabled={busy} onClick={() => void go()}>
        {t(locale, 'dom.detail.renew')}
      </Button>
      <NoticeText notice={n} />
    </>
  );
}

export function CreateZoneButton({ locale, domainId }: { locale: Locale; domainId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function go() {
    setBusy(true);
    const r = await browserApi().POST('/v1/dns/zones', {
      params: { header: { 'Idempotency-Key': key() } },
      body: { domainId },
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text:
          code(r) === 'unsupported_capability'
            ? t(locale, 'dom.dns.unsupported')
            : errorText(locale, r.response.status, code(r)),
      });
    router.refresh();
  }
  return (
    <>
      <Button type="button" disabled={busy} onClick={() => void go()}>
        {t(locale, 'dom.dns.create')}
      </Button>
      <NoticeText notice={n} />
    </>
  );
}

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'] as const;
type Rec = { name: string; type: string; ttl: number; value: unknown; managedBy?: string };
type Pending = { op: 'create' | 'delete'; rec: Rec };

/** UI-M07-05: the record table plus a change-set editor: add and delete accumulate as a diff, then apply atomically with the zone's ETag. */
export function DnsEditor({
  locale,
  zoneId,
  version,
  records,
  degraded,
  readOnly,
}: {
  locale: Locale;
  zoneId: string;
  version: number;
  records: Rec[];
  degraded: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending[]>([]);
  const [form, setForm] = useState({ name: '', type: 'A', ttl: '300', value: '' });
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  const [errs, setErrs] = useState<{ index: number; code: string; message: string }[]>([]);
  const off = degraded || readOnly;
  function add(e: FormEvent) {
    e.preventDefault();
    const v = parseRecordValue(form.type, form.value);
    if (v === null || !form.name.trim())
      return setN({ tone: 'error', text: t(locale, 'err.validation') });
    setN(null);
    setPending([
      ...pending,
      {
        op: 'create',
        rec: { name: form.name.trim(), type: form.type, ttl: Number(form.ttl), value: v },
      },
    ]);
    setForm({ ...form, name: '', value: '' });
  }
  async function apply() {
    setBusy(true);
    setN(null);
    setErrs([]);
    const body = {
      create: pending.filter((p) => p.op === 'create').map((p) => p.rec),
      delete: pending
        .filter((p) => p.op === 'delete')
        .map((p) => ({ name: p.rec.name, type: p.rec.type })),
    };
    const r = await browserApi().PATCH('/v1/dns/zones/{id}/records', {
      params: { path: { id: zoneId }, header: { 'If-Match': `"${version}"` } },
      body: body as never,
    });
    setBusy(false);
    if (r.response.ok) {
      setPending([]);
      setN({ tone: 'ok', text: t(locale, 'dom.dns.applied') });
      return router.refresh();
    }
    const e = r.error as
      | {
          code?: string;
          errors?: { index: number; code: string; message: string }[];
          outcome?: string;
        }
      | undefined;
    if (r.response.status === 422 && e?.errors) setErrs(e.errors);
    setN({
      tone: 'error',
      text:
        r.response.status === 412
          ? t(locale, 'dom.dns.etag')
          : e?.outcome === 'rolled_back'
            ? t(locale, 'dom.dns.rolledBack')
            : e?.outcome === 'degraded'
              ? t(locale, 'dom.dns.degraded')
              : errorText(locale, r.response.status, e?.code),
    });
  }
  const hint = (type: string) =>
    (['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'] as const).includes(type as 'A')
      ? t(locale, `dom.dns.hint.${type as 'A'}`)
      : '';
  return (
    <div className="nz-stack">
      {degraded && <Banner tone="danger">{t(locale, 'dom.dns.degraded')}</Banner>}
      {pending.length > 0 && (
        // the queued changes are not live until applied: say so where it cannot be missed
        <section
          className="nzc-dns-unsaved"
          role="status"
          aria-label={t(locale, 'dom.dns.pending')}
        >
          <div>
            <strong>{t(locale, 'dom.dns.unsaved', { count: pending.length })}</strong>
            <ul>
              {pending.map((p, i) => (
                <li key={i} dir="ltr">
                  {p.op === 'create' ? '+' : '−'} {p.rec.name} {p.rec.type} {showValue(p.rec.value)}
                </li>
              ))}
            </ul>
          </div>
          <div className="nzc-row-actions">
            <Button type="button" variant="secondary" onClick={() => (setPending([]), setErrs([]))}>
              {t(locale, 'dom.dns.discard')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void apply()}>
              {t(locale, 'dom.dns.apply')}
            </Button>
          </div>
        </section>
      )}
      {errs.length > 0 && (
        <section role="alert" className="nz-card">
          <h3>{t(locale, 'dom.dns.errors')}</h3>
          <ul>
            {errs.map((e, i) => (
              <li key={i}>
                {e.index >= 0 ? `#${e.index + 1}: ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <NoticeText notice={n} />
      {!off && (
        <form onSubmit={add} className="nz-card" aria-labelledby="dn-add-h" noValidate>
          <h3 className="nzc-section-title" id="dn-add-h" style={{ marginBlockStart: 0 }}>
            {t(locale, 'dom.dns.addTitle')}
          </h3>
          <div className="nzc-dns-add">
            <Field id="dn-name" label={t(locale, 'dom.dns.col.name')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  placeholder="@"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field id="dn-type" label={t(locale, 'dom.dns.col.type')}>
              {(x) => (
                <Select
                  {...x}
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {TYPES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="dn-ttl" label={t(locale, 'dom.dns.col.ttl')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="numeric"
                  value={form.ttl}
                  onChange={(e) => setForm({ ...form, ttl: e.target.value })}
                />
              )}
            </Field>
            <Field id="dn-val" label={t(locale, 'dom.dns.value')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  placeholder={hint(form.type)}
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary">
              {t(locale, 'dom.dns.add')}
            </Button>
          </div>
        </form>
      )}
      <table className="nz-table nzc-dns-table">
        <caption>{t(locale, 'dom.dns.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, 'dom.dns.col.name')}</th>
            <th scope="col">{t(locale, 'dom.dns.col.type')}</th>
            <th scope="col">{t(locale, 'dom.dns.col.ttl')}</th>
            <th scope="col">{t(locale, 'dom.dns.col.value')}</th>
            <th scope="col">{t(locale, 'dom.dns.col.managed')}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => {
            const gone = pending.some(
              (p) => p.op === 'delete' && p.rec.name === r.name && p.rec.type === r.type,
            );
            return (
              <tr key={i} data-gone={gone || undefined}>
                <td dir="ltr">{r.name}</td>
                <td dir="ltr">
                  <Badge>{r.type}</Badge>
                </td>
                <td dir="ltr">{r.ttl}</td>
                <td dir="ltr" style={{ overflowWrap: 'anywhere' }}>
                  {showValue(r.value)}
                </td>
                <td>
                  {tDynamic(
                    locale,
                    `dom.dns.managed.${r.managedBy ?? 'user'}`,
                    r.managedBy ?? 'user',
                  )}
                </td>
                <td>
                  {!off && (r.managedBy ?? 'user') === 'user' && !gone && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPending([...pending, { op: 'delete', rec: r }])}
                    >
                      {t(locale, 'dom.dns.remove')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** UI-M07-06: contacts form (registrant; the others follow it). Masked and read-only without domain:write. */
export function ContactsForm({
  locale,
  id,
  version,
  initial,
  canEdit,
  privacyOn,
}: {
  locale: Locale;
  id: string;
  version: number;
  initial: Partial<ContactForm>;
  canEdit: boolean;
  privacyOn: boolean;
}) {
  const router = useRouter();
  const [c, setC] = useState<ContactForm>({ ...emptyContact(), ...initial });
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setN(null);
    const r = await browserApi().PATCH('/v1/domains/{id}', {
      params: { path: { id }, header: { 'If-Match': `"${version}"` } },
      body: { contacts: { registrant: contactBody(c) } } as never,
    });
    setBusy(false);
    if (!r.response.ok) {
      const k = code(r);
      return setN({
        tone: 'error',
        text:
          r.response.status === 412
            ? t(locale, 'dom.detail.conflict')
            : r.response.status === 403 && k === 'residency_denied'
              ? t(locale, 'dom.contacts.blocked')
              : k === 'unsupported_capability'
                ? t(locale, 'dom.contacts.unsupported')
                : k === 'consent_required'
                  ? t(locale, 'dom.contacts.public')
                  : errorText(locale, r.response.status, k),
      });
    }
    setN({ tone: 'ok', text: t(locale, 'dom.detail.saved') });
    router.refresh();
  }
  return (
    <form
      onSubmit={save}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'dom.contacts.title')}
      style={{ maxInlineSize: 560 }}
    >
      {!canEdit && <p className="nz-muted">{t(locale, 'dom.contacts.masked')}</p>}
      {canEdit && !privacyOn && (
        <p className="nz-muted">
          {t(locale, 'dom.contacts.public')}{' '}
          <a href={`/${locale}/privacy#consents`}>{t(locale, 'dom.contacts.consentLink')}</a>
        </p>
      )}
      <ContactFields locale={locale} value={c} onChange={setC} disabled={!canEdit} />
      {canEdit && (
        <Button type="submit" disabled={busy}>
          {t(locale, 'dom.contacts.save')}
        </Button>
      )}
      <NoticeText notice={n} />
    </form>
  );
}

/** UI-M07-07: transfer in. The authorization code is write-only: it is cleared from the form as soon as it is sent. */
export function TransferForm({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [auth, setAuth] = useState('');
  const [contact, setContact] = useState<ContactForm>(emptyContact());
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setN(null);
    const q = await browserApi().POST('/v1/quotes', {
      params: { header: { 'Idempotency-Key': key() } },
      body: {
        kind: 'domain',
        items: [{ name: name.trim().toLowerCase(), years: 1, action: 'transfer_in' }],
      } as never,
    });
    if (!q.response.ok) {
      setBusy(false);
      return setN({
        tone: 'error',
        text:
          code(q) === 'unsupported_capability' || code(q) === 'eligibility_blocked'
            ? t(locale, 'dom.tr.unsupported')
            : errorText(locale, q.response.status, code(q)),
      });
    }
    const r = await browserApi().POST('/v1/domains/transfers', {
      params: { header: { 'Idempotency-Key': key() } },
      body: {
        quoteId: (q.data as { id: string }).id,
        name: name.trim().toLowerCase(),
        authCode: auth,
        contacts: { registrant: contactBody(contact) },
      } as never,
    });
    setAuth('');
    setBusy(false);
    if (!r.response.ok)
      return setN({
        tone: 'error',
        text:
          code(r) === 'transfer_locked'
            ? t(locale, 'dom.tr.locked')
            : r.response.status === 402
              ? t(locale, 'dom.checkout.funds')
              : code(r) === 'consent_required'
                ? t(locale, 'dom.contacts.public')
                : errorText(locale, r.response.status, code(r)),
      });
    setN({
      tone: 'ok',
      text: t(locale, 'dom.checkout.placed', {
        state: tDynamic(locale, 'dom.state.transferring', 'transferring'),
      }),
    });
    router.refresh();
  }
  return (
    <form onSubmit={go} noValidate aria-label={t(locale, 'dom.tr.start')}>
      <div className="nzc-form-part">
        <h3>{t(locale, 'dom.tr.sec.domain')}</h3>
        <div className="nzc-form-grid">
          <Field id="tr-name" label={t(locale, 'dom.checkout.name')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            id="tr-auth"
            label={t(locale, 'dom.tr.authCode')}
            help={t(locale, 'dom.tr.authHelp')}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                type="password"
                autoComplete="off"
                value={auth}
                onChange={(e) => setAuth(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
      <div className="nzc-form-part">
        <h3>{t(locale, 'dom.tr.sec.contact')}</h3>
        <div className="nzc-form-grid">
          <ContactFields locale={locale} value={contact} onChange={setContact} />
        </div>
      </div>
      <div className="nzc-form-foot">
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {t(locale, 'dom.checkout.consent')}
        </label>
        <Button type="submit" disabled={busy || !consent || !name || !auth}>
          {t(locale, 'dom.tr.go')}
        </Button>
      </div>
      <NoticeText notice={n} />
    </form>
  );
}

/** UI-M07-08: link a domain to a hosting site: preview the records, then confirm. Disabled when hosting is not available. */
export function HostingLink({
  locale,
  domainId,
  hostingAvailable,
}: {
  locale: Locale;
  domainId: string;
  hostingAvailable: boolean;
}) {
  const router = useRouter();
  const [site, setSite] = useState('');
  const [preview, setPreview] = useState<{
    records: { name: string; type: string; value: unknown }[];
    replaces: { name: string; type: string; value: unknown }[];
    ssl: { state: string };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  async function call(apply: boolean) {
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/domains/{id}/hosting-links', {
      params: { path: { id: domainId }, header: { 'Idempotency-Key': key() } },
      body: { siteId: site.trim(), apply } as never,
    });
    setBusy(false);
    if (!r.response.ok)
      return setN({ tone: 'error', text: errorText(locale, r.response.status, code(r)) });
    const d = r.data as { outcome: string; proposal: NonNullable<typeof preview> };
    setPreview(d.proposal);
    if (apply) {
      setN({
        tone: 'ok',
        text: t(locale, d.outcome === 'unchanged' ? 'dom.host.unchanged' : 'dom.host.applied'),
      });
      router.refresh();
    }
  }
  if (!hostingAvailable) return <Banner tone="warn">{t(locale, 'dom.host.unavailable')}</Banner>;
  return (
    <div className="nz-stack" style={{ maxInlineSize: 640 }}>
      <form
        className="nz-card"
        onSubmit={(e) => (e.preventDefault(), void call(false))}
        noValidate
        aria-label={t(locale, 'dom.host.title')}
      >
        <Field id="hl-site" label={t(locale, 'dom.host.site')}>
          {(x) => <Input {...x} dir="ltr" value={site} onChange={(e) => setSite(e.target.value)} />}
        </Field>
        <Button type="submit" disabled={busy || !site}>
          {t(locale, 'dom.host.preview')}
        </Button>
      </form>
      {preview && (
        <section className="nz-card" aria-label={t(locale, 'dom.host.preview')}>
          <ul>
            {preview.records.map((r, i) => (
              <li key={i} dir="ltr">
                {r.name} {r.type} {showValue(r.value)}
              </li>
            ))}
          </ul>
          {preview.replaces.length > 0 && (
            <>
              <p>{t(locale, 'dom.host.replaces')}</p>
              <ul>
                {preview.replaces.map((r, i) => (
                  <li key={i} dir="ltr">
                    {r.name} {r.type} {showValue(r.value)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>
            {t(locale, 'dom.host.ssl')}: <strong>{preview.ssl.state}</strong>
          </p>
          <Button type="button" disabled={busy} onClick={() => void call(true)}>
            {t(locale, 'dom.host.apply')}
          </Button>
        </section>
      )}
      <NoticeText notice={n} />
    </div>
  );
}
