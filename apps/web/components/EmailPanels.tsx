'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { Art, Badge, Banner, Button, Field, Icon, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  MAILBOX_QUOTA_MAX,
  MAILBOX_QUOTA_MIN,
  canApplyAutomatically,
  detectPlaceholders,
  domainTone,
  ifMatch,
  isProtectiveReason,
  newKey,
  previewDoc,
  recordLine,
  recordSummary,
  recordTone,
  validDomain,
  validEmailAddress,
  validLocalPart,
  validQuotaMb,
  variableErrors,
  variablesFor,
  type DnsRecord,
  type VarConfig,
} from '../lib/data';
import { ConfirmDialog, CopyButton, Note, useCall } from './DataUi';
import { QuoteSummary } from './DataParts';

type Domain = Schemas['EmailDomain'];
type Mailbox = Schemas['Mailbox'];
type Template = Schemas['EmailTemplate'];

const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={4} {...p} />
);

/* ------------------------------------------------------------------ UI-M08-08 */

export function AddDomainForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [domain, setDomain] = useState('');
  const [purposes, setPurposes] = useState<('mailbox' | 'transactional')[]>(['transactional']);
  const [error, setError] = useState<string | undefined>();
  const [idem, setIdem] = useState(newKey());
  const toggle = (p: 'mailbox' | 'transactional') =>
    setPurposes((l) => (l.includes(p) ? l.filter((x) => x !== p) : [...l, p]));

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const d = domain.trim().toLowerCase();
    if (!validDomain(d)) return setError(t(locale, 'm8.emd.err.domain'));
    if (purposes.length === 0) return setError(t(locale, 'm8.emd.err.purposes'));
    setError(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/email/domains', {
          params: { header: { 'Idempotency-Key': idem } },
          body: { domain: d, purposes },
        }),
      (r) => {
        setIdem(newKey());
        router.push(`/${locale}/email/domains/${r.id}`);
        router.refresh();
      },
      () => setIdem(newKey()),
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="ld-hero ld-emailhero"
      data-size="md"
      aria-labelledby="emd-add-h"
    >
      <div className="ld-glow" aria-hidden="true" />
      <Art name="email" className="ld-art" />
      <div className="ld-inner">
        <span className="ld-brand">
          <Icon name="mail" size={16} /> {t(locale, 'ld.mail.eyebrow')}
        </span>
        <h2 id="emd-add-h" className="ld-title">
          {t(locale, 'ld.emd.title')}
        </h2>
        <p className="ld-sub">{t(locale, 'm8.emd.help')}</p>
        <div className="ld-card ld-search">
          <Icon name="globe" size={22} />
          <label className="nz-sr" htmlFor="emd-domain">
            {t(locale, 'm8.emd.domain')}
          </label>
          <input
            id="emd-domain"
            className="ld-search-input"
            dir="ltr"
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            value={domain}
            aria-invalid={error ? true : undefined}
            aria-describedby="emd-domain-help"
            onChange={(e) => setDomain(e.target.value)}
          />
          <button className="ld-go" type="submit" disabled={call.busy}>
            <span>{t(locale, 'm8.emd.addAction')}</span>
            <Icon name="arrow" size={18} />
          </button>
        </div>
        <p
          className={error ? 'nz-error-text' : 'ld-note'}
          id="emd-domain-help"
          role={error ? 'alert' : undefined}
        >
          {error ?? t(locale, 'm8.emd.domainHelp')}
        </p>
        <div className="ld-tlds" role="group" aria-labelledby="emd-purposes">
          <p className="ld-label" id="emd-purposes">
            {t(locale, 'm8.emd.purposes')}
          </p>
          <div className="ld-tlds-grid ld-purposes">
            {(['transactional', 'mailbox'] as const).map((p) => (
              <label key={p} className="ld-tld">
                <input type="checkbox" checked={purposes.includes(p)} onChange={() => toggle(p)} />
                <span className="ld-tld-name">{t(locale, `m8.emd.purpose.${p}`)}</span>
                <span className="ld-tld-hint">{t(locale, `m8.emd.purpose.${p}.desc`)}</span>
              </label>
            ))}
          </div>
        </div>
        <Note n={call.notice} />
        {call.panel}
      </div>
    </form>
  );
}

