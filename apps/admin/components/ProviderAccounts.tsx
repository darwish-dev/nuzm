'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { toMinor } from '../lib/finance';
import {
  formatCost,
  isUuid,
  isVaultRef,
  newKey,
  problemCode,
  safeCredentialRef,
  type AccountDto,
  type ProviderDto,
} from '../lib/providers';
import { JobPoller, ProviderResult, useProviderAction } from './ProviderBits';
import { HealthBadge } from './ProviderRegistry';

/** Start a verification or catalog-sync job (202) and follow it. One idempotency key per click-through; a retry replays the same job. */
export function AccountActions(p: {
  locale: Locale;
  accountId: string;
  mfaFactorId: string | null;
  canManage: boolean;
  /** Which jobs to offer: the list only verifies, the detail page also syncs the catalog. */
  catalog?: boolean;
}) {
  const router = useRouter();
  const a = useProviderAction(p.locale, p.mfaFactorId);
  const [job, setJob] = useState<{ id: string; kind: 'verification' | 'catalog' } | null>(null);
  const [idem, setIdem] = useState(newKey());
  if (!p.canManage) return null;
  const start = (kind: 'verification' | 'catalog') =>
    void a.run(
      () =>
        kind === 'verification'
          ? browserApi().POST('/v1/admin/provider-accounts/{id}/verification', {
              params: { path: { id: p.accountId } },
              headers: { 'Idempotency-Key': idem },
            })
          : browserApi().POST('/v1/admin/provider-accounts/{id}/catalog-syncs', {
              params: { path: { id: p.accountId } },
              headers: { 'Idempotency-Key': idem },
            }),
      (d) => {
        setJob({ id: (d as { operationId: string }).operationId, kind });
        setIdem(newKey());
      },
      a.overrides,
    );
  return (
    <div>
      <span className="nz-row">
        <Button
          variant="secondary"
          disabled={a.busy}
          aria-label={t(p.locale, 'm05.adm.acc.verifyFor', { id: p.accountId.slice(0, 8) })}
          onClick={() => start('verification')}
        >
          {t(p.locale, 'm05.adm.acc.verify')}
        </Button>
        {p.catalog && (
          <Button variant="secondary" disabled={a.busy} onClick={() => start('catalog')}>
            {t(p.locale, 'm05.adm.acc.sync')}
          </Button>
        )}
      </span>
      <ProviderResult n={a.notice} problem={a.problem} locale={p.locale} />
      {job && (
        <JobPoller key={job.id} locale={p.locale} jobId={job.id} onDone={() => router.refresh()} />
      )}
      {a.panel}
    </div>
  );
}

