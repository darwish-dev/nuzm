'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Button, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export function ApiKeysPanel(p: {
  locale: Locale;
  keys: ApiKey[];
  permissions: string[];
  mfaFactorId: string | null;
  fmt: Record<string, string>;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void a.run(
      () =>
        browserApi().POST('/v1/api-keys', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { name: String(f.get('name')).trim(), scopes: f.getAll('scope').map(String) },
        }),
      (d) => {
        setSecret(d.key);
        form.reset();
        router.refresh();
      },
    );
  }
  return (
    <>
      <form onSubmit={submit} noValidate>
        <Field id="key-name" label={t(p.locale, 'field.keyName')}>
          {(x) => <Input name="name" required maxLength={100} {...x} />}
        </Field>
        <fieldset className="nz-card" style={{ marginBlockEnd: 'var(--nuzm-space-3)' }}>
          <legend>{t(p.locale, 'field.scopes')}</legend>
          <p className="nz-help">{t(p.locale, 'apikeys.scopes.help')}</p>
          <div className="nz-row">
            {p.permissions.map((s) => (
              <label key={s} className="nz-row">
                <input type="checkbox" name="scope" value={s} />
                <Ltr>{s}</Ltr>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'action.create')}
        </Button>
        <NoticeText notice={a.notice} />
      </form>
      {a.panel}
      {secret && (
        <section role="status" className="nz-card" aria-label={t(p.locale, 'apikeys.secret.title')}>
          <h2>{t(p.locale, 'apikeys.secret.title')}</h2>
          <p>{t(p.locale, 'apikeys.secret.body')}</p>
          <p>
            <code>
              <Ltr>{secret}</Ltr>
            </code>
          </p>
          <div className="nz-row">
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard?.writeText(secret);
                setCopied(true);
              }}
            >
              {t(p.locale, 'action.copy')}
            </Button>
            <Button variant="secondary" onClick={() => setSecret(null)}>
              {t(p.locale, 'action.confirm')}
            </Button>
            {copied && <span className="nz-muted">✓</span>}
          </div>
        </section>
      )}
      <div style={{ marginBlockStart: 'var(--nuzm-space-4)' }}>
        <Table
          caption={t(p.locale, 'apikeys.title')}
          rows={p.keys}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: t(p.locale, 'field.name'), render: (r) => r.name },
            { key: 'p', header: t(p.locale, 'field.prefix'), render: (r) => <Ltr>{r.prefix}</Ltr> },
            {
              key: 's',
              header: t(p.locale, 'field.scopes'),
              render: (r) => <Ltr>{r.scopes.join(', ')}</Ltr>,
            },
            { key: 'u', header: t(p.locale, 'field.lastUsed'), render: (r) => p.fmt[r.id] ?? '—' },
            {
              key: 'st',
              header: t(p.locale, 'field.status'),
              render: (r) =>
                r.revokedAt ? (
                  <Badge tone="danger">{t(p.locale, 'status.revoked')}</Badge>
                ) : (
                  <Badge tone="success">{t(p.locale, 'status.active')}</Badge>
                ),
            },
            {
              key: 'a',
              header: t(p.locale, 'field.action'),
              render: (r) =>
                r.revokedAt ? (
                  '—'
                ) : (
                  <Button
                    variant="danger"
                    disabled={a.busy}
                    onClick={() =>
                      window.confirm(t(p.locale, 'confirm.delete', { name: r.name })) &&
                      void a.run(
                        () =>
                          browserApi().DELETE('/v1/api-keys/{id}', {
                            params: { path: { id: r.id } },
                          }),
                        () => router.refresh(),
                      )
                    }
                  >
                    {t(p.locale, 'action.revoke')}
                  </Button>
                ),
            },
          ]}
        />
      </div>
    </>
  );
}

interface SessionRow {
  id: string;
  current: boolean;
  userAgent?: string | null;
  ip?: string | null;
  lastSeenAt: string;
}

export function SessionsTable({
  locale,
  items,
  fmt,
}: {
  locale: Locale;
  items: SessionRow[];
  fmt: Record<string, string>;
}) {
  const router = useRouter();
  const a = useAction(locale, null);
  return (
    <>
      <Table
        caption={t(locale, 'sessions.title')}
        rows={items}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'd',
            header: t(locale, 'field.device'),
            render: (r) => <Ltr>{(r.userAgent ?? '—').slice(0, 60)}</Ltr>,
          },
          { key: 'i', header: t(locale, 'field.ip'), render: (r) => <Ltr>{r.ip ?? '—'}</Ltr> },
          {
            key: 'l',
            header: t(locale, 'field.lastUsed'),
            render: (r) => fmt[r.id] ?? r.lastSeenAt,
          },
          {
            key: 'a',
            header: t(locale, 'field.action'),
            render: (r) =>
              r.current ? (
                <Badge tone="success">{t(locale, 'session.current')}</Badge>
              ) : (
                <Button
                  variant="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(
                      () =>
                        browserApi().DELETE('/v1/auth/sessions/{id}', {
                          params: { path: { id: r.id } },
                        }),
                      () => router.refresh(),
                    )
                  }
                >
                  {t(locale, 'action.revoke')}
                </Button>
              ),
          },
        ]}
      />
      <NoticeText notice={a.notice} />
    </>
  );
}

export function RecoveryCodes({
  locale,
  mfaFactorId,
}: {
  locale: Locale;
  mfaFactorId: string | null;
}) {
  const a = useAction(locale, mfaFactorId);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <>
      <p role="note">{t(locale, 'recovery.warn')}</p>
      <Button
        disabled={a.busy || !mfaFactorId}
        onClick={() =>
          void a.run(
            () => browserApi().POST('/v1/auth/mfa/recovery-codes', {}),
            (d) => setCodes(d.codes),
            { 409: t(locale, 'mfa.title') },
          )
        }
      >
        {t(locale, 'recovery.generate')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
      {codes && (
        <section role="status" className="nz-card" aria-label={t(locale, 'recovery.title')}>
          <p>{t(locale, 'recovery.done')}</p>
          <ul style={{ columns: 2, listStyle: 'none', padding: 0 }}>
            {codes.map((c) => (
              <li key={c}>
                <code>
                  <Ltr>{c}</Ltr>
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function OrgSettingsForm(p: {
  locale: Locale;
  orgId: string;
  name: string;
  defaultLocale: 'ar' | 'en';
  version: number;
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  const [version, setVersion] = useState(p.version);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void a.run(
      () =>
        browserApi().PATCH('/v1/organizations/{orgId}', {
          params: { path: { orgId: p.orgId }, header: { 'If-Match': `"${version}"` } },
          body: {
            name: String(f.get('name')).trim(),
            defaultLocale: String(f.get('locale')) as 'ar' | 'en',
          },
        }),
      (d) => {
        setVersion(d.version);
        a.setNotice({ tone: 'ok', text: t(p.locale, 'settings.saved') });
        router.refresh();
      },
    );
  }
  return (
    <form onSubmit={submit} noValidate style={{ maxInlineSize: 420 }}>
      <Field id="org-name" label={t(p.locale, 'field.name')}>
        {(x) => <Input name="name" defaultValue={p.name} required maxLength={200} {...x} />}
      </Field>
      <Field id="org-locale" label={t(p.locale, 'field.defaultLocale')}>
        {(x) => (
          <Select name="locale" defaultValue={p.defaultLocale} {...x}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'action.save')}
      </Button>
      <NoticeText notice={a.notice} />
    </form>
  );
}
