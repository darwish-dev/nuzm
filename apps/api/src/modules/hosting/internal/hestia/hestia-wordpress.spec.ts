import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryVault } from '../mock/mocks';
import { HestiaHostingAdapter } from './adapter';
import { HestiaClient, HttpHestiaChannel } from './client';
import { HESTIA_COMMANDS, buildArgs } from './commands';
import { startHestiaMock } from './mock-server';
import { HttpSiteProbe } from './site-probe';
import { HestiaWordPress } from './wordpress';

const NODE = { nodeId: '00000000-0000-7000-8000-0000000000aa', computeInstanceId: 'i-1' };
const NAME = 's-cccc11112222dddd';
const DOMAIN = 'blog.example.com';
const ctx = {
  providerAccountId: 'p',
  credentialRef: 'vault://hosting/x',
  traceId: 't',
  deadlineMs: 2000,
};
const LIMITS = { diskMb: 100, inodes: 5000, maxProcesses: 20, memoryMb: 256, bandwidthGbMonth: 10 };
const SITE = { name: NAME, domain: DOMAIN, runtime: 'php:8.3' };
const DB = { name: 'wpa1b2c3', user: 'wpa1b2c3', password: randomBytes(18).toString('hex') };
const PW = 'AdminPassw0rdAdminPassw0rd1234';

