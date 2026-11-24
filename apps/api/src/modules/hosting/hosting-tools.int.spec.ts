import 'reflect-metadata';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, HostingHarness } from './hosting-harness';
import { HestiaHostingAdapter } from './internal/hestia/adapter';
import { HestiaClient, HttpHestiaChannel } from './internal/hestia/client';
import { startHestiaMock } from './internal/hestia/mock-server';
import { LocalSftpConnector } from './internal/mock/local-sftp';
import { MAIL_DNS, MockMailDns } from './internal/tools/dns';
import { SFTP_CONNECTOR } from './internal/tools/sftp';
import { TOOLS_CONFIG, loadToolsConfig } from './internal/tools/tools-config';
import { HESTIA_CLIENT, HOSTING_ADAPTER } from './internal/tokens';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
/**
 * HestiaCP S05, end to end through the REAL API, the REAL allow-listed client and the REAL services against the MOCK panel (hestia/mock-server.ts), a local SFTP double
 * (a real directory with real symbolic links) and a DNS table. NOT VERIFIED against a real node: nothing here is vendor evidence.
 */
const hh = new HostingHarness();
let mock: Awaited<ReturnType<typeof startHestiaMock>>;
const sftp = new LocalSftpConnector();
const dns = new MockMailDns();
let base = '';
let siteId = '';
let account = '';
let account2 = '';
let nodeId = '';
const SITE_DOMAIN = 'shop.example.com';
const PW = 'correct-horse-9';
const PW2 = 'another-pass-77';
const PW3 = 'new-password-88';
const P = (id: string, rest: string) => `/v1/hosting/sites/${id}${rest}`;
const asA = (
  who: string,
  method: any,
  url: string,
  body?: object,
  extra: Record<string, string> = {},
) => hh.call(who, method, url, body, hh.orgs.A!, extra);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'nuzm-tools-'));
  mock = await startHestiaMock();
  const client = new HestiaClient(
    { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://dev/x' }) },
    { accessKey: async () => mock.controls.hash },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  const adapter = new HestiaHostingAdapter(client, {
    vault: undefined as never,
    evidenceKind: 'mock',
    packageFor: () => 'nuzm-starter',
    capacityOf: async (n) => {
      const i = await hh.compute.describe(n.computeInstanceId);
      return i
        ? { cpuMillicores: i.vcpu * 1000, memoryMb: i.memoryMb, diskMb: i.diskGb * 1024 }
        : null;
    },
  });
  await hh.init({
    overrides: [
      [HOSTING_ADAPTER, adapter],
      [HESTIA_CLIENT, client],
      [SFTP_CONNECTOR, sftp],
      [MAIL_DNS, dns],
      [TOOLS_CONFIG, loadToolsConfig({ HOSTING_TOOLS_MAX_EDIT_BYTES: '2000' })],
    ],
  });
  (adapter as any).o.vault = hh.stack.vault;
  await hh.customers();
  const proj = await hh.project(hh.orgs.A!);
  const projB = await hh.project(hh.orgs.B!);
  const plan = await hh.plan('tools', {
    quotas: {
      cronJobs: 2,
      ftpAccounts: 2,
      protectionUsers: 1,
      mailboxes: 2,
      mailboxQuotaMb: 500,
      mailAliasesPerMailbox: 2,
      uploadMb: 1,
      diskMb: 100,
    },
  });
  nodeId = await hh.activeNode('hestia-t');
  dns.aRecords.set('hestia-t.hosting.example.test', ['203.0.113.10']);
  const mk = async (who: string, org: string, p: string, name: string) => {
    const r = await hh.createSite(who, org, plan, 'php:8.3', name, p);
    expect(r.statusCode).toBe(202);
    await hh.jobs().runOne(org, r.json().operationId);
    const [row] = await hh.env.sql(
      `SELECT node_name, credentials_ref FROM hosting.sites WHERE id = $1`,
      [r.json().site.id],
    );
    const acct = row!.node_name as string;
    // the customer's own domain on the account, and the account's SFTP home (a real directory)
    mock.controls.users.get(acct)!.domains.set(SITE_DOMAIN.replace('shop', name), {
      backend: 'PHP-8_3',
      ssl: false,
      notAfter: null,
      wp: { phase: 'none', placeholders: new Set(), posts: [] },
      ftp: new Map(),
      auth: new Set(),
      accessLog: [],
      errorLog: [],
    });
    const creds = JSON.parse(
      hh.stack.vault.secrets.get(row!.credentials_ref as string)!.toString(),
    );
    const home = join(base, 'home', acct);
    sftp.homes.set(acct, home);
    sftp.passwords.set(acct, creds.password);
    for (const d of mock.controls.users.get(acct)!.domains.keys())
      await mkdir(join(home, 'web', d, 'public_html'), { recursive: true });
    return { id: r.json().site.id as string, acct };
  };
  ({ id: siteId, acct: account } = await mk('alice', hh.orgs.A!, proj, 'alpha'));
  ({ acct: account2 } = await mk('bob', hh.orgs.B!, projB, 'bravo'));
  mock.controls.users
    .get(account)!
    .domains.get('alpha.example.com')!
    .accessLog.push(...Array.from({ length: 30 }, (_, i) => `1.2.3.4 - GET /p${i} 200`));
});
afterAll(async () => {
  await hh.close();
  await mock.close();
  await rm(base, { recursive: true, force: true });
});
const domainA = () => mock.controls.users.get(account)!.domains.get('alpha.example.com')!;
const root = () => join(base, 'home', account, 'web', 'alpha.example.com', 'public_html');