/** One domain: required records with per-record status, DMARC guidance, "Re-check now" and (only for a Nuzm DNS zone) "Apply automatically". */
export function DomainPanel({
  locale,
  domain,
  canManage,
  mfaFactorId,
}: {
  locale: Locale;
  domain: Domain;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [applyUnsupported, setApplyUnsupported] = useState(false);
  const records = domain.requiredRecords as DnsRecord[];
  const sum = recordSummary(records);

  const verify = (apply: boolean) =>
    void call.run(
      () =>
        browserApi().POST('/v1/email/domains/{id}/verification', {
          params: { path: { id: domain.id } },
          body: apply ? { apply: true } : {},
        }),
      () => {
        call.setNotice({
          tone: 'ok',
          text: t(locale, apply ? 'm8.emd.applied' : 'm8.emd.rechecked'),
        });
        router.refresh();
      },
      (p) => {
        if (apply && p.code === 'unsupported_capability') {
          setApplyUnsupported(true);
          return true;
        }
      },
    );

  const auto = canApplyAutomatically(domain) && !applyUnsupported;
  return (
    <>
      <p className="nz-row">
        <Badge tone={domainTone(domain.state)}>
          {tDynamic(locale, `m8.emd.state.${domain.state}`, domain.state)}
        </Badge>
        <span>{t(locale, 'm8.emd.summary', { ok: sum.ok, total: sum.total })}</span>
        <span className="nz-muted">
          {domain.lastCheckedAt
            ? t(locale, 'm8.emd.lastChecked', {
                time: formatDateTime(domain.lastCheckedAt, locale),
              })
            : t(locale, 'm8.emd.neverChecked')}
        </span>
      </p>
      {domain.state === 'partial' && <Banner tone="warn">{t(locale, 'm8.emd.partial')}</Banner>}
      {domain.state === 'failed' && <Banner tone="danger">{t(locale, 'm8.emd.failed')}</Banner>}
      {sum.conflict > 0 && (
        <Banner tone="danger">{t(locale, 'm8.emd.conflicts', { n: sum.conflict })}</Banner>
      )}
      {canManage && (
        <div className="nz-row">
          <Button disabled={call.busy} onClick={() => verify(false)}>
            {t(locale, 'm8.emd.recheck')}
          </Button>
          {auto && (
            <Button variant="secondary" disabled={call.busy} onClick={() => verify(true)}>
              {t(locale, 'm8.emd.apply')}
            </Button>
          )}
        </div>
      )}
      <Note n={call.notice} />
      {call.panel}
      {!auto && (
        <p className="nz-muted">
          {applyUnsupported ? t(locale, 'm8.emd.applyUnsupported') : t(locale, 'm8.emd.manual')}
        </p>
      )}
      <Table
        caption={t(locale, 'm8.emd.records')}
        rows={records}
        rowKey={(r) => `${r.type}|${r.name}|${r.value}`}
        columns={[
          {
            key: 'p',
            header: t(locale, 'm8.emd.col.purpose'),
            render: (r) => tDynamic(locale, `m8.emd.rp.${r.purpose}`, r.purpose),
          },
          {
            key: 't',
            icon: 'code',
            header: t(locale, 'field.type'),
            render: (r) => <Ltr>{r.type}</Ltr>,
          },
          { key: 'n', header: t(locale, 'field.name'), render: (r) => <Ltr>{r.name}</Ltr> },
          {
            key: 'v',
            header: t(locale, 'm8.emd.col.value'),
            render: (r) => (
              <span style={{ overflowWrap: 'anywhere' }}>
                {r.priority !== undefined && <Ltr>{`${r.priority} `}</Ltr>}
                <Ltr>{r.value}</Ltr>
              </span>
            ),
          },
          {
            key: 's',
            header: t(locale, 'field.status'),
            icon: 'pulse',
            render: (r) => (
              <>
                <Badge tone={recordTone(r.status)}>
                  {tDynamic(locale, `m8.emd.rs.${r.status}`, r.status)}
                </Badge>
                {r.detail && (
                  <p className="nz-muted">
                    <bdi dir="auto">{r.detail}</bdi>
                  </p>
                )}
              </>
            ),
          },
          {
            key: 'c',
            header: t(locale, 'field.action'),
            icon: 'code',
            render: (r) => (
              <CopyButton
                locale={locale}
                text={recordLine(r)}
                label={t(locale, 'm8.emd.copyRecord', { name: r.name })}
              />
            ),
          },
        ]}
      />
      <section
        className="nz-card"
        aria-label={t(locale, 'm8.emd.dmarc')}
        style={{ marginBlockStart: 16 }}
      >
        <h2 className="nz-h2">{t(locale, 'm8.emd.dmarc')}</h2>
        <p>
          {t(locale, 'm8.emd.dmarcState')}:{' '}
          <Badge
            tone={
              domain.dmarc?.state === 'reject' || domain.dmarc?.state === 'quarantine'
                ? 'success'
                : 'warn'
            }
          >
            {tDynamic(
              locale,
              `m8.emd.dmarc.${domain.dmarc?.state ?? 'missing'}`,
              domain.dmarc?.state ?? 'missing',
            )}
          </Badge>
        </p>
        <p className="nz-muted">{t(locale, 'm8.emd.dmarcHelp')}</p>
        {domain.dmarc?.suggestion && (
          <p>
            <Ltr>{domain.dmarc.suggestion}</Ltr>
          </p>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-10 */

/** Create a mailbox: estimate (quote kind email) → confirm. A 422 `unsupported_capability` puts the screen in the "provider disabled" state. */
export function NewMailboxForm({
  locale,
  domains,
  mfaFactorId,
}: {
  locale: Locale;
  domains: Domain[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [localPart, setLocalPart] = useState('');
  const [quota, setQuota] = useState('1024');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Schemas['Quote'] | null>(null);
  const [quoted, setQuoted] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [created, setCreated] = useState<Mailbox | null>(null);
  const [quoteKey, setQuoteKey] = useState(newKey());
  const [createKey, setCreateKey] = useState(newKey());
  const current = `${domainId}|${localPart}|${quota}`;
  const stale = quote !== null && quoted !== current;

  function validate() {
    const e: Record<string, string> = {};
    if (!domainId) e.domain = t(locale, 'm8.mb.err.domain');
    if (!validLocalPart(localPart)) e.local = t(locale, 'm8.mb.err.local');
    if (!validQuotaMb(quota))
      e.quota = t(locale, 'm8.mb.err.quota', { min: MAILBOX_QUOTA_MIN, max: MAILBOX_QUOTA_MAX });
    setErrors(e);
    return Object.keys(e).length === 0;
  }
  const refused = (p: { code?: string }) => {
    if (p.code === 'unsupported_capability' || p.code === 'kind_not_available') {
      setDisabled(true);
      return true;
    }
  };
  function estimate(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setQuote(null);
    void call.run(
      () =>
        browserApi().POST('/v1/quotes', {
          params: { header: { 'Idempotency-Key': quoteKey } },
          body: { kind: 'email', items: [{ type: 'mailbox', quotaMb: Number(quota) }] },
        }),
      (q) => {
        setQuote(q);
        setQuoted(current);
        setQuoteKey(newKey());
      },
      (p) => {
        setQuoteKey(newKey());
        return refused(p);
      },
    );
  }
  function confirm() {
    if (!quote || stale) return;
    void call.run(
      () =>
        browserApi().POST('/v1/email/mailboxes', {
          params: { header: { 'Idempotency-Key': createKey } },
          body: {
            domainId,
            localPart: localPart.toLowerCase(),
            quotaMb: Number(quota),
            quoteId: quote.id,
          },
        }),
      (m) => {
        setCreateKey(newKey());
        setCreated(m);
        setQuote(null);
        router.refresh();
      },
      refused,
    );
  }
  if (domains.length === 0)
    return (
      <section className="ld-hero ld-emailhero" data-size="md">
        <div className="ld-glow" aria-hidden="true" />
        <div className="ld-inner">
          <span className="ld-brand">
            <Icon name="mail" size={16} /> {t(locale, 'ld.mail.eyebrow')}
          </span>
          <h2 className="ld-title">{t(locale, 'ld.mail.needDomain')}</h2>
          <p className="ld-sub">{t(locale, 'm8.mb.noDomains')}</p>
          <a className="ld-go" href={`/${locale}/email/domains`}>
            <span>{t(locale, 'm8.em.tab.domains')}</span>
            <Icon name="arrow" size={18} />
          </a>
        </div>
      </section>
    );
  return (
    <>
      {disabled && <Banner tone="warn">{t(locale, 'm8.mb.providerDisabled')}</Banner>}
      <form
        onSubmit={estimate}
        noValidate
        className="ld-hero ld-mailhero"
        aria-label={t(locale, 'm8.mb.new')}
      >
        <div className="ld-glow" aria-hidden="true" />
        <div className="ld-inner">
          <span className="ld-brand">
            <Icon name="mail" size={16} /> {t(locale, 'ld.mail.eyebrow')}
          </span>
          <h2 className="ld-title">{t(locale, 'ld.mail.title')}</h2>
          <p className="ld-sub">{t(locale, 'ld.mail.sub')}</p>
          <div className="ld-card ld-mail">
            <div className="ld-addr">
              <div className="ld-fieldwrap">
                <label htmlFor="mb-local">{t(locale, 'm8.mb.local')}</label>
                <input
                  id="mb-local"
                  className="ld-local"
                  dir="ltr"
                  value={localPart}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errors.local ? true : undefined}
                  aria-describedby={errors.local ? 'mb-local-err' : undefined}
                  onChange={(e) => setLocalPart(e.target.value)}
                />
              </div>
              <span className="ld-at" aria-hidden="true">
                @
              </span>
              <div className="ld-fieldwrap">
                <label htmlFor="mb-domain">{t(locale, 'm8.emd.domain')}</label>
                <select
                  id="mb-domain"
                  className="ld-domain"
                  dir="ltr"
                  value={domainId}
                  onChange={(e) => setDomainId(e.target.value)}
                >
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.domain}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {errors.local && (
              <p className="nz-error-text" id="mb-local-err" role="alert">
                {errors.local}
              </p>
            )}
            {errors.domain && (
              <p className="nz-error-text" role="alert">
                {errors.domain}
              </p>
            )}
            {localPart.trim() !== '' && (
              <p className="ld-preview" aria-live="polite">
                <Icon name="mail" size={16} />
                <span className="nz-muted">{t(locale, 'ld.mail.preview')}</span>
                <bdi dir="ltr">
                  {localPart.trim().toLowerCase()}@{domains.find((d) => d.id === domainId)?.domain}
                </bdi>
              </p>
            )}
            <div className="ld-quota">
              <p className="ld-label" id="mb-quota-l">
                {t(locale, 'ld.mail.quota')}
              </p>
              <div className="ld-presets" role="group" aria-labelledby="mb-quota-l">
                {[1024, 5120, 10240].map((mb) => (
                  <button
                    key={mb}
                    type="button"
                    className="ld-preset"
                    aria-pressed={quota === String(mb)}
                    onClick={() => setQuota(String(mb))}
                  >
                    {t(locale, 'ld.mail.gb', { n: mb / 1024 })}
                  </button>
                ))}
                <label className="ld-custom" htmlFor="mb-quota">
                  <span>{t(locale, 'ld.mail.custom')}</span>
                  <input
                    id="mb-quota"
                    dir="ltr"
                    inputMode="numeric"
                    value={quota}
                    aria-invalid={errors.quota ? true : undefined}
                    aria-describedby="mb-quota-help"
                    onChange={(e) => setQuota(e.target.value)}
                  />
                </label>
              </div>
              <span className="nz-help" id="mb-quota-help">
                {errors.quota ??
                  t(locale, 'm8.mb.quotaHelp', {
                    min: MAILBOX_QUOTA_MIN,
                    max: MAILBOX_QUOTA_MAX,
                  })}
              </span>
            </div>
            <p className="ld-note">{t(locale, 'm8.mb.passwordHelp')}</p>
            <button className="ld-go" type="submit" disabled={call.busy || disabled}>
              <span>{t(locale, 'm8.q.request')}</span>
              <Icon name="arrow" size={18} />
            </button>
            {!quote && <Note n={call.notice} />}
          </div>
        </div>
      </form>
      {call.panel}
      {quote && (
        <>
          <QuoteSummary locale={locale} quote={quote} />
          {stale && <Banner tone="warn">{t(locale, 'm8.q.changed')}</Banner>}
          <p>
            <Button disabled={call.busy || stale || disabled} onClick={confirm}>
              {t(locale, 'm8.q.confirm')}
            </Button>
          </p>
          <Note n={call.notice} />
        </>
      )}
      {created && (
        <Banner tone="warn">
          {t(locale, 'm8.mb.created', { address: created.address })}{' '}
          {created.passwordSetup
            ? t(locale, `m8.mb.setup.${created.passwordSetup.kind}`)
            : t(locale, 'm8.mb.setup.none')}{' '}
          {t(locale, 'm8.mb.revealPending')}
        </Banner>
      )}
    </>
  );
}

/** Quota change (If-Match) and deletion of one mailbox. */
export function MailboxActions({
  locale,
  mailbox,
  canManage,
  mfaFactorId,
}: {
  locale: Locale;
  mailbox: Mailbox;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [quota, setQuota] = useState(String(mailbox.quotaMb));
  const [open, setOpen] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  if (!canManage) return <>—</>;
  const gone = mailbox.status === 'deleting' || mailbox.status === 'deleted';
  function save() {
    if (!validQuotaMb(quota))
      return call.setNotice({
        tone: 'error',
        text: t(locale, 'm8.mb.err.quota', { min: MAILBOX_QUOTA_MIN, max: MAILBOX_QUOTA_MAX }),
      });
    void call.run(
      () =>
        browserApi().PATCH('/v1/email/mailboxes/{id}', {
          params: { path: { id: mailbox.id }, header: { 'If-Match': ifMatch(mailbox.etag) } },
          body: { quotaMb: Number(quota) },
        }),
      () => {
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.mb.quotaSaved') });
        router.refresh();
      },
      (p) => {
        if (p.code === 'unsupported_capability') {
          setUnsupported(true);
          return true;
        }
      },
    );
  }
  function remove() {
    void call.run(
      () =>
        browserApi().DELETE('/v1/email/mailboxes/{id}', { params: { path: { id: mailbox.id } } }),
      () => {
        setOpen(false);
        router.refresh();
      },
      () => setOpen(false),
    );
  }
  return (
    <div style={{ minInlineSize: 200 }}>
      {unsupported ? (
        <p className="nz-muted">{t(locale, 'm8.mb.quotaUnsupported')}</p>
      ) : (
        <div className="nz-row">
          <Input
            aria-label={t(locale, 'm8.mb.quotaFor', { address: mailbox.address })}
            dir="ltr"
            inputMode="numeric"
            style={{ inlineSize: 110 }}
            value={quota}
            disabled={gone}
            onChange={(e) => setQuota(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={call.busy || gone || quota === String(mailbox.quotaMb)}
            onClick={save}
          >
            {t(locale, 'action.save')}
          </Button>
        </div>
      )}
      <Button
        variant="danger"
        disabled={call.busy || gone}
        onClick={() => setOpen(true)}
        aria-label={t(locale, 'm8.mb.deleteFor', { address: mailbox.address })}
      >
        {t(locale, 'action.delete')}
      </Button>
      <Note n={call.notice} />
      <ConfirmDialog
        open={open}
        title={t(locale, 'm8.mb.deleteTitle')}
        onClose={() => setOpen(false)}
      >
        <p>{t(locale, 'm8.mb.deleteConfirm', { address: mailbox.address })}</p>
        <div className="nz-row">
          <Button variant="danger" disabled={call.busy} onClick={remove}>
            {t(locale, 'action.delete')}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
        {call.panel}
      </ConfirmDialog>
    </div>
  );
}

export function NewAliasForm({
  locale,
  mailboxes,
  mfaFactorId,
}: {
  locale: Locale;
  mailboxes: Mailbox[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const usable = mailboxes.filter((m) => m.status === 'active');
  const [mailboxId, setMailboxId] = useState(usable[0]?.id ?? '');
  const [local, setLocal] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [idem, setIdem] = useState(newKey());
  if (usable.length === 0) return null;
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validLocalPart(local)) return setError(t(locale, 'm8.mb.err.local'));
    setError(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/email/aliases', {
          params: { header: { 'Idempotency-Key': idem } },
          body: { mailboxId, localPart: local.toLowerCase() },
        }),
      () => {
        setIdem(newKey());
        setLocal('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.al.created') });
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
      aria-label={t(locale, 'm8.al.new')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm8.al.new')}</h2>
      <Field id="al-mailbox" label={t(locale, 'm8.al.mailbox')}>
        {(x) => (
          <Select {...x} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="al-local" label={t(locale, 'm8.mb.local')} error={error}>
        {(x) => <Input {...x} dir="ltr" value={local} onChange={(e) => setLocal(e.target.value)} />}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm8.al.add')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M08-11 */

export function NewSenderForm({
  locale,
  domains,
  mfaFactorId,
}: {
  locale: Locale;
  domains: Domain[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [idem, setIdem] = useState(newKey());
  if (domains.length === 0)
    return (
      <Banner tone="warn">
        {t(locale, 'm8.sn.noDomains')}{' '}
        <a href={`/${locale}/email/domains`}>{t(locale, 'm8.em.tab.domains')}</a>
      </Banner>
    );
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const dom = domains.find((d) => d.id === domainId);
    const addr = from.trim().toLowerCase();
    if (!dom || !validEmailAddress(addr) || !addr.endsWith(`@${dom.domain}`))
      return setError(t(locale, 'm8.sn.err.address', { domain: dom?.domain ?? '' }));
    setError(undefined);
    void call.run(
      () =>
        browserApi().POST('/v1/email/sender-identities', {
          params: { header: { 'Idempotency-Key': idem } },
          body: { domainId, fromAddress: addr },
        }),
      () => {
        setIdem(newKey());
        setFrom('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.sn.created') });
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
      aria-label={t(locale, 'm8.sn.new')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm8.sn.new')}</h2>
      <Field id="sn-domain" label={t(locale, 'm8.emd.domain')}>
        {(x) => (
          <Select {...x} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="sn-from"
        label={t(locale, 'm8.sn.from')}
        help={t(locale, 'm8.sn.fromHelp')}
        error={error}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm8.sn.add')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M08-12 */

/**
 * Template editor with a live preview. The preview is an iframe with `sandbox=""` (no scripts, forms, popups or same-origin access) and a CSP that
 * forbids every network load, in the template's direction. The draft is shown as typed; after saving the HTML the API returned (sanitized) is shown.
 * Saving always creates the next version of the key.
 */
export function TemplateEditor({
  locale,
  initial,
  mfaFactorId,
}: {
  locale: Locale;
  initial: Template | null;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [key, setKey] = useState(initial?.key ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [tl, setTl] = useState<'ar' | 'en'>(initial?.locale ?? locale);
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [html, setHtml] = useState(initial?.html ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [vars, setVars] = useState<VarConfig>((initial?.variables as VarConfig | undefined) ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [varErrors, setVarErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Template | null>(null);
  const [idem, setIdem] = useState(newKey());

  const detected = detectPlaceholders(subject, html, text);
  const schema = variablesFor(detected, vars);
  const shown = saved ? { html: saved.html, locale: saved.locale } : { html, locale: tl };

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) e.key = t(locale, 'm8.tp.err.key');
    if (name.trim() === '') e.name = t(locale, 'm8.tp.err.name');
    if (subject.trim() === '' || /[\r\n]/.test(subject)) e.subject = t(locale, 'm8.tp.err.subject');
    if (html.trim() === '') e.html = t(locale, 'm8.tp.err.html');
    setErrors(e);
    setVarErrors({});
    if (Object.keys(e).length) return;
    void call.run(
      () =>
        browserApi().POST('/v1/email/templates', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            key,
            name: name.trim(),
            locale: tl,
            subject,
            html,
            ...(text.trim() ? { text } : {}),
            variables: schema,
          },
        }),
      (tpl) => {
        setIdem(newKey());
        setSaved(tpl);
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.tp.saved', { version: tpl.version }) });
        router.refresh();
      },
      (p) => {
        setIdem(newKey());
        if (p.status === 422) setVarErrors(variableErrors(p));
      },
    );
  }

  return (
    <div className="nz-grid">
      <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'm8.tp.editor')}>
        <h2 className="nz-h2">
          {initial
            ? t(locale, 'm8.tp.editVersion', { key: initial.key })
            : t(locale, 'm8.tp.editor')}
        </h2>
        <Field
          id="tp-key"
          label={t(locale, 'm8.tp.key')}
          help={t(locale, 'm8.tp.keyHelp')}
          error={errors.key}
        >
          {(x) => <Input {...x} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field id="tp-name" label={t(locale, 'field.name')} error={errors.name}>
          {(x) => <Input {...x} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field id="tp-locale" label={t(locale, 'field.locale')}>
          {(x) => (
            <Select
              {...x}
              value={tl}
              onChange={(e) => {
                setTl(e.target.value as 'ar' | 'en');
                setSaved(null);
              }}
            >
              <option value="ar">{t(locale, 'm8.tp.locale.ar')}</option>
              <option value="en">{t(locale, 'm8.tp.locale.en')}</option>
            </Select>
          )}
        </Field>
        <Field id="tp-subject" label={t(locale, 'm8.tp.subject')} error={errors.subject}>
          {(x) => (
            <Input
              {...x}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setSaved(null);
              }}
            />
          )}
        </Field>
        <Field
          id="tp-html"
          label={t(locale, 'm8.tp.html')}
          help={t(locale, 'm8.tp.htmlHelp')}
          error={errors.html}
        >
          {(x) => (
            <TextArea
              {...x}
              dir="ltr"
              rows={8}
              value={html}
              onChange={(e) => {
                setHtml(e.target.value);
                setSaved(null);
              }}
            />
          )}
        </Field>
        <Field id="tp-text" label={t(locale, 'm8.tp.text')}>
          {(x) => (
            <TextArea {...x} dir="ltr" value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </Field>
        <fieldset>
          <legend>{t(locale, 'm8.tp.variables')}</legend>
          {detected.length === 0 && <p className="nz-muted">{t(locale, 'm8.tp.noVariables')}</p>}
          {detected.map((n) => (
            <div key={n} className="nz-row" style={{ marginBlockEnd: 8 }}>
              <Ltr>{n}</Ltr>
              <Select
                aria-label={t(locale, 'm8.tp.varType', { name: n })}
                value={schema[n]!.type}
                onChange={(e) =>
                  setVars({
                    ...schema,
                    [n]: { ...schema[n]!, type: e.target.value as 'string' | 'number' },
                  })
                }
              >
                <option value="string">{t(locale, 'm8.tp.type.string')}</option>
                <option value="number">{t(locale, 'm8.tp.type.number')}</option>
              </Select>
              <label className="nz-row">
                <input
                  type="checkbox"
                  checked={schema[n]!.required}
                  onChange={(e) =>
                    setVars({ ...schema, [n]: { ...schema[n]!, required: e.target.checked } })
                  }
                />
                {t(locale, 'm8.tp.required')}
              </label>
              {varErrors[n] !== undefined && (
                <span role="alert" className="nz-error-text">
                  {t(locale, 'm8.tp.varError', { name: n })} <bdi dir="auto">{varErrors[n]}</bdi>
                </span>
              )}
            </div>
          ))}
        </fieldset>
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'm8.tp.save')}
        </Button>
        <Note n={call.notice} />
        {call.panel}
      </form>
      <section className="nz-card" aria-label={t(locale, 'm8.tp.preview')}>
        <h2 className="nz-h2">{t(locale, 'm8.tp.preview')}</h2>
        <p className="nz-muted">
          {saved ? t(locale, 'm8.tp.previewSaved') : t(locale, 'm8.tp.previewDraft')}
        </p>
        <p>
          <Badge>{shown.locale === 'ar' ? t(locale, 'm8.tp.rtl') : t(locale, 'm8.tp.ltr')}</Badge>
        </p>
        <iframe
          title={t(locale, 'm8.tp.previewFrame')}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewDoc(shown.html, shown.locale)}
          style={{
            inlineSize: '100%',
            minBlockSize: 320,
            border: '1px solid var(--nuzm-color-border)',
            borderRadius: 8,
            background: '#fff',
          }}
        />
      </section>
    </div>
  );
}

/** Read-only sandboxed preview of one saved (sanitized) version. */
export function TemplatePreview({ locale, tpl }: { locale: Locale; tpl: Template }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? t(locale, 'm8.tp.hidePreview') : t(locale, 'm8.tp.showPreview')}
      </Button>
      {open && (
        <iframe
          title={t(locale, 'm8.tp.previewFrameFor', { key: tpl.key, version: tpl.version })}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewDoc(tpl.html, tpl.locale)}
          style={{
            display: 'block',
            inlineSize: '100%',
            minBlockSize: 220,
            marginBlockStart: 8,
            border: '1px solid var(--nuzm-color-border)',
            borderRadius: 8,
            background: '#fff',
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-13 */

/** A small "send test message" form (transactional only, verified sender, a generated Idempotency-Key). A throttled answer shows a persistent banner. */
export function SendTestForm({
  locale,
  senders,
  mfaFactorId,
}: {
  locale: Locale;
  senders: Schemas['SenderIdentity'][];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const verified = senders.filter((s) => s.status === 'verified');
  const [senderId, setSenderId] = useState(verified[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [throttled, setThrottled] = useState(false);
  const [idem, setIdem] = useState(newKey());

  if (verified.length === 0)
    return (
      <Banner tone="warn">
        {t(locale, 'm8.ms.noSender')}{' '}
        <a href={`/${locale}/email/senders`}>{t(locale, 'm8.em.tab.senders')}</a>
      </Banner>
    );
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const list = to.split(/[\s,;]+/).filter(Boolean);
    const e: Record<string, string> = {};
    if (list.length === 0 || list.length > 10 || list.some((a) => !validEmailAddress(a)))
      e.to = t(locale, 'm8.ms.err.to');
    if (subject.trim() === '' || /[\r\n]/.test(subject)) e.subject = t(locale, 'm8.tp.err.subject');
    if (html.trim() === '') e.html = t(locale, 'm8.tp.err.html');
    setErrors(e);
    if (Object.keys(e).length) return;
    setThrottled(false);
    void call.run(
      () =>
        browserApi().POST('/v1/email/messages', {
          params: { header: { 'Idempotency-Key': idem } },
          body: { senderId, to: list, subject, html, category: 'transactional' },
        }),
      () => {
        setIdem(newKey());
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.ms.queued') });
        router.refresh();
      },
      (p) => {
        if (p.status === 429 && p.throttled) setThrottled(true);
        // a 429 is a definite answer: a new attempt is a new intent
        if (p.status < 500) setIdem(newKey());
      },
    );
  }
  return (
    <>
      {throttled && <Banner tone="danger">{t(locale, 'm8.ms.throttled')}</Banner>}
      <form
        onSubmit={submit}
        noValidate
        className="nz-card"
        aria-label={t(locale, 'm8.ms.send')}
        style={{ maxInlineSize: 640 }}
      >
        <h2 className="nz-h2">{t(locale, 'm8.ms.send')}</h2>
        <p className="nz-muted">{t(locale, 'm8.ms.sendHelp')}</p>
        <Field id="ms-sender" label={t(locale, 'm8.ms.sender')}>
          {(x) => (
            <Select {...x} value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              {verified.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fromAddress}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="ms-to"
          label={t(locale, 'm8.ms.to')}
          help={t(locale, 'm8.ms.toHelp')}
          error={errors.to}
        >
          {(x) => <Input {...x} dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field id="ms-subject" label={t(locale, 'm8.tp.subject')} error={errors.subject}>
          {(x) => <Input {...x} value={subject} onChange={(e) => setSubject(e.target.value)} />}
        </Field>
        <Field id="ms-html" label={t(locale, 'm8.tp.html')} error={errors.html}>
          {(x) => (
            <TextArea {...x} dir="ltr" value={html} onChange={(e) => setHtml(e.target.value)} />
          )}
        </Field>
        <p className="nz-muted">{t(locale, 'm8.ms.category')}</p>
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'm8.ms.sendAction')}
        </Button>
        <Note n={call.notice} />
        {call.panel}
      </form>
    </>
  );
}

/** The event timeline of one message, loaded on demand (GET /v1/email/messages/{id}). */
export function MessageTimeline({ locale, id }: { locale: Locale; id: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');
  const [events, setEvents] = useState<Schemas['EmailEvent'][]>([]);
  useEffect(() => {
    if (!open || state !== 'idle') return;
    setState('loading');
    void browserApi()
      .GET('/v1/email/messages/{id}', { params: { path: { id } } })
      .then((r) => {
        if (!r.response.ok || !r.data) return setState('error');
        setEvents([...r.data.events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)));
        setState('ok');
      });
  }, [open, state, id]);
  return (
    <>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t(locale, 'm8.ms.hideTimeline') : t(locale, 'm8.ms.timeline')}
      </Button>
      {open && (
        <div role="status" aria-live="polite">
          {state === 'loading' && <p className="nz-muted">{t(locale, 'state.loading')}</p>}
          {state === 'error' && (
            <p role="alert" className="nz-error-text">
              {t(locale, 'state.error.title')}
            </p>
          )}
          {state === 'ok' && events.length === 0 && (
            <p className="nz-muted">{t(locale, 'm8.ms.noEvents')}</p>
          )}
          {state === 'ok' && events.length > 0 && (
            <ol>
              {events.map((e) => (
                <li key={e.id}>
                  {formatDateTime(e.occurredAt, locale)} ·{' '}
                  {tDynamic(locale, `m8.ms.event.${e.type}`, e.type)}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ UI-M08-14 */

export function AddSuppressionForm({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | undefined>();
  function submit(ev: FormEvent) {
    ev.preventDefault();
    const a = address.trim().toLowerCase();
    if (!validEmailAddress(a)) return setError(t(locale, 'm8.su.err.address'));
    setError(undefined);
    void call.run(
      () => browserApi().POST('/v1/email/suppressions', { body: { address: a, action: 'add' } }),
      () => {
        setAddress('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm8.su.added') });
        router.refresh();
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm8.su.add')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm8.su.add')}</h2>
      <Field
        id="su-address"
        label={t(locale, 'm8.su.address')}
        help={t(locale, 'm8.su.addHelp')}
        error={error}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'm8.su.addAction')}
      </Button>
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}

/** Remove a suppression. A hard bounce or a complaint protects the sender's reputation: it needs an explicit override confirmation. */
export function RemoveSuppression({
  locale,
  suppression,
  mfaFactorId,
}: {
  locale: Locale;
  suppression: Schemas['Suppression'];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useCall(locale, mfaFactorId);
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const protective = isProtectiveReason(suppression.reason);
  const close = () => {
    setOpen(false);
    setAck(false);
  };
  function remove() {
    void call.run(
      () =>
        browserApi().POST('/v1/email/suppressions', {
          body: {
            address: suppression.address,
            action: 'remove',
            ...(protective ? { override: true } : {}),
          },
        }),
      () => {
        close();
        router.refresh();
      },
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={t(locale, 'm8.su.removeFor', { address: suppression.address })}
      >
        {t(locale, 'action.remove')}
      </Button>
      <Note n={open ? null : call.notice} />
      <ConfirmDialog open={open} title={t(locale, 'm8.su.removeTitle')} onClose={close}>
        <p>
          {t(locale, 'm8.su.removeConfirm')} <Ltr>{suppression.address}</Ltr>
        </p>
        {protective && (
          <>
            <Banner tone="danger">{t(locale, 'm8.su.protective')}</Banner>
            <label className="nz-row">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t(locale, 'm8.su.override')}
            </label>
          </>
        )}
        <Note n={call.notice} />
        <div className="nz-row">
          <Button
            variant={protective ? 'danger' : 'primary'}
            disabled={call.busy || (protective && !ack)}
            onClick={remove}
          >
            {t(locale, 'm8.su.removeAction')}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t(locale, 'action.cancel')}
          </Button>
        </div>
        {call.panel}
      </ConfirmDialog>
    </>
  );
}
