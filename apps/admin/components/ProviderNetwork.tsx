'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { NETWORK_FIELDS, NETWORK_PROVIDERS, networkBody } from '../lib/provider-network';
import { Note, useStaffAction } from './BillingAdminPanels';

export interface NetworkRow {
  providerKey: string;
  regionId: string;
  settings: Record<string, string>;
}

/** Admin → Providers → Accounts: the network identifiers Alibaba and Huawei need to place a server (identifiers, never keys). */
export function ProviderNetworkPanel(p: {
  locale: Locale;
  rows: NetworkRow[];
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useStaffAction(p.locale, p.mfaFactorId);
  const [provider, setProvider] = useState(NETWORK_PROVIDERS[0]!);
  const [region, setRegion] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const spec = NETWORK_FIELDS[provider]!;

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = networkBody(provider, region, values);
    if (!r.ok)
      return setErr(
        t(p.locale, r.error === 'region' ? 'prov.net.err.region' : 'prov.net.err.field'),
      );
    setErr(null);
    void a.run(
      () =>
        browserApi().PUT('/v1/admin/provider-network/{providerKey}/{regionId}', {
          params: { path: { providerKey: provider as 'alibaba', regionId: r.region } },
          body: r.body,
        }),
      () => {
        setValues({});
        setRegion('');
        a.setNotice({ tone: 'ok', text: t(p.locale, 'prov.net.saved') });
        router.refresh();
      },
    );
  }
  function remove(row: NetworkRow) {
    void a.run(
      () =>
        browserApi().DELETE('/v1/admin/provider-network/{providerKey}/{regionId}', {
          params: { path: { providerKey: row.providerKey as 'alibaba', regionId: row.regionId } },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'prov.net.removed') });
        router.refresh();
      },
    );
  }

  return (
    <section className="nz-card" aria-label={t(p.locale, 'prov.net.title')}>
      <h2 className="nz-h2">{t(p.locale, 'prov.net.title')}</h2>
      <p className="nz-muted">{t(p.locale, 'prov.net.help')}</p>
      {p.rows.length === 0 ? (
        <EmptyState title={t(p.locale, 'prov.net.empty')} body={t(p.locale, 'prov.net.help')} />
      ) : (
        <Table
          caption={t(p.locale, 'prov.net.title')}
          rows={p.rows}
          rowKey={(r) => `${r.providerKey}/${r.regionId}`}
          columns={[
            {
              key: 'p',
              header: t(p.locale, 'prov.net.col.provider'),
              render: (r) => <Ltr>{r.providerKey}</Ltr>,
            },
            {
              key: 'r',
              header: t(p.locale, 'prov.net.col.region'),
              render: (r) => <Ltr>{r.regionId}</Ltr>,
            },
            {
              key: 's',
              header: t(p.locale, 'prov.net.col.settings'),
              render: (r) => <Ltr>{Object.keys(r.settings).join(', ')}</Ltr>,
            },
            {
              key: 'x',
              header: '',
              render: (r) =>
                p.canManage ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={a.busy}
                    onClick={() => remove(r)}
                  >
                    {t(p.locale, 'prov.net.remove')}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {p.canManage && (
        <form onSubmit={submit} aria-label={t(p.locale, 'prov.net.save')} noValidate>
          <fieldset disabled={a.busy} className="nzc-form-grid nzc-form-grid--3">
            <Field id="pn-provider" label={t(p.locale, 'prov.net.provider')}>
              {(x) => (
                <Select
                  {...x}
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setValues({});
                  }}
                >
                  {NETWORK_PROVIDERS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              id="pn-region"
              label={t(p.locale, 'prov.net.region')}
              help={t(p.locale, 'prov.net.regionHint')}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  autoComplete="off"
                  maxLength={41}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              )}
            </Field>
            {[...spec.required, ...spec.optional].map((f) => (
              <Field
                key={`${provider}-${f}`}
                id={`pn-${f}`}
                label={tDynamic(p.locale, `prov.net.f.${f}`, f)}
              >
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={100}
                    value={values[f] ?? ''}
                    onChange={(e) => setValues((s) => ({ ...s, [f]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </fieldset>
          {err && (
            <p role="alert" className="nz-error-text">
              {err}
            </p>
          )}
          <Button type="submit" disabled={a.busy}>
            {t(p.locale, 'prov.net.save')}
          </Button>
          <Note n={a.notice} />
          {a.panel}
        </form>
      )}
    </section>
  );
}