describe('capabilities: per role, plan, panel service and connection state', () => {
  it('the owner sees every tool available with the plan limits; PHP lists the node versions the plan allows', async () => {
    const r = await asA('alice', 'GET', P(siteId, '/tools'));
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.panel).toEqual({ version: '1.9.4', connection: 'connected' });
    const by = Object.fromEntries(b.tools.map((t: any) => [t.id, t]));
    for (const id of ['files', 'cron', 'logs', 'ftp', 'protection', 'php', 'mail']) {
      expect(by[id].state, id).toBe('available');
      expect(by[id].verification).toBe('not_verified');
    }
    expect(by.cron.limits).toEqual({ jobs: 2, minIntervalMinutes: 5 });
    expect(by.mail.limits).toMatchObject({ mailboxes: 2, mailboxQuotaMb: 500 });
    expect(by.files.limits.uploadMb).toBe(1);
    expect(by.php.versions).toEqual(['php:8.2', 'php:8.3']);
  });
  it('a viewer sees every tool as unavailable because of the role', async () => {
    const r = await asA('carol', 'GET', P(siteId, '/tools'));
    expect(r.statusCode).toBe(200);
    expect(r.json().tools.every((t: any) => t.state === 'unavailable' && t.reason === 'role')).toBe(
      true,
    );
  });
  it('a developer manages everything but mailboxes (mail is readable)', async () => {
    const t = (await asA('erin', 'GET', P(siteId, '/tools'))).json().tools;
    expect(t.find((x: any) => x.id === 'mail').state).toBe('available');
    const create = await asA('erin', 'POST', P(siteId, '/mail/mailboxes'), {
      domain: 'alpha.example.com',
      name: 'x',
      password: PW,
    });
    expect(create.statusCode).toBe(403);
  });
  it("another organization's site id is a 404, never a capability report", async () => {
    expect(
      (await hh.call('bob', 'GET', P(siteId, '/tools'), undefined, hh.orgs.B!)).statusCode,
    ).toBe(404);
  });
  it('a node that does not report an FTP service closes FTP (panel_service) and an unhealthy node closes everything (connection)', async () => {
    mock.controls.config.FTP_SYSTEM = '';
    await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeId}/inventory`);
    let t = (await asA('alice', 'GET', P(siteId, '/tools'))).json().tools;
    expect(t.find((x: any) => x.id === 'ftp')).toMatchObject({
      state: 'unavailable',
      reason: 'panel_service',
    });
    expect(t.find((x: any) => x.id === 'cron').state).toBe('available');
    expect((await asA('alice', 'GET', P(siteId, '/ftp-accounts'))).statusCode).toBe(422); // refused by the API too, not only hidden
    mock.controls.config.FTP_SYSTEM = 'vsftpd';
    await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeId}/inventory`);
    await hh.env.sql(`UPDATE hosting.nodes SET health = 'unhealthy' WHERE id = $1`, [nodeId]);
    t = (await asA('alice', 'GET', P(siteId, '/tools'))).json();
    expect(t.panel.connection).toBe('unhealthy');
    expect(t.tools.every((x: any) => x.reason === 'connection')).toBe(true);
    expect((await asA('alice', 'GET', P(siteId, '/cron-jobs'))).statusCode).toBe(503);
    await hh.env.sql(`UPDATE hosting.nodes SET health = 'healthy' WHERE id = $1`, [nodeId]);
  });
});

