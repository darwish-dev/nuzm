'use client';
import { useState, type FormEvent } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { useLoad, useToolRun } from '../lib/hosting-tools-client';
import { NoticeText } from './Feedback';

/**
 * Business email: mailboxes within the plan quota, passwords, quotas, aliases, the webmail link, the IMAP/SMTP settings and the read-only DNS checks. Records are only READ:
 * an external mail provider's records are kept, and moving mail to Nuzm is publishing the records shown here at the customer's own DNS provider.
 */
const key = () => crypto.randomUUID();
type Box = {
  domain: string;
  name: string;
  address: string;
  quotaMb: number | null;
  usedMb: number;
  aliases: string[];
};

export function MailManager({
  locale,
  siteId,
  canManage,
}: {
  locale: Locale;
  siteId: string;
  canManage: boolean;
}) {
  const path = { id: siteId };
  const ov = useLoad(
    locale,
    () => browserApi().GET('/v1/hosting/sites/{id}/mail', { params: { path } }),
    siteId,
  );
  const a = useToolRun(locale);
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [quota, setQuota] = useState('');
  const [edit, setEdit] = useState<Record<string, { pw: string; quota: string; alias: string }>>(
    {},
  );
  const reload = () => void ov.reload();
  const data = ov.data;
  const enabled = data?.domains.filter((d) => d.enabled) ?? [];
  const field = (b: Box) =>
    edit[b.address] ?? { pw: '', quota: String(b.quotaMb ?? ''), alias: '' };
  const patch = (b: Box, p: Partial<{ pw: string; quota: string; alias: string }>) =>
    setEdit((o) => ({ ...o, [b.address]: { ...field(b), ...p } }));
  const at = (b: Box) => ({ ...path, domain: b.domain, name: b.name });

  function create(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/hosting/sites/{id}/mail/mailboxes', {
          params: { path, header: { 'Idempotency-Key': key() } },
          body: {
            domain: domain || enabled[0]!.domain,
            name: name.trim(),
            password,
            ...(quota ? { quotaMb: Number(quota) } : {}),
          },
        }),
      'ht.mail.created',
      () => {
        setName('');
        setPassword('');
        setQuota('');
        reload();
      },
      'ht.mail.invalid',
    );
  }
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.mail.intro')}</p>
      {ov.loading && !data && <p className="nz-muted">{t(locale, 'ht.loading')}</p>}
      {ov.error && (
        <p role="alert" className="nz-error-text">
          {ov.error}
        </p>
      )}
      {data && (
        <>
          <p>
            <Badge>
              {t(locale, 'ht.mail.limit', { used: data.used, limit: data.limits.mailboxes })}
            </Badge>
          </p>
          <h2 className="nz-h2">{t(locale, 'ht.mail.domains')}</h2>
          {data.domains.length === 0 ? (
            <EmptyState
              title={t(locale, 'ht.mail.noDomains')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <Table
              caption={t(locale, 'ht.mail.domains')}
              rows={data.domains}
              rowKey={(d) => d.domain}
              columns={[
                {
                  key: 'd',
                  header: t(locale, 'ht.files.domain'),
                  render: (d) => <Ltr>{d.domain}</Ltr>,
                },
                {
                  key: 's',
                  header: t(locale, 'ht.mail.enabled'),
                  render: (d) => (
                    <Badge tone={d.enabled ? 'success' : 'warn'}>
                      {t(locale, d.enabled ? 'ht.mail.enabled' : 'ht.mail.notEnabled')}
                    </Badge>
                  ),
                },
                {
                  key: 'a',
                  header: t(locale, 'ht.files.actions'),
                  render: (d) =>
                    canManage && !d.enabled ? (
                      <Button
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(
                            () =>
                              browserApi().POST('/v1/hosting/sites/{id}/mail/domains', {
                                params: { path, header: { 'Idempotency-Key': key() } },
                                body: { domain: d.domain },
                              }),
                            'ht.mail.enabledOk',
                            reload,
                          )
                        }
                      >
                        {t(locale, 'ht.mail.enable')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}

          <h2 className="nz-h2">{t(locale, 'ht.mail.mailboxes')}</h2>
          {data.mailboxes.length === 0 ? (
            <EmptyState title={t(locale, 'ht.mail.empty')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'ht.mail.mailboxes')}
              rows={data.mailboxes}
              rowKey={(b) => b.address}
              columns={[
                {
                  key: 'a',
                  header: t(locale, 'ht.mail.address'),
                  render: (b) => <Ltr>{b.address}</Ltr>,
                },
                {
                  key: 'q',
                  header: t(locale, 'ht.mail.quota'),
                  render: (b) => `${b.usedMb} / ${b.quotaMb ?? '∞'}`,
                },
                {
                  key: 'l',
                  header: t(locale, 'ht.mail.aliases'),
                  render: (b) => (b.aliases.length ? <Ltr>{b.aliases.join(', ')}</Ltr> : '—'),
                },
                {
                  key: 'm',
                  header: t(locale, 'ht.files.actions'),
                  render: (b) =>
                    canManage ? (
                      <>
                        <Input
                          aria-label={t(locale, 'ht.mail.password')}
                          dir="ltr"
                          type="password"
                          autoComplete="new-password"
                          value={field(b).pw}
                          onChange={(e) => patch(b, { pw: e.target.value })}
                        />{' '}
                        <Button
                          variant="secondary"
                          disabled={a.busy || field(b).pw.length < 12}
                          onClick={() =>
                            void a.run(
                              () =>
                                browserApi().PUT(
                                  '/v1/hosting/sites/{id}/mail/mailboxes/{domain}/{name}/password',
                                  { params: { path: at(b) }, body: { password: field(b).pw } },
                                ),
                              'ht.mail.updated',
                              () => patch(b, { pw: '' }),
                              'ht.mail.invalid',
                            )
                          }
                        >
                          {t(locale, 'ht.mail.changePw')}
                        </Button>
                        <br />
                        <Input
                          aria-label={t(locale, 'ht.mail.quota')}
                          dir="ltr"
                          type="number"
                          min={1}
                          max={data.limits.mailboxQuotaMb}
                          value={field(b).quota}
                          onChange={(e) => patch(b, { quota: e.target.value })}
                        />{' '}
                        <Button
                          variant="secondary"
                          disabled={a.busy || !field(b).quota}
                          onClick={() =>
                            void a.run(
                              () =>
                                browserApi().PUT(
                                  '/v1/hosting/sites/{id}/mail/mailboxes/{domain}/{name}/quota',
                                  {
                                    params: { path: at(b) },
                                    body: { quotaMb: Number(field(b).quota) },
                                  },
                                ),
                              'ht.mail.updated',
                              reload,
                              'ht.mail.invalid',
                            )
                          }
                        >
                          {t(locale, 'ht.mail.saveQuota')}
                        </Button>
                        <br />
                        <Input
                          aria-label={t(locale, 'ht.mail.alias')}
                          dir="ltr"
                          value={field(b).alias}
                          onChange={(e) => patch(b, { alias: e.target.value })}
                        />{' '}
                        <Button
                          variant="secondary"
                          disabled={a.busy || !field(b).alias}
                          onClick={() =>
                            void a.run(
                              () =>
                                browserApi().POST(
                                  '/v1/hosting/sites/{id}/mail/mailboxes/{domain}/{name}/aliases',
                                  {
                                    params: { path: at(b), header: { 'Idempotency-Key': key() } },
                                    body: { alias: field(b).alias.trim().toLowerCase() },
                                  },
                                ),
                              'ht.mail.updated',
                              reload,
                              'ht.mail.invalid',
                            )
                          }
                        >
                          {t(locale, 'ht.mail.addAlias')}
                        </Button>{' '}
                        {b.aliases.map((al) => (
                          <Button
                            key={al}
                            variant="secondary"
                            disabled={a.busy}
                            aria-label={`${t(locale, 'ht.mail.delete')} ${al}`}
                            onClick={() =>
                              void a.run(
                                () =>
                                  browserApi().DELETE(
                                    '/v1/hosting/sites/{id}/mail/mailboxes/{domain}/{name}/aliases/{alias}',
                                    { params: { path: { ...at(b), alias: al } } },
                                  ),
                                'ht.mail.deleted',
                                reload,
                              )
                            }
                          >
                            ✕ {al}
                          </Button>
                        ))}
                        <br />
                        <Button
                          variant="danger"
                          disabled={a.busy}
                          onClick={() =>
                            void a.run(
                              () =>
                                browserApi().DELETE(
                                  '/v1/hosting/sites/{id}/mail/mailboxes/{domain}/{name}',
                                  { params: { path: at(b) } },
                                ),
                              'ht.mail.deleted',
                              reload,
                            )
                          }
                        >
                          {t(locale, 'ht.mail.delete')}
                        </Button>
                      </>
                    ) : null,
                },
              ]}
            />
          )}
          {canManage && enabled.length > 0 && (
            <form
              onSubmit={create}
              noValidate
              className="nz-card"
              aria-label={t(locale, 'ht.mail.create')}
            >
              <h2 className="nz-h2">{t(locale, 'ht.mail.create')}</h2>
              {enabled.length > 1 && (
                <Field id="ht-mail-domain" label={t(locale, 'ht.files.domain')}>
                  {(x) => (
                    <Select
                      {...x}
                      value={domain || enabled[0]!.domain}
                      onChange={(e) => setDomain(e.target.value)}
                    >
                      {enabled.map((d) => (
                        <option key={d.domain} value={d.domain}>
                          {d.domain}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field id="ht-mail-name" label={t(locale, 'ht.mail.name')}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    autoComplete="off"
                    maxLength={64}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <Field id="ht-mail-pass" label={t(locale, 'ht.mail.password')}>
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    type="password"
                    autoComplete="new-password"
                    maxLength={64}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="ht-mail-quota"
                label={t(locale, 'ht.mail.quota')}
                help={t(locale, 'ht.mail.quotaMax', { mb: data.limits.mailboxQuotaMb })}
              >
                {(x) => (
                  <Input
                    {...x}
                    dir="ltr"
                    type="number"
                    min={1}
                    max={data.limits.mailboxQuotaMb}
                    value={quota}
                    onChange={(e) => setQuota(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" disabled={a.busy || !name || password.length < 12}>
                {t(locale, 'ht.mail.create')}
              </Button>
            </form>
          )}
          <NoticeText notice={a.notice} />

          {data.settings.length > 0 && (
            <section aria-label={t(locale, 'ht.mail.settings')}>
              <h2 className="nz-h2">{t(locale, 'ht.mail.settings')}</h2>
              {data.settings.map((s) => (
                <div className="nz-card" key={s.domain}>
                  <strong>
                    <Ltr>{s.domain}</Ltr>
                  </strong>
                  <p>
                    <Ltr>
                      {t(locale, 'ht.mail.imap', {
                        host: s.imap.host,
                        ssl: s.imap.ssl,
                        startTls: s.imap.startTls,
                      })}
                    </Ltr>
                  </p>
                  <p>
                    <Ltr>
                      {t(locale, 'ht.mail.smtp', {
                        host: s.smtp.host,
                        ssl: s.smtp.ssl,
                        startTls: s.smtp.startTls,
                      })}
                    </Ltr>
                  </p>
                  <p>{t(locale, 'ht.mail.username')}</p>
                  {s.webmailUrl && (
                    <a
                      className="nz-btn"
                      data-variant="secondary"
                      href={s.webmailUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t(locale, 'ht.mail.webmail')}
                    </a>
                  )}
                  <p className="nz-muted">{t(locale, 'ht.notVerified')}</p>
                </div>
              ))}
              <DnsChecks locale={locale} siteId={siteId} domains={enabled.map((d) => d.domain)} />
            </section>
          )}
        </>
      )}
    </>
  );
}

const CHECK_KEY: Record<string, MessageKey> = {
  mx: 'ht.mail.check.mx',
  spf: 'ht.mail.check.spf',
  dkim: 'ht.mail.check.dkim',
  dmarc: 'ht.mail.check.dmarc',
  mail_host: 'ht.mail.check.mail_host',
  webmail_host: 'ht.mail.check.webmail_host',
  ptr: 'ht.mail.check.ptr',
};
function DnsChecks({
  locale,
  siteId,
  domains,
}: {
  locale: Locale;
  siteId: string;
  domains: string[];
}) {
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [asked, setAsked] = useState('');
  const dns = useLoad(
    locale,
    () =>
      asked
        ? browserApi().GET('/v1/hosting/sites/{id}/mail/dns-checks', {
            params: { path: { id: siteId }, query: { domain: asked } },
          })
        : Promise.resolve({ response: { ok: false, status: 0 } } as never),
    asked,
  );
  return (
    <section aria-label={t(locale, 'ht.mail.dns')}>
      <h3 className="nz-h2">{t(locale, 'ht.mail.dns')}</h3>
      <p className="nz-muted">{t(locale, 'ht.mail.dns.note')}</p>
      <Field id="ht-dns-domain" label={t(locale, 'ht.files.domain')}>
        {(x) => (
          <Select {...x} value={domain} onChange={(e) => setDomain(e.target.value)}>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button onClick={() => setAsked(domain)} disabled={!domain || dns.loading}>
        {t(locale, 'ht.mail.dns.run')}
      </Button>
      {asked && dns.error && (
        <p role="alert" className="nz-error-text">
          {dns.error}
        </p>
      )}
      {asked && dns.data && (
        <>
          <p>{t(locale, dns.data.mailHostingMoved ? 'ht.mail.dns.moved' : 'ht.mail.dns.kept')}</p>
          {dns.data.serverIp && (
            <p>
              <Ltr>{t(locale, 'ht.mail.dns.ip', { ip: dns.data.serverIp })}</Ltr>
            </p>
          )}
          <Table
            caption={t(locale, 'ht.mail.dns')}
            rows={dns.data.checks}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'i',
                header: t(locale, 'ht.mail.dns'),
                render: (c) => t(locale, CHECK_KEY[c.id] ?? 'ht.mail.dns'),
              },
              {
                key: 's',
                header: t(locale, 'ht.mail.state.ok'),
                render: (c) => (
                  <Badge
                    tone={
                      c.state === 'ok' ? 'success' : c.state === 'external' ? undefined : 'warn'
                    }
                  >
                    {t(locale, `ht.mail.state.${c.state}` as MessageKey)}
                  </Badge>
                ),
              },
              {
                key: 'e',
                header:
                  t(locale, 'ht.mail.dns.expected', { type: '', name: '', value: '' }).split(
                    ':',
                  )[0] ?? '',
                render: (c) => (
                  <Ltr>
                    {c.expected ? t(locale, 'ht.mail.dns.expected', c.expected) : '—'}
                    {' · '}
                    {t(locale, 'ht.mail.dns.found', {
                      found: c.found.length ? c.found.join(' | ') : t(locale, 'ht.mail.dns.none'),
                    })}
                  </Ltr>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