/** UI-M05-09: accounts with health, verification time and cap. The credential column shows the vault reference only, never a value. */
export function AccountsTable(p: {
  locale: Locale;
  rows: AccountDto[];
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  if (p.rows.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.acc.empty.title')}
        body={t(p.locale, 'm05.adm.acc.empty.body')}
      />
    );
  return (
    <Table
      caption={t(p.locale, 'm05.adm.acc.title')}
      rows={p.rows}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'n',
          header: t(p.locale, 'm05.adm.col.account'),
          render: (r) => <a href={`/${p.locale}/providers/accounts/${r.id}`}>{r.name}</a>,
        },
        {
          key: 'p',
          header: t(p.locale, 'm05.adm.col.provider'),
          render: (r) => <Ltr>{r.providerKey}</Ltr>,
        },
        {
          key: 'c',
          header: t(p.locale, 'm05.adm.col.credentialRef'),
          render: (r) => {
            const ref = safeCredentialRef(r.credentialRef);
            return ref ? (
              <Ltr>{ref}</Ltr>
            ) : (
              <span className="nz-muted">{t(p.locale, 'm05.adm.acc.refHidden')}</span>
            );
          },
        },
        {
          key: 's',
          header: t(p.locale, 'm05.adm.col.status'),
          render: (r) => (
            <Badge tone={r.status === 'active' ? undefined : 'warn'}>
              {tDynamic(p.locale, `m05.adm.status.${r.status}`, r.status)}
            </Badge>
          ),
        },
        {
          key: 'h',
          header: t(p.locale, 'm05.adm.col.health'),
          render: (r) => <HealthBadge locale={p.locale} state={r.health?.state} />,
        },
        {
          key: 'v',
          header: t(p.locale, 'm05.adm.col.verified'),
          render: (r) =>
            r.verifiedAt ? (
              formatDateTime(r.verifiedAt, p.locale)
            ) : (
              <Badge tone="warn">{t(p.locale, 'm05.adm.acc.notVerified')}</Badge>
            ),
        },
        {
          key: 'cap',
          header: t(p.locale, 'm05.adm.col.spendCap'),
          render: (r) =>
            r.spendCap ? <Ltr>{formatCost(r.spendCap.amountMinor, r.spendCap.currency)}</Ltr> : '—',
        },
        ...(p.canManage
          ? [
              {
                key: 'x',
                header: t(p.locale, 'field.action'),
                render: (r: AccountDto) => (
                  <AccountActions
                    locale={p.locale}
                    accountId={r.id}
                    mfaFactorId={p.mfaFactorId}
                    canManage
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/**
 * Add an account. The only credential field is a `vault://` reference: anything else is refused here before a request is made, and a value
 * the server rejects is cleared from the field and never echoed back. The credential itself lives in the vault, created by a person.
 */
export function AddAccountForm(p: {
  locale: Locale;
  providers: ProviderDto[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useProviderAction(p.locale, p.mfaFactorId);
  const [providerId, setProviderId] = useState(p.providers[0]?.id ?? '');
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [scope, setScope] = useState('');
  const [cap, setCap] = useState('');
  const [currency, setCurrency] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [idem, setIdem] = useState(newKey());
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!isUuid(providerId)) next.provider = t(p.locale, 'm05.adm.err.required');
    if (name.trim() === '') next.name = t(p.locale, 'm05.adm.err.required');
    if (!isVaultRef(ref)) next.ref = t(p.locale, 'm05.adm.acc.err.vaultRef');
    const minor = cap.trim() ? toMinor(cap, 2) : null;
    if ((cap.trim() || currency.trim()) && (!minor || !/^[A-Za-z]{3}$/.test(currency.trim())))
      next.cap = t(p.locale, 'm05.adm.acc.err.cap');
    setErrs(next);
    if (Object.keys(next).length) return;
    void a.run(
      () =>
        browserApi().POST('/v1/admin/provider-accounts', {
          headers: { 'Idempotency-Key': idem },
          body: {
            providerId,
            name: name.trim(),
            credentialRef: ref.trim(),
            ...(scope.trim() ? { scopeNote: scope.trim() } : {}),
            ...(minor
              ? { spendCap: { amountMinor: minor, currency: currency.trim().toUpperCase() } }
              : {}),
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm05.adm.acc.created') });
        setName('');
        setRef('');
        setScope('');
        setCap('');
        setCurrency('');
        setIdem(newKey());
        router.refresh();
      },
      a.overrides,
    );
  }
  // a value the server refused is wiped from the field: it must not stay on screen
  useEffect(() => {
    if (a.notice?.tone === 'error' && problemCode(a.problem) === 'credential_value_rejected')
      setRef('');
  }, [a.notice, a.problem]);
  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(p.locale, 'm05.adm.acc.add')}
      noValidate
    >
      <h2 className="nz-h2">{t(p.locale, 'm05.adm.acc.add')}</h2>
      <p className="nz-muted">{t(p.locale, 'm05.adm.acc.addHelp')}</p>
      <Field id="pa-provider" label={t(p.locale, 'm05.adm.col.provider')} error={errs.provider}>
        {(x) => (
          <Select {...x} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {p.providers.map((v) => (
              <option key={v.id} value={v.id}>
                {v.key}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="pa-name" label={t(p.locale, 'field.name')} error={errs.name}>
        {(x) => (
          <Input {...x} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <Field
        id="pa-ref"
        label={t(p.locale, 'm05.adm.col.credentialRef')}
        help={t(p.locale, 'm05.adm.acc.refHelp')}
        error={errs.ref}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="vault://providers/alibaba/prod"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        )}
      </Field>
      <Field id="pa-scope" label={t(p.locale, 'm05.adm.acc.scopeNote')}>
        {(x) => (
          <Input {...x} maxLength={500} value={scope} onChange={(e) => setScope(e.target.value)} />
        )}
      </Field>
      <Field
        id="pa-cap"
        label={t(p.locale, 'm05.adm.acc.capAmount')}
        help={t(p.locale, 'm05.adm.acc.capHelp')}
        error={errs.cap}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        )}
      </Field>
      <Field id="pa-cur" label={t(p.locale, 'm05.adm.acc.capCurrency')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'm05.adm.acc.addSubmit')}
      </Button>
      <ProviderResult n={a.notice} problem={a.problem} locale={p.locale} />
      {a.panel}
    </form>
  );
}