describe('cron jobs', () => {
  const job = {
    min: '0',
    hour: '2',
    day: '*',
    month: '*',
    wday: '*',
    command: 'php /home/x/cron.php',
  };
  let id = '';
  it('creates a job with the documented command, lists it from the panel, changes and deletes it', async () => {
    const r = await asA('alice', 'POST', P(siteId, '/cron-jobs'), job);
    expect(r.statusCode).toBe(201);
    id = r.json().id;
    expect(mock.controls.users.get(account)!.cron.get(id)).toMatchObject({
      min: '0',
      hour: '2',
      command: 'php /home/x/cron.php',
    });
    expect(mock.controls.commands).toContain('v-add-cron-job');
    const l = (await asA('alice', 'GET', P(siteId, '/cron-jobs'))).json();
    expect(l).toMatchObject({ limit: 2, items: [{ id, command: 'php /home/x/cron.php' }] });
    const u = await asA('alice', 'PUT', P(siteId, `/cron-jobs/${id}`), { ...job, hour: '3' });
    expect(u.statusCode).toBe(200);
    expect(mock.controls.users.get(account)!.cron.get(id)!.hour).toBe('3');
  });
  it('refuses a schedule more frequent than the minimum, an invalid field and a command with a line break', async () => {
    for (const bad of [
      { ...job, min: '*' },
      { ...job, min: '*/2' },
      { ...job, hour: '25' },
      { ...job, command: 'a\nb' },
      { ...job, command: '' },
      { ...job, min: 'x' },
    ]) {
      const r = await asA('alice', 'POST', P(siteId, '/cron-jobs'), bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });
  it('the plan limit holds under concurrency: five parallel creates add exactly one more job', async () => {
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        asA('alice', 'POST', P(siteId, '/cron-jobs'), { ...job, command: `php /home/x/c${i}.php` }),
      ),
    );
    expect(rs.filter((r) => r.statusCode === 201).length).toBe(1);
    expect(rs.filter((r) => r.statusCode === 422).length).toBe(4);
    expect(mock.controls.users.get(account)!.cron.size).toBe(2);
  });
  it('a lost answer after the effect is reconciled (one job, success); a lost request before the effect is a 503 with no job', async () => {
    await asA('alice', 'DELETE', P(siteId, '/cron-jobs/2'));
    mock.controls.inject('v-add-cron-job', 'drop-after');
    const ok = await asA('alice', 'POST', P(siteId, '/cron-jobs'), {
      ...job,
      command: 'php /home/x/lost-answer.php',
    });
    expect(ok.statusCode).toBe(201);
    expect(
      [...mock.controls.users.get(account)!.cron.values()].filter((j) =>
        j.command.includes('lost-answer'),
      ).length,
    ).toBe(1);
    await asA('alice', 'DELETE', P(siteId, `/cron-jobs/${ok.json().id}`));
    mock.controls.inject('v-add-cron-job', 'drop');
    const no = await asA('alice', 'POST', P(siteId, '/cron-jobs'), {
      ...job,
      command: 'php /home/x/never.php',
    });
    expect(no.statusCode).toBe(503);
    expect(
      [...mock.controls.users.get(account)!.cron.values()].some((j) => j.command.includes('never')),
    ).toBe(false);
  });
  it('a lost answer on a delete is read back: the job is gone, so the delete is done (204)', async () => {
    const cron = mock.controls.users.get(account)!.cron;
    const made = await asA('alice', 'POST', P(siteId, '/cron-jobs'), {
      ...job,
      command: 'php /home/x/delete-me.php',
    });
    expect(made.statusCode).toBe(201);
    mock.controls.inject('v-delete-cron-job', 'drop-after');
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/cron-jobs/${made.json().id}`))).statusCode,
    ).toBe(204);
    expect(cron.has(made.json().id)).toBe(false);
    const again = await asA('alice', 'POST', P(siteId, '/cron-jobs'), {
      ...job,
      command: 'php /home/x/keep.php',
    });
    expect(again.statusCode).toBe(201);
    mock.controls.inject('v-delete-cron-job', 'drop'); // lost BEFORE the effect: still there, so an error (503), not "done"
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/cron-jobs/${again.json().id}`))).statusCode,
    ).toBe(503);
    expect(cron.has(again.json().id)).toBe(true);
  });
  it('the same Idempotency-Key replays the first answer and does not add a second job', async () => {
    const cron = mock.controls.users.get(account)!.cron;
    await asA('alice', 'DELETE', P(siteId, '/cron-jobs/' + [...cron.keys()][0]));
    const before = cron.size;
    const h = { 'idempotency-key': 'cron-replay-1' };
    const a = await asA(
      'alice',
      'POST',
      P(siteId, '/cron-jobs'),
      { ...job, command: 'php /home/x/idem.php' },
      h,
    );
    const b = await asA(
      'alice',
      'POST',
      P(siteId, '/cron-jobs'),
      { ...job, command: 'php /home/x/idem.php' },
      h,
    );
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(cron.size).toBe(before + 1);
  });
  it('is org scoped: another organization cannot list, create or delete jobs of this site (404), and a viewer is 403', async () => {
    for (const [m, u, b] of [
      ['GET', '/cron-jobs', undefined],
      ['POST', '/cron-jobs', job],
      ['DELETE', '/cron-jobs/1', undefined],
    ] as const)
      expect((await hh.call('bob', m, P(siteId, u), b as any, hh.orgs.B!)).statusCode, m).toBe(404);
    expect((await asA('carol', 'GET', P(siteId, '/cron-jobs'))).statusCode).toBe(403);
    expect(mock.controls.users.get(account2)!.cron.size).toBe(0);
  });
  it('audits creation without the command', async () => {
    const rows = await hh.env.sql(
      `SELECT * FROM audit.audit_logs WHERE action LIKE 'hosting.cron.%'`,
    );
    expect(rows.length).toBeGreaterThan(2);
    expect(JSON.stringify(rows)).not.toContain('cron.php');
  });
});

describe('logs: a bounded number of lines', () => {
  it('returns the latest N lines, defaults to 100 and refuses a count above the maximum or a bad kind', async () => {
    const r = await asA(
      'alice',
      'GET',
      P(siteId, '/logs?kind=access&lines=5&domain=alpha.example.com'),
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      domain: 'alpha.example.com',
      kind: 'access',
      requested: 5,
      truncated: false,
    });
    expect(r.json().lines).toHaveLength(5);
    expect(r.json().lines.at(-1)).toContain('/p29');
    expect(
      (await asA('alice', 'GET', P(siteId, '/logs?kind=access&domain=alpha.example.com'))).json()
        .lines,
    ).toHaveLength(30);
    for (const q of ['lines=501', 'lines=0', 'lines=abc', 'lines=-1', 'kind=other'])
      expect((await asA('alice', 'GET', P(siteId, `/logs?${q}`))).statusCode, q).toBe(422);
  });
  it("a domain that is not on the site's own account is a 404 (another customer's domain cannot be read)", async () => {
    expect(
      (await asA('alice', 'GET', P(siteId, '/logs?domain=bravo.example.com'))).statusCode,
    ).toBe(404);
  });
  it('a panel that sends more than asked is cut again, and control characters are removed', async () => {
    domainA().errorLog.splice(
      0,
      domainA().errorLog.length,
      ...Array.from({ length: 4 }, (_, i) => `err ${i}\u0007x`),
    );
    const r = (
      await asA('alice', 'GET', P(siteId, '/logs?kind=error&lines=2&domain=alpha.example.com'))
    ).json();
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).not.toContain('\u0007');
  });
  it('is read-only for the viewer role: 403 for carol, 404 across organizations', async () => {
    expect((await asA('carol', 'GET', P(siteId, '/logs'))).statusCode).toBe(403);
    expect(
      (await hh.call('bob', 'GET', P(siteId, '/logs'), undefined, hh.orgs.B!)).statusCode,
    ).toBe(404);
  });
});

