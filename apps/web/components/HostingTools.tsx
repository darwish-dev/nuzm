'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { useLoad, useToolRun } from '../lib/hosting-tools-client';
import { NoticeText } from './Feedback';

/**
 * The panel-backed website tools: scheduled jobs, logs, FTP accounts, password protection and the PHP version. Each screen reads from the API (which reads the panel) and
 * every change goes through the API (which authorizes, checks the plan limit, audits and reconciles). Passwords are typed here, sent once and never shown again.
 */
const key = () => crypto.randomUUID();
const Loading = ({ locale }: { locale: Locale }) => (
  <p className="nz-muted">{t(locale, 'ht.loading')}</p>
);
const Problem = ({ text }: { text: string }) => (
  <p role="alert" className="nz-error-text">
    {text}
  </p>
);

/* ───────────── cron ───────────── */
type Job = {
  id: string;
  min: string;
  hour: string;
  day: string;
  month: string;
  wday: string;
  command: string;
};
const EMPTY_JOB = { min: '0', hour: '2', day: '*', month: '*', wday: '*', command: '' };
const PRESETS: Record<string, typeof EMPTY_JOB> = {
  hourly: { ...EMPTY_JOB, min: '0', hour: '*' },
  daily: { ...EMPTY_JOB, min: '0', hour: '2' },
  weekly: { ...EMPTY_JOB, min: '0', hour: '3', wday: '0' },
};
export function CronManager({
  locale,
  siteId,
  minIntervalMinutes,
}: {
  locale: Locale;
  siteId: string;
  minIntervalMinutes: number;
}) {
  const path = { id: siteId };
  const list = useLoad(
    locale,
    () => browserApi().GET('/v1/hosting/sites/{id}/cron-jobs', { params: { path } }),
    siteId,
  );
  const a = useToolRun(locale);
  const [form, setForm] = useState({ ...EMPTY_JOB });
  const [editing, setEditing] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY_JOB, v: string) => setForm((f) => ({ ...f, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { ...form, command: form.command.trim() };
    void a.run(
      () =>
        editing
          ? browserApi().PUT('/v1/hosting/sites/{id}/cron-jobs/{job}', {
              params: { path: { ...path, job: editing } },
              body,
            })
          : browserApi().POST('/v1/hosting/sites/{id}/cron-jobs', {
              params: { path, header: { 'Idempotency-Key': key() } },
              body,
            }),
      editing ? 'ht.cron.saved' : 'ht.cron.added',
      () => {
        setForm({ ...EMPTY_JOB });
        setEditing(null);
        void list.reload();
      },
      'ht.cron.invalid',
    );
  }
  const jobs = list.data?.items ?? [];
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.cron.intro', { minutes: minIntervalMinutes })}</p>
      {list.loading && !list.data && <Loading locale={locale} />}
      {list.error && <Problem text={list.error} />}
      {list.data && (
        <>
          <p>
            <Badge>
              {t(locale, 'ht.cron.limit', { used: jobs.length, limit: list.data.limit })}
            </Badge>
          </p>
          {jobs.length === 0 ? (
            <EmptyState title={t(locale, 'ht.cron.empty')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'ht.cron.title')}
              rows={jobs}
              rowKey={(j: Job) => j.id}
              columns={[
                {
                  key: 's',
                  header: t(locale, 'ht.cron.min'),
                  render: (j: Job) => (
                    <Ltr>{`${j.min} ${j.hour} ${j.day} ${j.month} ${j.wday}`}</Ltr>
                  ),
                },
                {
                  key: 'c',
                  header: t(locale, 'ht.cron.command'),
                  render: (j: Job) => <Ltr>{j.command}</Ltr>,
                },
                {
                  key: 'a',
                  header: t(locale, 'ht.files.actions'),
                  render: (j: Job) => (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEditing(j.id);
                          setForm({
                            min: j.min,
                            hour: j.hour,
                            day: j.day,
                            month: j.month,
                            wday: j.wday,
                            command: j.command,
                          });
                        }}
                      >
                        {t(locale, 'ht.cron.edit')}
                      </Button>{' '}
                      <Button
                        variant="danger"
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(
                            () =>
                              browserApi().DELETE('/v1/hosting/sites/{id}/cron-jobs/{job}', {
                                params: { path: { ...path, job: j.id } },
                              }),
                            'ht.cron.deleted',
                            () => void list.reload(),
                          )
                        }
                      >
                        {t(locale, 'ht.cron.delete')}
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <form onSubmit={submit} noValidate className="nz-card" aria-label={t(locale, 'ht.cron.add')}>
        <h2 className="nz-h2">{t(locale, editing ? 'ht.cron.save' : 'ht.cron.add')}</h2>
        <Field id="ht-cron-preset" label={t(locale, 'ht.cron.preset')}>
          {(x) => (
            <Select
              {...x}
              value=""
              onChange={(e) => e.target.value && setForm(PRESETS[e.target.value]!)}
            >
              <option value="">—</option>
              <option value="hourly">{t(locale, 'ht.cron.p.hourly')}</option>
              <option value="daily">{t(locale, 'ht.cron.p.daily')}</option>
              <option value="weekly">{t(locale, 'ht.cron.p.weekly')}</option>
            </Select>
          )}
        </Field>
        {(['min', 'hour', 'day', 'month', 'wday'] as const).map((k) => (
          <Field key={k} id={`ht-cron-${k}`} label={t(locale, `ht.cron.${k}`)}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                maxLength={40}
                value={form[k]}
                onChange={(e) => set(k, e.target.value)}
              />
            )}
          </Field>
        ))}
        <Field id="ht-cron-cmd" label={t(locale, 'ht.cron.command')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              placeholder="php /home/…/cron.php"
              value={form.command}
              onChange={(e) => set('command', e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={a.busy || !form.command.trim()}>
          {t(locale, editing ? 'ht.cron.save' : 'ht.cron.add')}
        </Button>
        {editing && (
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setForm({ ...EMPTY_JOB });
            }}
          >
            {t(locale, 'ht.files.cancel')}
          </Button>
        )}
        <NoticeText notice={a.notice} />
      </form>
    </>
  );
}

/* ───────────── logs ───────────── */
export function LogViewer({
  locale,
  siteId,
  domains,
  linesDefault,
  linesMax,
}: {
  locale: Locale;
  siteId: string;
  domains: string[];
  linesDefault: number;
  linesMax: number;
}) {
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [kind, setKind] = useState<'access' | 'error'>('error');
  const [lines, setLines] = useState(String(linesDefault));
  const [q, setQ] = useState({ domain, kind, lines });
  const logs = useLoad(
    locale,
    () =>
      browserApi().GET('/v1/hosting/sites/{id}/logs', {
        params: {
          path: { id: siteId },
          query: { domain: q.domain || undefined, kind: q.kind, lines: Number(q.lines) },
        },
      }),
    JSON.stringify(q),
  );
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.logs.intro', { max: linesMax })}</p>
      <form
        className="nz-card"
        onSubmit={(e) => {
          e.preventDefault();
          setQ({ domain, kind, lines });
        }}
      >
        {domains.length > 1 && (
          <Field id="ht-log-domain" label={t(locale, 'ht.logs.domain')}>
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
        )}
        <Field id="ht-log-kind" label={t(locale, 'ht.logs.kind')}>
          {(x) => (
            <Select
              {...x}
              value={kind}
              onChange={(e) => setKind(e.target.value as 'access' | 'error')}
            >
              <option value="error">{t(locale, 'ht.logs.error')}</option>
              <option value="access">{t(locale, 'ht.logs.access')}</option>
            </Select>
          )}
        </Field>
        <Field id="ht-log-lines" label={t(locale, 'ht.logs.lines')}>
          {(x) => (
            <Input
              {...x}
              type="number"
              min={1}
              max={linesMax}
              dir="ltr"
              value={lines}
              onChange={(e) => setLines(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={logs.loading}>
          {t(locale, 'ht.logs.show')}
        </Button>
      </form>
      {logs.loading && !logs.data && <Loading locale={locale} />}
      {logs.error && <Problem text={logs.error} />}
      {logs.data &&
        (logs.data.lines.length === 0 ? (
          <EmptyState title={t(locale, 'ht.logs.empty')} body={t(locale, 'state.empty.body')} />
        ) : (
          <>
            {logs.data.truncated && <p className="nz-muted">{t(locale, 'ht.logs.truncated')}</p>}
            <pre className="nzc-log" dir="ltr" tabIndex={0} aria-label={t(locale, 'ht.logs.title')}>
              {logs.data.lines.join('\n')}
            </pre>
          </>
        ))}
    </>
  );
}

/* ───────────── FTP accounts ───────────── */
export function FtpManager({
  locale,
  siteId,
  domains,
}: {
  locale: Locale;
  siteId: string;
  domains: string[];
}) {
  const path = { id: siteId };
  const list = useLoad(
    locale,
    () => browserApi().GET('/v1/hosting/sites/{id}/ftp-accounts', { params: { path } }),
    siteId,
  );
  const a = useToolRun(locale);
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [dir, setDir] = useState('');
  const [pw, setPw] = useState<Record<string, string>>({});
  function add(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/hosting/sites/{id}/ftp-accounts', {
          params: { path, header: { 'Idempotency-Key': key() } },
          body: {
            name: name.trim(),
            password,
            ...(domain ? { domain } : {}),
            ...(dir.trim() ? { path: dir.trim() } : {}),
          },
        }),
      'ht.ftp.created',
      () => {
        setName('');
        setPassword('');
        setDir('');
        void list.reload();
      },
      'ht.ftp.invalid',
    );
  }
  const items = list.data?.items ?? [];
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.ftp.intro')}</p>
      {list.loading && !list.data && <Loading locale={locale} />}
      {list.error && <Problem text={list.error} />}
      {list.data && (
        <>
          <p>
            <Badge>
              {t(locale, 'ht.ftp.limit', { used: items.length, limit: list.data.limit })}
            </Badge>
          </p>
          {items.length === 0 ? (
            <EmptyState title={t(locale, 'ht.ftp.empty')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'ht.ftp.title')}
              rows={items}
              rowKey={(r) => `${r.domain}/${r.user}`}
              columns={[
                { key: 'u', header: t(locale, 'ht.ftp.user'), render: (r) => <Ltr>{r.user}</Ltr> },
                {
                  key: 'd',
                  header: t(locale, 'ht.ftp.domain'),
                  render: (r) => <Ltr>{r.domain}</Ltr>,
                },
                { key: 'p', header: t(locale, 'ht.ftp.path'), render: (r) => <Ltr>{r.path}</Ltr> },
                {
                  key: 'a',
                  header: t(locale, 'ht.files.actions'),
                  render: (r) => (
                    <>
                      <Input
                        aria-label={t(locale, 'ht.ftp.password')}
                        dir="ltr"
                        type="password"
                        autoComplete="new-password"
                        value={pw[`${r.domain}/${r.user}`] ?? ''}
                        onChange={(e) =>
                          setPw((o) => ({ ...o, [`${r.domain}/${r.user}`]: e.target.value }))
                        }
                      />{' '}
                      <Button
                        variant="secondary"
                        disabled={a.busy || !(pw[`${r.domain}/${r.user}`] ?? '')}
                        onClick={() =>
                          void a.run(
                            () =>
                              browserApi().PUT(
                                '/v1/hosting/sites/{id}/ftp-accounts/{domain}/{user}/password',
                                {
                                  params: { path: { ...path, domain: r.domain, user: r.user } },
                                  body: { password: pw[`${r.domain}/${r.user}`] ?? '' },
                                },
                              ),
                            'ht.ftp.updated',
                            () => setPw((o) => ({ ...o, [`${r.domain}/${r.user}`]: '' })),
                            'ht.ftp.invalid',
                          )
                        }
                      >
                        {t(locale, 'ht.ftp.changePw')}
                      </Button>{' '}
                      <Button
                        variant="danger"
                        disabled={a.busy}
                        onClick={() =>
                          void a.run(
                            () =>
                              browserApi().DELETE(
                                '/v1/hosting/sites/{id}/ftp-accounts/{domain}/{user}',
                                {
                                  params: { path: { ...path, domain: r.domain, user: r.user } },
                                },
                              ),
                            'ht.ftp.deleted',
                            () => void list.reload(),
                          )
                        }
                      >
                        {t(locale, 'ht.ftp.delete')}
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <form onSubmit={add} noValidate className="nz-card" aria-label={t(locale, 'ht.ftp.add')}>
        <h2 className="nz-h2">{t(locale, 'ht.ftp.add')}</h2>
        {domains.length > 1 && (
          <Field id="ht-ftp-domain" label={t(locale, 'ht.ftp.domain')}>
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
        )}
        <Field id="ht-ftp-name" label={t(locale, 'ht.ftp.name')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              autoComplete="off"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id="ht-ftp-pass" label={t(locale, 'ht.ftp.password')}>
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
        <Field id="ht-ftp-path" label={t(locale, 'ht.ftp.path')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              placeholder="/public_html"
              maxLength={201}
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={a.busy || !name || password.length < 12}>
          {t(locale, 'ht.ftp.add')}
        </Button>
        <NoticeText notice={a.notice} />
      </form>
    </>
  );
}

/* ───────────── password protection ───────────── */
export function ProtectionManager({ locale, siteId }: { locale: Locale; siteId: string }) {
  const path = { id: siteId };
  const list = useLoad(
    locale,
    () => browserApi().GET('/v1/hosting/sites/{id}/protection', { params: { path } }),
    siteId,
  );
  const a = useToolRun(locale);
  const [domain, setDomain] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  function add(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/hosting/sites/{id}/protection', {
          params: { path, header: { 'Idempotency-Key': key() } },
          body: {
            user: user.trim(),
            password,
            ...(domain || list.data?.domains[0] ? { domain: domain || list.data?.domains[0] } : {}),
          },
        }),
      'ht.prot.added',
      () => {
        setUser('');
        setPassword('');
        void list.reload();
      },
      'ht.prot.invalid',
    );
  }
  const items = list.data?.items ?? [];
  const domains = list.data?.domains ?? [];
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.prot.intro')}</p>
      {list.loading && !list.data && <Loading locale={locale} />}
      {list.error && <Problem text={list.error} />}
      {list.data && (
        <>
          <p>
            <Badge>
              {t(locale, 'ht.prot.limit', { used: items.length, limit: list.data.limit })}
            </Badge>
          </p>
          {items.length === 0 ? (
            <EmptyState title={t(locale, 'ht.prot.empty')} body={t(locale, 'state.empty.body')} />
          ) : (
            <Table
              caption={t(locale, 'ht.prot.title')}
              rows={items}
              rowKey={(r) => `${r.domain}/${r.user}`}
              columns={[
                {
                  key: 'd',
                  header: t(locale, 'ht.prot.domain'),
                  render: (r) => <Ltr>{r.domain}</Ltr>,
                },
                { key: 'u', header: t(locale, 'ht.prot.user'), render: (r) => <Ltr>{r.user}</Ltr> },
                {
                  key: 'a',
                  header: t(locale, 'ht.files.actions'),
                  render: (r) => (
                    <Button
                      variant="danger"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(
                          () =>
                            browserApi().DELETE(
                              '/v1/hosting/sites/{id}/protection/{domain}/{user}',
                              {
                                params: { path: { ...path, domain: r.domain, user: r.user } },
                              },
                            ),
                          'ht.prot.removed',
                          () => void list.reload(),
                        )
                      }
                    >
                      {t(locale, 'ht.prot.remove')}
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <form onSubmit={add} noValidate className="nz-card" aria-label={t(locale, 'ht.prot.add')}>
        <h2 className="nz-h2">{t(locale, 'ht.prot.add')}</h2>
        {domains.length > 1 && (
          <Field id="ht-prot-domain" label={t(locale, 'ht.prot.domain')}>
            {(x) => (
              <Select
                {...x}
                value={domain || domains[0]}
                onChange={(e) => setDomain(e.target.value)}
              >
                {domains.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field id="ht-prot-user" label={t(locale, 'ht.prot.user')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              autoComplete="off"
              maxLength={24}
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          )}
        </Field>
        <Field id="ht-prot-pass" label={t(locale, 'ht.prot.password')}>
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
        <Button type="submit" disabled={a.busy || !user || password.length < 12}>
          {t(locale, 'ht.prot.add')}
        </Button>
        <NoticeText notice={a.notice} />
      </form>
    </>
  );
}

/* ───────────── PHP version ───────────── */
export function PhpSettings({
  locale,
  siteId,
  runtime,
  version,
  versions,
}: {
  locale: Locale;
  siteId: string;
  runtime: string;
  /** the site's version, sent as If-Match */
  version: number;
  versions: string[];
}) {
  const router = useRouter();
  const a = useToolRun(locale);
  const [pick, setPick] = useState(versions.includes(runtime) ? runtime : (versions[0] ?? ''));
  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.php.intro')}</p>
      <p>
        <Badge>{t(locale, 'ht.php.current', { runtime })}</Badge>
      </p>
      {versions.length === 0 ? (
        <EmptyState title={t(locale, 'ht.php.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <form
          className="nz-card"
          aria-label={t(locale, 'ht.php.title')}
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(
              () =>
                browserApi().PATCH('/v1/hosting/sites/{id}', {
                  params: { path: { id: siteId }, header: { 'If-Match': `"${version}"` } },
                  body: { runtime: pick },
                }),
              'ht.php.saved',
              () => router.refresh(),
            );
          }}
        >
          <Field id="ht-php-v" label={t(locale, 'ht.php.choose')}>
            {(x) => (
              <Select {...x} value={pick} onChange={(e) => setPick(e.target.value)}>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={a.busy || pick === runtime}>
            {t(locale, 'ht.php.save')}
          </Button>
          <NoticeText notice={a.notice} />
        </form>
      )}
      <p className="nz-muted">{t(locale, 'ht.php.limits')}</p>
    </>
  );
}