let mock: Awaited<ReturnType<typeof startHestiaMock>>;
let wp: HestiaWordPress;
beforeAll(async () => {
  mock = await startHestiaMock();
});
afterAll(() => mock.close());
beforeEach(async () => {
  mock.controls.users.clear();
  mock.controls.wpCalls.length = 0;
  mock.controls.commands.length = 0;
  const client = new HestiaClient(
    { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://x' }) },
    { accessKey: async () => mock.controls.hash },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  const adapter = new HestiaHostingAdapter(client, {
    vault: new MemoryVault(),
    evidenceKind: 'mock',
    packageFor: () => 'nuzm-starter',
  });
  wp = new HestiaWordPress(client, { evidenceKind: 'mock' });
  await adapter.createSite(ctx, NODE, {
    name: NAME,
    runtime: 'php:8.3',
    domain: DOMAIN,
    limits: LIMITS,
    credentialsRef: 'vault://c',
    backupKeyRef: 'vault://b',
    idempotencyToken: 'a'.repeat(64),
    operationId: 'o',
  });
});
const phase = () => mock.controls.siteState(DOMAIN).phase;

describe('the WordPress steps on a node', () => {
  it('install sequence: wp-cli → database → docroot → download → config → install, each a documented command, as the site user', async () => {
    expect((await wp.ensureWpCli(ctx, NODE, SITE)).status).toBe('succeeded');
    const db = await wp.ensureDatabase(ctx, NODE, SITE, DB);
    expect(db.data).toEqual({ dbName: `${NAME}_wpa1b2c3`, dbUser: `${NAME}_wpa1b2c3` });
    expect((await wp.prepareDocroot(ctx, NODE, SITE)).status).toBe('succeeded');
    expect(phase()).toBe('none');
    expect((await wp.download(ctx, NODE, SITE, 'en_US')).status).toBe('succeeded');
    expect(phase()).toBe('unconfigured');
    const cfg = await wp.configure(ctx, NODE, SITE, {
      ...db.data!,
      dbPassword: DB.password,
      prefix: 'wp_ab12x_',
      locale: 'en_US',
    });
    expect(cfg.status).toBe('succeeded');
    expect(phase()).toBe('uninstalled');
    const inst = await wp.install(ctx, NODE, SITE, {
      title: DOMAIN,
      adminUser: 'nzabc123',
      adminPassword: PW,
      adminEmail: `wp-admin@${DOMAIN}`,
    });
    expect(inst.status).toBe('succeeded');
    expect(mock.controls.siteState(DOMAIN)).toEqual({
      answers: true,
      phase: 'installed',
      adminPage: true,
    });
    expect(mock.controls.commands).toEqual(
      expect.arrayContaining([
        'v-add-user-wp-cli',
        'v-list-databases',
        'v-add-database',
        'v-delete-fs-file',
        'v-run-cli-cmd',
      ]),
    );
    expect(mock.controls.wpCalls).toEqual(['core download', 'config create', 'core install']);
  });

  it('the database step is idempotent: an existing database is not created twice and the same full names come back', async () => {
    await wp.ensureWpCli(ctx, NODE, SITE);
    await wp.ensureDatabase(ctx, NODE, SITE, DB);
    const again = await wp.ensureDatabase(ctx, NODE, SITE, DB);
    expect(again.data?.dbName).toBe(`${NAME}_wpa1b2c3`);
    expect(mock.controls.commands.filter((c) => c === 'v-add-database')).toHaveLength(1);
  });

  it('WP-CLI itself refuses to download, configure or install over an existing site: a retry cannot destroy content', async () => {
    await wp.ensureWpCli(ctx, NODE, SITE);
    const db = (await wp.ensureDatabase(ctx, NODE, SITE, DB)).data!;
    await wp.download(ctx, NODE, SITE, 'en_US');
    await wp.configure(ctx, NODE, SITE, {
      ...db,
      dbPassword: DB.password,
      prefix: 'wp_ab12x_',
      locale: 'en_US',
    });
    await wp.install(ctx, NODE, SITE, {
      title: DOMAIN,
      adminUser: 'nzabc123',
      adminPassword: PW,
      adminEmail: `wp-admin@${DOMAIN}`,
    });
    mock.controls.domainOf(DOMAIN)!.wp.posts.push('my first real post');
    for (const r of [
      await wp.download(ctx, NODE, SITE, 'en_US'),
      await wp.configure(ctx, NODE, SITE, {
        ...db,
        dbPassword: DB.password,
        prefix: 'wp_zzzzz_',
        locale: 'en_US',
      }),
      await wp.install(ctx, NODE, SITE, {
        title: DOMAIN,
        adminUser: 'other',
        adminPassword: PW,
        adminEmail: `x@${DOMAIN}`,
      }),
    ])
      expect(r.status).toBe('failed');
    expect(mock.controls.domainOf(DOMAIN)!.wp.posts).toEqual([
      'Hello world!',
      'my first real post',
    ]);
    expect(mock.controls.domainOf(DOMAIN)!.wp.adminUser).toBe('nzabc123');
  });

  it('configure with a wrong database password fails and leaves the site unconfigured', async () => {
    await wp.ensureWpCli(ctx, NODE, SITE);
    const db = (await wp.ensureDatabase(ctx, NODE, SITE, DB)).data!;
    await wp.download(ctx, NODE, SITE, 'en_US');
    const r = await wp.configure(ctx, NODE, SITE, {
      ...db,
      dbPassword: 'WrongPassw0rdWrongPassw0rd1234',
      prefix: 'wp_ab12x_',
      locale: 'en_US',
    });
    expect(r.status).toBe('failed');
    expect(phase()).toBe('unconfigured');
  });

  it('an unsupported runtime or a missing WP-CLI is refused before anything is run', async () => {
    expect(
      (await wp.download(ctx, NODE, { ...SITE, runtime: 'static' }, 'en_US')).error?.category,
    ).toBe('unsupported');
    // WP-CLI not installed for the user: the panel says E_NOTEXIST
    const r = await wp.download(ctx, NODE, SITE, 'en_US');
    expect(r.status).toBe('failed');
  });

  it('a lost answer to `core install` is `uncertain` (the effect happened): the caller must look at the site', async () => {
    await wp.ensureWpCli(ctx, NODE, SITE);
    const db = (await wp.ensureDatabase(ctx, NODE, SITE, DB)).data!;
    await wp.download(ctx, NODE, SITE, 'en_US');
    await wp.configure(ctx, NODE, SITE, {
      ...db,
      dbPassword: DB.password,
      prefix: 'wp_ab12x_',
      locale: 'en_US',
    });
    mock.controls.dropWpAnswer('core install');
    const r = await wp.install(ctx, NODE, SITE, {
      title: DOMAIN,
      adminUser: 'nzabc123',
      adminPassword: PW,
      adminEmail: `wp-admin@${DOMAIN}`,
    });
    expect(r.status).toBe('uncertain');
    expect(phase()).toBe('installed');
  });

  it('resets the admin password only on an installed site', async () => {
    await wp.ensureWpCli(ctx, NODE, SITE);
    expect(
      (await wp.resetAdminPassword(ctx, NODE, SITE, { adminUser: 'nzabc123', password: PW }))
        .status,
    ).toBe('failed');
  });
});

describe('the allow-list for WP-CLI and files', () => {
  const U = 's-cccc11112222dddd';
  const php = '/usr/bin/php8.3';
  const wpbin = `/home/${U}/.wp-cli/wp`;
  it("accepts the plain arguments the install uses and refuses anything with shell syntax, a space, or another user's WP-CLI", () => {
    const ok = {
      user: U,
      php,
      wp: wpbin,
      w1: 'core',
      w2: 'install',
      w3: '--title=blog.example.com',
    };
    expect(buildArgs(HESTIA_COMMANDS.runWpCli, ok)).toHaveLength(6);
    for (const bad of [
      { ...ok, w3: '--title=My Blog' },
      { ...ok, w3: '$(id)' },
      { ...ok, w3: 'a;b' },
      { ...ok, w3: 'a|b' },
      { ...ok, w3: "a'b" },
      { ...ok, w3: 'a`b`' },
      { ...ok, php: '/bin/sh' },
      { ...ok, php: '/usr/bin/php8.3 -r' },
      { ...ok, wp: '/usr/bin/wp' },
      { ...ok, wp: `/home/${U}/../root/.wp-cli/wp` },
    ])
      expect(() => buildArgs(HESTIA_COMMANDS.runWpCli, bad)).toThrow();
  });
  it('deletes only the two placeholder files of a docroot', () => {
    const f = (x: string) => buildArgs(HESTIA_COMMANDS.deleteFsFile, { user: U, file: x });
    expect(f(`/home/${U}/web/blog.example.com/public_html/index.html`)).toHaveLength(2);
    expect(f(`/home/${U}/web/blog.example.com/public_html/robots.txt`)).toHaveLength(2);
    for (const bad of [
      `/home/${U}/web/blog.example.com/public_html/wp-config.php`,
      `/home/${U}/web/blog.example.com/public_html/../../../etc/passwd`,
      `/home/${U}/web/blog.example.com/public_html/index.html/../x`,
      `/etc/passwd`,
      `/home/${U}/web/blog.example.com/private/index.html`,
    ])
      expect(() => f(bad)).toThrow();
  });
  it('backup commands take only a well-formed archive name of the account', () => {
    expect(
      buildArgs(HESTIA_COMMANDS.deleteUserBackup, {
        user: U,
        backup: `${U}.2026-11-24_03-00-00.tar`,
      }),
    ).toHaveLength(2);
    for (const bad of [
      '../etc/passwd',
      `${U}.2026-11-24_03-00-00.tar.gz`,
      'x.tar',
      `${U}.2026-11-24_03-00-00.tar; rm`,
    ])
      expect(() => buildArgs(HESTIA_COMMANDS.deleteUserBackup, { user: U, backup: bad })).toThrow();
  });
});

/** A node's web side as WordPress shows it. */
describe('HttpSiteProbe', () => {
  let srv: Server;
  let port = 0;
  let mode: 'default' | 'unconfigured' | 'uninstalled' | 'installed' | 'https-redirect' = 'default';
  const hosts: string[] = [];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      hosts.push(String(req.headers.host));
      const url = req.url ?? '/';
      if (mode === 'https-redirect') {
        res.writeHead(301, { location: `https://${req.headers.host}${url}` }).end();
        return;
      }
      if (mode === 'unconfigured')
        return void res
          .writeHead(302, { location: 'http://blog.example.com/wp-admin/setup-config.php' })
          .end();
      if (mode === 'uninstalled')
        return void res
          .writeHead(302, { location: 'http://blog.example.com/wp-admin/install.php' })
          .end();
      if (mode === 'installed' && url.startsWith('/wp-login.php'))
        return void res
          .writeHead(200)
          .end('<form><input type="submit" name="wp-submit" id="wp-submit"></form>');
      if (mode === 'installed') return void res.writeHead(200).end('<html>blog</html>');
      res.writeHead(200).end('<html>Welcome to Hestia default page</html>');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));
  const probe = () =>
    new HttpSiteProbe({
      hostOf: async () => '127.0.0.1',
      httpPort: port,
      httpsPort: 1,
      timeoutMs: 1500,
    });

  it.each([
    ['default', 'none', false],
    ['unconfigured', 'unconfigured', false],
    ['uninstalled', 'uninstalled', false],
    ['installed', 'installed', true],
  ] as const)('reads the %s state as %s', async (m, ph, admin) => {
    mode = m;
    expect(await probe().observe(NODE.nodeId, DOMAIN)).toMatchObject({
      answers: true,
      phase: ph,
      adminPage: admin,
    });
    expect(hosts.at(-1)).toBe(DOMAIN); // the site's own name is the Host header: DNS need not point at the node yet
  });
  it('a node that does not answer is `answers: false`, never a guess', async () => {
    const dead = new HttpSiteProbe({
      hostOf: async () => '127.0.0.1',
      httpPort: 1,
      timeoutMs: 500,
    });
    expect(await dead.observe(NODE.nodeId, DOMAIN)).toMatchObject({
      answers: false,
      phase: 'none',
    });
    const none = new HttpSiteProbe({ hostOf: async () => null });
    expect((await none.observe(NODE.nodeId, DOMAIN)).answers).toBe(false);
  });
});