describe('FTP accounts', () => {
  let user = '';
  it('creates an account (the panel derives its name), lists it, changes the password and deletes it', async () => {
    const r = await asA('alice', 'POST', P(siteId, '/ftp-accounts'), {
      name: 'deploy',
      password: PW,
      domain: 'alpha.example.com',
      path: '/public_html',
    });
    expect(r.statusCode).toBe(201);
    user = r.json().user;
    expect(user).toBe(`${account}_deploy`);
    expect(domainA().ftp.get(user)).toBe('/public_html');
    expect((await asA('alice', 'GET', P(siteId, '/ftp-accounts'))).json()).toMatchObject({
      limit: 2,
      items: [{ domain: 'alpha.example.com', user }],
    });
    expect(
      (
        await asA('alice', 'PUT', P(siteId, `/ftp-accounts/alpha.example.com/${user}/password`), {
          password: PW2,
        })
      ).statusCode,
    ).toBe(204);
    expect(mock.controls.commands).toContain('v-change-web-domain-ftp-password');
  });
  it('validates name, password and path; enforces the plan limit', async () => {
    for (const b of [
      { name: 'A', password: PW },
      { name: 'okname', password: 'short' },
      { name: 'okname', password: PW, path: '/../etc' },
    ])
      expect(
        (await asA('alice', 'POST', P(siteId, '/ftp-accounts'), b)).statusCode,
        JSON.stringify(b),
      ).toBe(422);
    expect(
      (await asA('alice', 'POST', P(siteId, '/ftp-accounts'), { name: 'second', password: PW }))
        .statusCode,
    ).toBe(201);
    expect(
      (await asA('alice', 'POST', P(siteId, '/ftp-accounts'), { name: 'third', password: PW }))
        .statusCode,
    ).toBe(422);
  });
  it('never stores, audits or returns the password', async () => {
    const everything = JSON.stringify([
      await hh.env.sql(`SELECT * FROM audit.audit_logs`),
      await hh.env.sql(`SELECT * FROM hosting.sites`),
      (await asA('alice', 'GET', P(siteId, '/ftp-accounts'))).body,
    ]);
    for (const pw of [PW, PW2]) expect(everything).not.toContain(pw);
  });
  it('deleting an account that is not on this site is 404; cross-org is 404; a viewer is 403', async () => {
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/ftp-accounts/alpha.example.com/${account2}_x`)))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await hh.call(
          'bob',
          'DELETE',
          P(siteId, `/ftp-accounts/alpha.example.com/${user}`),
          undefined,
          hh.orgs.B!,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await asA('carol', 'DELETE', P(siteId, `/ftp-accounts/alpha.example.com/${user}`)))
        .statusCode,
    ).toBe(403);
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/ftp-accounts/alpha.example.com/${user}`)))
        .statusCode,
    ).toBe(204);
    expect(domainA().ftp.has(user)).toBe(false);
  });
});

describe('password protection', () => {
  it('protects a domain, lists it, enforces the plan limit and removes the user', async () => {
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/protection'), {
          user: 'staging',
          password: PW,
          domain: 'alpha.example.com',
        })
      ).statusCode,
    ).toBe(201);
    expect(domainA().auth.has('staging')).toBe(true);
    expect((await asA('alice', 'GET', P(siteId, '/protection'))).json()).toMatchObject({
      limit: 1,
      items: [{ domain: 'alpha.example.com', user: 'staging' }],
    });
    expect(
      (await asA('alice', 'POST', P(siteId, '/protection'), { user: 'second', password: PW }))
        .statusCode,
    ).toBe(422);
    expect(
      (await asA('alice', 'DELETE', P(siteId, '/protection/alpha.example.com/staging'))).statusCode,
    ).toBe(204);
    expect(domainA().auth.size).toBe(0);
    expect(
      (await asA('alice', 'DELETE', P(siteId, '/protection/alpha.example.com/staging'))).statusCode,
    ).toBe(404);
  });
  it('is org scoped and role gated', async () => {
    expect(
      (await hh.call('bob', 'GET', P(siteId, '/protection'), undefined, hh.orgs.B!)).statusCode,
    ).toBe(404);
    expect(
      (await asA('carol', 'POST', P(siteId, '/protection'), { user: 'x1x', password: PW }))
        .statusCode,
    ).toBe(403);
  });
});

