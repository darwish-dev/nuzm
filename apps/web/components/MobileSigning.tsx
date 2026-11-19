'use client';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { validateSigning, type SigningCredential, type SigningError } from '../lib/mobile';
import { MobileProblem } from './MobileParts';

const ERR_KEY = {
  label: 'mobile.signing.err.label',
  vaultFormat: 'mobile.signing.err.vaultFormat',
  rawSecret: 'mobile.signing.err.rawSecret',
} as const;

/**
 * UI-M10-15: signing credential REFERENCES. The form has exactly three inputs: platform, a label and a `vault://` reference. There is no field for a key, keystore,
 * certificate or password; a value that looks like key material is refused in the browser and never sent. `authorizedBy` is the signed-in user. Revoking has no endpoint
 * yet (SCR-M10B-01), so the screen says so instead of offering a control.
 */
export function MobileSigning({
  locale,
  userId,
  initial,
}: {
  locale: Locale;
  userId: string;
  initial: SigningCredential[];
}) {
  const call = useBuilderCall();
  const [items, setItems] = useState(initial);
  const [platform, setPlatform] = useState('android');
  const [label, setLabel] = useState('');
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<SigningError | null>(null);
  const [done, setDone] = useState(false);
  const [key, setKey] = useState(newKey());

  function submit(e: FormEvent) {
    e.preventDefault();
    if (call.busy) return;
    setDone(false);
    const v = validateSigning({ platform, label, vaultRef: ref }, userId);
    if (!v.ok) {
      setErr(v.error);
      // a value that looks like key material is cleared from the field: it must not linger on the screen
      if (v.error === 'rawSecret') setRef('');
      return;
    }
    setErr(null);
    void call.run(
      () =>
        bapi.post<SigningCredential>('/v1/mobile/signing-credentials', {
          body: v.body,
          idempotencyKey: key,
        }),
      (c) => {
        setKey(newKey());
        setItems((cur) => [c, ...cur.filter((x) => x.id !== c.id)]);
        setLabel('');
        setRef('');
        setDone(true);
      },
      (p) => {
        setKey(newKey());
        // the service refused the value as a secret: clear it
        if (p.code === 'raw_secret_rejected') setRef('');
      },
    );
  }

  return (
    <>
      <p>{t(locale, 'mobile.signing.intro')}</p>
      <form onSubmit={submit} aria-labelledby="mobile-sign-h" noValidate autoComplete="off">
        <h2 className="nz-h2" id="mobile-sign-h">
          {t(locale, 'mobile.signing.form')}
        </h2>
        <Field id="mobile-sign-platform" label={t(locale, 'mobile.signing.platform')}>
          {(a) => (
            <Select {...a} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="android">{t(locale, 'mobile.platform.android')}</option>
              <option value="ios">{t(locale, 'mobile.platform.ios')}</option>
            </Select>
          )}
        </Field>
        <Field
          id="mobile-sign-label"
          label={t(locale, 'mobile.signing.label')}
          help={t(locale, 'mobile.signing.labelHelp')}
          error={err === 'label' ? t(locale, ERR_KEY.label) : undefined}
        >
          {(a) => (
            <Input
              {...a}
              dir="auto"
              maxLength={100}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="mobile-sign-ref"
          label={t(locale, 'mobile.signing.vaultRef')}
          help={t(locale, 'mobile.signing.vaultRefHelp')}
          error={err === 'vaultFormat' || err === 'rawSecret' ? t(locale, ERR_KEY[err]) : undefined}
        >
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              placeholder="vault://org/mobile/android-upload"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          )}
        </Field>
        <p>
          {t(locale, 'mobile.signing.authorizedBy')}: {t(locale, 'mobile.signing.authorizedByYou')}
        </p>
        <p>
          <Button type="submit" disabled={call.busy} aria-busy={call.busy}>
            {t(locale, 'mobile.signing.create')}
          </Button>
        </p>
        {done && !call.problem && <p role="status">{t(locale, 'mobile.signing.created')}</p>}
        {call.problem && <MobileProblem locale={locale} problem={call.problem} />}
      </form>
      <h2 className="nz-h2">{t(locale, 'mobile.signing.list')}</h2>
      <Banner tone="warn">{t(locale, 'mobile.signing.revokeNote')}</Banner>
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, 'mobile.signing.empty.title')}
          body={t(locale, 'mobile.signing.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'mobile.signing.caption')}
          rows={items}
          rowKey={(c) => c.id}
          columns={[
            {
              key: 'label',
              header: t(locale, 'mobile.signing.col.label'),
              card: 'title',
              render: (c) => <bdi dir="auto">{c.label}</bdi>,
            },
            {
              key: 'platform',
              header: t(locale, 'mobile.signing.col.platform'),
              card: 'chip',
              render: (c) => t(locale, `mobile.platform.${c.platform}`),
            },
            {
              key: 'ref',
              header: t(locale, 'mobile.signing.col.ref'),
              card: 'meta',
              render: (c) => <Ltr>{c.vaultRef}</Ltr>,
            },
            {
              key: 'by',
              header: t(locale, 'mobile.signing.col.by'),
              card: 'meta',
              render: (c) => formatDateTime(c.authorizedAt, locale),
            },
            {
              key: 'state',
              header: t(locale, 'mobile.signing.col.state'),
              card: 'badge',
              render: (c) => (
                <Badge tone={c.usable ? 'success' : 'warn'}>
                  {t(locale, c.usable ? 'mobile.signing.usable' : 'mobile.signing.revoked')}
                </Badge>
              ),
            },
          ]}
        />
      )}
    </>
  );
}