describe('PHP version through the backend template', () => {
  it('changes the version with the existing site update (v-change-web-domain-backend-tpl) and the capability report lists the offered versions', async () => {
    const site = await asA('alice', 'GET', P(siteId, ''));
    const etag = site.headers.etag as string;
    const r = await asA(
      'alice',
      'PATCH',
      P(siteId, ''),
      { runtime: 'php:8.2' },
      { 'if-match': etag },
    );
    expect(r.statusCode).toBe(200);
    expect(r.json().runtime).toBe('php:8.2');
    expect(
      [...mock.controls.users.get(account)!.domains.values()].every((d) => d.backend === 'PHP-8_2'),
    ).toBe(true);
    expect(mock.controls.commands).toContain('v-change-web-domain-backend-tpl');
  });
});

describe('file manager (SFTP as the site account, inside the website folder)', () => {
  const q = (path: string, extra = '') =>
    `?domain=alpha.example.com&path=${encodeURIComponent(path)}${extra}`;
  const put = (who: string, path: string, data: Buffer, extra = '', org = hh.orgs.A!) =>
    hh.app.inject({
      method: 'PUT',
      url: P(siteId, `/files/content${q(path, extra)}`),
      headers: {
        cookie: cookieHeader(hh.jars[who]!),
        'x-csrf-token': hh.jars[who]!.nuzm_csrf ?? '',
        'x-nuzm-org': org,
        'content-type': 'application/octet-stream',
      },
      payload: data,
    });
  beforeAll(async () => {
    await writeFile(join(root(), 'index.php'), '<?php echo 1;');
    await mkdir(join(root(), 'wp-content'), { recursive: true });
    await writeFile(join(root(), 'wp-content', 'a.txt'), 'a');
  });
  it('signs in as the SITE account (never root) and lists the folder, folders first', async () => {
    const r = await asA('alice', 'GET', P(siteId, `/files${q('')}`));
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((e: any) => `${e.type}:${e.name}`)).toEqual([
      'dir:wp-content',
      'file:index.php',
    ]);
    expect(sftp.opened.every((o) => o.username === account)).toBe(true);
    expect(sftp.opened.some((o) => o.username === 'root')).toBe(false);
    expect(sftp.sessions.every((s) => s.closed)).toBe(true);
  });
  it('uploads within the plan limit, refuses a larger file (413) and an existing name without overwrite (409)', async () => {
    expect((await put('alice', 'up.txt', Buffer.from('hello'))).statusCode).toBe(200);
    expect(await readFile(join(root(), 'up.txt'), 'utf8')).toBe('hello');
    expect((await put('alice', 'up.txt', Buffer.from('again'))).statusCode).toBe(409);
    expect((await put('alice', 'up.txt', Buffer.from('again'), '&overwrite=true')).statusCode).toBe(
      200,
    );
    expect(await readFile(join(root(), 'up.txt'), 'utf8')).toBe('again');
    const big = await put('alice', 'big.bin', Buffer.alloc(1024 * 1024 + 1));
    expect(big.statusCode).toBe(413);
    await expect(readFile(join(root(), 'big.bin'))).rejects.toThrow();
    expect(await readFile(join(root(), 'wp-content', 'a.txt'), 'utf8')).toBe('a');
    const leftovers = (
      await hh.app.inject({
        method: 'GET',
        url: P(siteId, `/files${q('')}`),
        headers: { cookie: cookieHeader(hh.jars.alice!), 'x-nuzm-org': hh.orgs.A! },
      })
    )
      .json()
      .items.filter((e: any) => e.name.startsWith('.nuzm-upload'));
    expect(leftovers).toEqual([]);
  });
  it('downloads the bytes as an attachment and opens a text file with its hash; an edit needs the hash it opened', async () => {
    const d = await asA('alice', 'GET', P(siteId, `/files/download${q('index.php')}`));
    expect(d.statusCode).toBe(200);
    expect(d.rawPayload.toString()).toBe('<?php echo 1;');
    expect(d.headers['content-disposition']).toContain('attachment');
    const t = (await asA('alice', 'GET', P(siteId, `/files/text${q('index.php')}`))).json();
    expect(t.content).toBe('<?php echo 1;');
    const bad = await asA('alice', 'PUT', P(siteId, `/files/text${q('index.php')}`), {
      content: 'x',
      expectedSha256: 'f'.repeat(64),
    });
    expect(bad.statusCode).toBe(409);
    const ok = await asA('alice', 'PUT', P(siteId, `/files/text${q('index.php')}`), {
      content: '<?php echo 2;',
      expectedSha256: t.sha256,
    });
    expect(ok.statusCode).toBe(200);
    expect(await readFile(join(root(), 'index.php'), 'utf8')).toBe('<?php echo 2;');
    await writeFile(join(root(), 'bin.dat'), Buffer.from([0, 1, 2]));
    expect((await asA('alice', 'GET', P(siteId, `/files/text${q('bin.dat')}`))).statusCode).toBe(
      422,
    );
    await writeFile(join(root(), 'long.txt'), 'x'.repeat(2500));
    expect((await asA('alice', 'GET', P(siteId, `/files/text${q('long.txt')}`))).statusCode).toBe(
      413,
    );
  });
  it('creates folders, renames and deletes (a folder only with recursive=true)', async () => {
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/folders'), {
          domain: 'alpha.example.com',
          path: 'assets',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/folders'), {
          domain: 'alpha.example.com',
          path: 'assets',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/renames'), {
          domain: 'alpha.example.com',
          from: 'up.txt',
          to: 'assets/up.txt',
        })
      ).statusCode,
    ).toBe(200);
    expect(await readFile(join(root(), 'assets', 'up.txt'), 'utf8')).toBe('again');
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/renames'), {
          domain: 'alpha.example.com',
          from: 'assets',
          to: 'assets/inner',
        })
      ).statusCode,
    ).toBe(422);
    expect((await asA('alice', 'DELETE', P(siteId, `/files${q('assets')}`))).statusCode).toBe(409);
    const del = await asA('alice', 'DELETE', P(siteId, `/files${q('assets', '&recursive=true')}`));
    expect(del.statusCode).toBe(200);
    expect(del.json().removed).toBe(2);
    expect((await asA('alice', 'DELETE', P(siteId, `/files${q('')}`))).statusCode).toBe(422); // the website folder itself
  });
  it('REFUSES every path that leaves the website folder: .., absolute paths, controls', async () => {
    const outside = join(base, 'home', account, 'web', 'alpha.example.com', 'outside.txt');
    await writeFile(outside, 'not public_html');
    for (const p of ['../outside.txt', '..', 'a/../../outside.txt', 'a\\b', 'a\u0000b']) {
      const r = await asA('alice', 'GET', P(siteId, `/files/download${q(p)}`));
      expect(r.statusCode, p).toBe(422);
      expect(r.body).not.toContain('not public_html');
    }
    // an absolute path is read as relative to the website folder: it cannot name /etc/passwd
    const abs = await asA('alice', 'GET', P(siteId, `/files/download${q('/etc/passwd')}`));
    expect(abs.statusCode).toBe(404);
    expect((await put('alice', '../escaped.txt', Buffer.from('x'))).statusCode).toBe(422);
    await expect(readFile(join(root(), '..', 'escaped.txt'))).rejects.toThrow();
  });
  it('REFUSES symbolic links: a link to another account is never read, written through or listed into; deleting it removes only the link', async () => {
    const other = join(base, 'home', account2);
    await writeFile(join(other, 'secret.txt'), 'BRAVO-SECRET');
    await symlink(other, join(root(), 'peek'));
    await symlink(join(other, 'secret.txt'), join(root(), 'secret-link'));
    const list = (await asA('alice', 'GET', P(siteId, `/files${q('')}`))).json().items;
    expect(list.find((e: any) => e.name === 'peek').type).toBe('symlink');
    for (const p of ['peek', 'peek/secret.txt', 'secret-link']) {
      for (const url of [`/files${q(p)}`, `/files/download${q(p)}`, `/files/text${q(p)}`]) {
        const r = await asA('alice', 'GET', P(siteId, url));
        expect(r.statusCode, url).toBe(422);
        expect(r.body).not.toContain('BRAVO-SECRET');
      }
    }
    expect((await put('alice', 'peek/planted.txt', Buffer.from('x'))).statusCode).toBe(422);
    expect(
      (await put('alice', 'secret-link', Buffer.from('x'), '&overwrite=true')).statusCode,
    ).toBe(422);
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/renames'), {
          domain: 'alpha.example.com',
          from: 'index.php',
          to: 'peek/index.php',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await asA('alice', 'POST', P(siteId, '/files/folders'), {
          domain: 'alpha.example.com',
          path: 'peek/newdir',
        })
      ).statusCode,
    ).toBe(422);
    await expect(readFile(join(other, 'planted.txt'))).rejects.toThrow();
    expect(await readFile(join(other, 'secret.txt'), 'utf8')).toBe('BRAVO-SECRET');
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/files${q('peek/secret.txt')}`))).statusCode,
    ).toBe(422);
    expect(
      (await asA('alice', 'DELETE', P(siteId, `/files${q('peek', '&recursive=true')}`))).statusCode,
    ).toBe(200);
    expect(await readFile(join(other, 'secret.txt'), 'utf8')).toBe('BRAVO-SECRET'); // the target of the link is untouched
    await rm(join(root(), 'secret-link'));
  });
  it('is org scoped and role gated: another organization gets 404 and no session is opened; a viewer gets 403; a developer can write', async () => {
    const opened = sftp.opened.length;
    expect(
      (await hh.call('bob', 'GET', P(siteId, `/files${q('')}`), undefined, hh.orgs.B!)).statusCode,
    ).toBe(404);
    expect((await asA('carol', 'GET', P(siteId, `/files${q('')}`))).statusCode).toBe(403);
    expect((await asA('carol', 'DELETE', P(siteId, `/files${q('index.php')}`))).statusCode).toBe(
      403,
    );
    expect(sftp.opened.length).toBe(opened);
    expect((await put('erin', 'dev.txt', Buffer.from('d'))).statusCode).toBe(200);
  });
  it('audits every mutation with the path and size, never the content', async () => {
    const rows = JSON.stringify(
      await hh.env.sql(`SELECT * FROM audit.audit_logs WHERE action LIKE 'hosting.files.%'`),
    );
    for (const a of ['uploaded', 'edited', 'folder_created', 'renamed', 'deleted'])
      expect(rows).toContain(`hosting.files.${a}`);
    expect(rows).not.toContain('<?php echo');
    expect(rows).not.toContain('BRAVO-SECRET');
  });
  it('a wrong site password at the node is a plain "not available" (503), never the secret', async () => {
    const good = sftp.passwords.get(account)!;
    sftp.passwords.set(account, 'changed-on-the-node');
    const r = await asA('alice', 'GET', P(siteId, `/files${q('')}`));
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain(good);
    sftp.passwords.set(account, good);
  });
});

describe('business email within the plan quota', () => {
  const M = (rest: string) => P(siteId, `/mail${rest}`);
  it('lists the domains that can host mail (not the platform placeholder) and enables one without touching DNS', async () => {
    const o = (await asA('alice', 'GET', M(''))).json();
    expect(o.domains).toEqual([{ domain: 'alpha.example.com', enabled: false }]);
    expect(o.limits).toMatchObject({ mailboxes: 2, mailboxQuotaMb: 500 });
    const placeholder = (
      await asA('alice', 'POST', M('/domains'), { domain: `hestia-site.sites.nuzm.invalid` })
    ).statusCode;
    expect(placeholder).toBe(404);
    const r = await asA('alice', 'POST', M('/domains'), { domain: 'alpha.example.com' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ created: true, webmail: true });
    expect(
      (await asA('alice', 'POST', M('/domains'), { domain: 'alpha.example.com' })).json().created,
    ).toBe(false);
    expect(mock.controls.commands.filter((c) => c === 'v-add-mail-domain')).toHaveLength(2);
  });
  it('creates mailboxes (password never kept), enforces the plan count under concurrency, the quota ceiling and name rules', async () => {
    const mk = (name: string, extra: object = {}) =>
      asA('alice', 'POST', M('/mailboxes'), {
        domain: 'alpha.example.com',
        name,
        password: PW,
        ...extra,
      });
    const rs = await Promise.all(['info', 'sales', 'support', 'billing'].map((n) => mk(n)));
    expect(rs.filter((r) => r.statusCode === 201).length).toBe(2);
    expect(rs.filter((r) => r.statusCode === 422).length).toBe(2);
    const made = rs.filter((r) => r.statusCode === 201).map((r) => r.json());
    expect(made[0].quotaMb).toBe(500); // the plan's quota when none is asked
    expect(
      [...mock.controls.users.get(account)!.mail.get('alpha.example.com')!.accounts.keys()].sort(),
    ).toEqual(made.map((m: any) => m.name).sort());
    expect((await mk('x-big', { quotaMb: 501 })).statusCode).toBe(422);
    expect((await mk('Bad Name')).statusCode).toBe(422);
    expect(
      (
        await asA('alice', 'POST', M('/mailboxes'), {
          domain: 'alpha.example.com',
          name: 'weak',
          password: 'short',
        })
      ).statusCode,
    ).toBe(422);
  });
  it('lists mailboxes with quota and aliases; changes password, quota and aliases within the limits', async () => {
    const o = (await asA('alice', 'GET', M(''))).json();
    expect(o.used).toBe(2);
    const b = o.mailboxes[0];
    const at = `/mailboxes/${b.domain}/${b.name}`;
    expect((await asA('alice', 'PUT', M(`${at}/password`), { password: PW3 })).statusCode).toBe(
      204,
    );
    expect(
      mock.controls.users.get(account)!.mail.get(b.domain)!.accounts.get(b.name)!.password,
    ).toBe(PW3);
    expect((await asA('alice', 'PUT', M(`${at}/quota`), { quotaMb: 100 })).json().quotaMb).toBe(
      100,
    );
    expect((await asA('alice', 'PUT', M(`${at}/quota`), { quotaMb: 9999 })).statusCode).toBe(422);
    expect((await asA('alice', 'POST', M(`${at}/aliases`), { alias: 'one' })).statusCode).toBe(201);
    expect((await asA('alice', 'POST', M(`${at}/aliases`), { alias: 'two' })).statusCode).toBe(201);
    expect((await asA('alice', 'POST', M(`${at}/aliases`), { alias: 'three' })).statusCode).toBe(
      422,
    );
    expect((await asA('alice', 'DELETE', M(`${at}/aliases/two`))).statusCode).toBe(204);
    expect(
      (await asA('alice', 'GET', M(''))).json().mailboxes.find((m: any) => m.name === b.name)
        .aliases,
    ).toEqual(['one']);
    const audit = JSON.stringify(
      await hh.env.sql(`SELECT * FROM audit.audit_logs WHERE action LIKE 'hosting.mail.%'`),
    );
    const everything = JSON.stringify([
      audit,
      await hh.env.sql(`SELECT * FROM hosting.sites`),
      (await asA('alice', 'GET', M(''))).body,
    ]);
    for (const pw of [PW, PW3]) expect(everything).not.toContain(pw);
    expect(audit).toContain('hosting.mail.mailbox_created');
    expect(audit).not.toContain(`${b.name}@alpha.example.com`); // audit holds a short reference, not the address
  });
  it('shows the webmail link and the IMAP/SMTP settings', async () => {
    const s = (await asA('alice', 'GET', M(''))).json().settings[0];
    expect(s).toMatchObject({
      domain: 'alpha.example.com',
      webmailUrl: 'https://webmail.alpha.example.com/',
      imap: { host: 'mail.alpha.example.com', ssl: 993 },
      smtp: { host: 'mail.alpha.example.com', ssl: 465, startTls: 587 },
      verification: 'not_verified',
    });
  });
  it('DNS checks only READ: external mail records are reported as external and kept; moving to Nuzm turns them ok', async () => {
    // before: the customer has mail somewhere else
    dns.mxRecords.set('alpha.example.com', [{ exchange: 'aspmx.l.google.com', priority: 1 }]);
    dns.txtRecords.set('alpha.example.com', ['v=spf1 include:_spf.google.com ~all']);
    const ext = (await asA('alice', 'GET', M('/dns-checks?domain=alpha.example.com'))).json();
    const st = (id: string) => ext.checks.find((c: any) => c.id === id).state;
    expect(ext.mailHostingMoved).toBe(false);
    expect(st('mx')).toBe('external');
    expect(st('spf')).toBe('external');
    expect(st('dmarc')).toBe('missing');
    expect(st('mail_host')).toBe('missing');
    expect(ext.serverIp).toBe('203.0.113.10');
    expect(dns.mxRecords.get('alpha.example.com')).toEqual([
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ]); // untouched
    // after: the customer publishes the records shown
    dns.mxRecords.set('alpha.example.com', [{ exchange: 'mail.alpha.example.com', priority: 10 }]);
    dns.txtRecords.set('alpha.example.com', ['v=spf1 a mx ip4:203.0.113.10 ~all']);
    dns.txtRecords.set('_dmarc.alpha.example.com', ['v=DMARC1; p=quarantine;']);
    const key = ext.checks.find((c: any) => c.id === 'dkim').expected.value.match(/p=(\S+)/)[1];
    dns.txtRecords.set('mail._domainkey.alpha.example.com', [`v=DKIM1; k=rsa; p=${key}`]);
    dns.aRecords.set('mail.alpha.example.com', ['203.0.113.10']);
    dns.aRecords.set('webmail.alpha.example.com', ['203.0.113.10']);
    dns.ptrRecords.set('203.0.113.10', ['mail.alpha.example.com']);
    const ok = (await asA('alice', 'GET', M('/dns-checks?domain=alpha.example.com'))).json();
    expect(ok.mailHostingMoved).toBe(true);
    expect(ok.checks.map((c: any) => [c.id, c.state])).toEqual([
      ['mx', 'ok'],
      ['mail_host', 'ok'],
      ['webmail_host', 'ok'],
      ['spf', 'ok'],
      ['dkim', 'ok'],
      ['dmarc', 'ok'],
      ['ptr', 'ok'],
    ]);
    dns.ptrRecords.set('203.0.113.10', ['unrelated.example.net']); // a reverse name that does not resolve back
    expect(
      (await asA('alice', 'GET', M('/dns-checks?domain=alpha.example.com')))
        .json()
        .checks.find((c: any) => c.id === 'ptr').state,
    ).toBe('mismatch');
  });
  it('deletes a mailbox; is org scoped (404) and role gated (viewer cannot read mail: 403; developer cannot manage: 403)', async () => {
    expect((await hh.call('bob', 'GET', M(''), undefined, hh.orgs.B!)).statusCode).toBe(404);
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          M('/mailboxes'),
          { domain: 'alpha.example.com', name: 'evil', password: PW },
          hh.orgs.B!,
        )
      ).statusCode,
    ).toBe(404);
    expect((await asA('carol', 'GET', M(''))).statusCode).toBe(403);
    expect((await asA('erin', 'DELETE', M('/mailboxes/alpha.example.com/info'))).statusCode).toBe(
      403,
    );
    const o = (await asA('alice', 'GET', M(''))).json();
    const b = o.mailboxes[0];
    expect((await asA('alice', 'DELETE', M(`/mailboxes/${b.domain}/${b.name}`))).statusCode).toBe(
      204,
    );
    expect((await asA('alice', 'DELETE', M(`/mailboxes/${b.domain}/${b.name}`))).statusCode).toBe(
      404,
    );
    expect((await asA('alice', 'GET', M(''))).json().used).toBe(1);
  });
  it('a plan without mailboxes sells no mail: the capability says plan and every mail call is refused', async () => {
    const [{ id: p2 }] = await hh.env.sql(
      `SELECT id FROM hosting.plan_definitions WHERE key = 'tools'`,
    );
    await hh.env.sql(
      `UPDATE hosting.plan_definitions SET quotas = quotas - 'mailboxes' WHERE id = $1`,
      [p2],
    );
    const t = (await asA('alice', 'GET', P(siteId, '/tools')))
      .json()
      .tools.find((x: any) => x.id === 'mail');
    expect(t).toMatchObject({ state: 'unavailable', reason: 'plan' });
    expect((await asA('alice', 'GET', M(''))).statusCode).toBe(422);
    expect(
      (
        await asA('alice', 'POST', M('/mailboxes'), {
          domain: 'alpha.example.com',
          name: 'late',
          password: PW,
        })
      ).statusCode,
    ).toBe(422);
    await hh.env.sql(
      `UPDATE hosting.plan_definitions SET quotas = quotas || '{"mailboxes":2}'::jsonb WHERE id = $1`,
      [p2],
    );
  });
  it('the DNS port has no way to write a record (read-only by construction)', () => {
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(dns)).filter((m) =>
        /add|set|put|create|update|delete/i.test(m),
      ),
    ).toEqual([]);
  });
});

describe('the tools never run a command outside the allow-list', () => {
  it('every command the panel received in this suite is a documented v-* command of the allow-list', async () => {
    const { HESTIA_COMMANDS } = await import('./internal/hestia/commands');
    const allowed = new Set(Object.values(HESTIA_COMMANDS).map((d) => d.cmd));
    for (const c of new Set(mock.controls.commands)) expect(allowed.has(c), c).toBe(true);
  });
});
