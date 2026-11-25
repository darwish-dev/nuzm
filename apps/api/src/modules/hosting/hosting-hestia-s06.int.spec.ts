import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../../common/tokens';
import { HostingHarness } from './hosting-harness';
import { HestiaHostingAdapter } from './internal/hestia/adapter';
import { HestiaClient, HttpHestiaChannel } from './internal/hestia/client';
import { startHestiaMock } from './internal/hestia/mock-server';
import { HestiaWordPress } from './internal/hestia/wordpress';
import { BackupService } from './internal/backups.service';
import { MemoryBackupSink, MemoryVault } from './internal/mock/mocks';
import { MonitorService } from './internal/monitor.service';
import {
  SITE_PROBE,
  VAULT_PORT,
  WORDPRESS_PORT,
  BACKUP_SINK,
  type SiteObservation,
} from './internal/ports';
import { HOSTING_ADAPTER } from './internal/tokens';
import { WordPressService } from './internal/wordpress.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
/**
 * HestiaCP S06 + WordPress (ADR-068): the real adapter, WordPress service, backup service, restore drills and monitor against LOCAL MOCK PANELS (NOT VERIFIED against a real node).
 * Everything platform-side (capacity, operations, RLS, audit, idempotency, the HTTP API) is the production code.
 */
const hh = new HostingHarness();
let main: Awaited<ReturnType<typeof startHestiaMock>>;
let drill: Awaited<ReturnType<typeof startHestiaMock>>;
const sink = new MemoryBackupSink();
const vault = new MemoryVault();
let nodeId = '';
let drillNodeId = '';
let euDrillNodeId = '';
let planShared = '';
let planWp = '';
let proj = '';
const REGION = 'sa-central';
const sql = (q: string, p?: unknown[]) => hh.env.sql(q, p) as Promise<any[]>;
const panelOf = (id: string) => (id === drillNodeId ? drill : main);
const run = (orgId: string, id: string) => hh.jobs().runOne(orgId, id);
/** a retry is due only after its backoff: make it due now (the tests do not sleep) */
const again = async (orgId: string, id: string) => {
  await sql(
    `UPDATE platform.operations SET next_run_at = now() WHERE id = $1 AND state = 'pending'`,
    [id],
  );
  return run(orgId, id);
};
const opRow = async (id: string) =>
  (await sql(`SELECT * FROM platform.operations WHERE id = $1`, [id]))[0]!;
const siteRow = async (id: string) =>
  (await sql(`SELECT * FROM hosting.sites WHERE id = $1`, [id]))[0]!;
const appRow = async (siteId: string) =>
  (await sql(`SELECT * FROM hosting.site_apps WHERE site_id = $1`, [siteId]))[0];
const wpOp = async (siteId: string) =>
  (
    await sql(
      `SELECT id, org_id FROM platform.operations WHERE kind = 'hosting.wordpress.install' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [siteId],
    )
  )[0]!;

async function newSite(
  planId: string,
  runtime: string,
  name: string,
  who = 'alice',
  org = hh.orgs.A!,
) {
  const r = await hh.createSite(who, org, planId, runtime, name, proj);
  expect(r.statusCode).toBe(202);
  await run(org, r.json().operationId);
  return { siteId: r.json().site.id as string, opId: r.json().operationId as string };
}
async function drillNode(name: string, region: string) {
  const inst = `fake-${name}`;
  hh.compute.add({
    computeInstanceId: inst,
    region,
    dataRegion: region,
    vcpu: 2,
    memoryMb: 4096,
    diskGb: 100,
    status: 'running',
  });
  const c = await hh.admin('host', 'POST', '/v1/admin/hosting/nodes', {
    name,
    computeInstanceId: inst,
    purpose: 'restore_drill',
  });
  expect(c.statusCode).toBe(201);
  const id = c.json().node.id as string;
  expect(c.json().node.purpose).toBe('restore_drill');
  const p = await hh.admin('host', 'PUT', `/v1/admin/hosting/nodes/${id}/panel`, {
    host: `${name}.hosting.example.test`,
    credentials: { accessKey: 'TESTACCESSKEYID0002:test-secret-access-key-0002' },
  });
  expect(p.statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  main = await startHestiaMock();
  drill = await startHestiaMock();
  for (const m of [main, drill]) m.controls.packages.push('nz-shared', 'nz-wp');
  main.controls.onUpload = (user, name, data) =>
    void sink.store.set(`${REGION}/${user}/${name}`, data);
  const channel = new HttpHestiaChannel({ allowPlainLoopback: true });
  const client = new HestiaClient(
    {
      resolve: async (id) => {
        const m = panelOf(id);
        return { host: m.host, port: m.port, accessKeyRef: 'vault://dev/hosting-panel-x' };
      },
    },
    { accessKey: async () => main.controls.hash },
    channel,
  );
  const adapter = new HestiaHostingAdapter(client, {
    vault,
    evidenceKind: 'mock',
    packageFor: (_l, key) => (key ? `nz-${key}` : 'default'),
    archives: {
      sink,
      regionOf: async (id) => (id === euDrillNodeId ? 'eu-test' : REGION),
      waitMs: 1500,
      pollMs: 10,
    },
    stager: {
      async stage(node, site, archive, ref) {
        const data = await sink.get(ref);
        if (!data) return { ok: false, detail: 'not in the store' };
        panelOf(node.nodeId).controls.stage(site, archive, data);
        return { ok: true };
      },
    },
    capacityOf: async (n) => {
      const i = await hh.compute.describe(n.computeInstanceId);
      return i
        ? { cpuMillicores: i.vcpu * 1000, memoryMb: i.memoryMb, diskMb: i.diskGb * 1024 }
        : null;
    },
  });
  const probe = {
    observe: async (id: string, domain: string): Promise<SiteObservation> => {
      const s = panelOf(id).controls.siteState(domain);
      return { ...s, detail: s.answers ? `phase ${s.phase}` : 'no such site on the node' };
    },
  };
  await hh.init({
    overrides: [
      [HOSTING_ADAPTER, adapter],
      [WORDPRESS_PORT, new HestiaWordPress(client, { evidenceKind: 'mock' })],
      [SITE_PROBE, probe],
      [VAULT_PORT, vault],
      [BACKUP_SINK, sink],
    ],
  });
  await hh.customers();
  proj = await hh.project(hh.orgs.A!);
  planShared = await hh.plan('shared', { quotas: { backupCount: 3 } });
  planWp = await hh.plan('wp', {
    runtimes: ['php'],
    app: 'wordpress',
    quotas: { backupCount: 3, dbCount: 2 },
  });
  nodeId = await hh.activeNode('hestia-a');
  drillNodeId = await drillNode('drill-a', REGION);
  euDrillNodeId = await drillNode('drill-eu', 'eu-test');
  for (const id of [drillNodeId, euDrillNodeId])
    await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${id}/inventory`);
}, 240_000);
afterAll(async () => {
  await hh.close();
  await main.close();
  await drill.close();
});

describe('orders: Shared and WordPress', () => {
  it("a Shared order becomes an active account on the plan's Hestia package, with no application", async () => {
    const { siteId } = await newSite(planShared, 'php:8.3', 'shared-1');
    const s = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}`)).json();
    expect(s).toMatchObject({ status: 'active', app: 'none' });
    expect(main.controls.users.get((await siteRow(siteId)).node_name)!.pkg).toBe('nz-shared');
    expect(await appRow(siteId)).toBeUndefined();
    expect(
      (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}/wordpress`)).statusCode,
    ).toBe(404);
  });

  let wpSite = '';
  let account = '';
  let domain = '';
  it('a WordPress order: the site is active, the install is queued, and WordPress is declared ready only after the site shows it', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planWp, 'php:8.3');
    const body = {
      quoteId: q.json().id,
      planId: planWp,
      name: 'blog-1',
      projectId: proj,
      runtime: 'php:8.3',
    };
    const r = await hh.call('alice', 'POST', '/v1/hosting/sites', body);
    expect(r.statusCode).toBe(202);
    wpSite = r.json().site.id;
    // DUPLICATE payment notification / double submit of the same quote: the same site and operation, not a second site
    const dup = await hh.call('alice', 'POST', '/v1/hosting/sites', body);
    expect([200, 202]).toContain(dup.statusCode);
    expect(dup.json().site.id).toBe(wpSite);
    expect(dup.json().operationId).toBe(r.json().operationId);
    await run(hh.orgs.A!, r.json().operationId);
    const site = await siteRow(wpSite);
    account = site.node_name;
    domain = `${account}.${'sites.nuzm.invalid'}`;
    expect(site).toMatchObject({ status: 'active', app_kind: 'wordpress' });
    const pending = await appRow(wpSite);
    expect(pending).toMatchObject({ state: 'pending', handover_state: 'none' });
    expect(
      (await hh.call('alice', 'GET', `/v1/hosting/sites/${wpSite}/wordpress`)).json(),
    ).toMatchObject({ state: 'pending', loginUrl: null });
    expect(main.controls.siteState(domain).phase).toBe('none'); // not installed yet: nothing is claimed

    const op = await wpOp(wpSite);
    await run(op.org_id, op.id);
    expect((await opRow(op.id)).state).toBe('succeeded');
    const wp = (await hh.call('alice', 'GET', `/v1/hosting/sites/${wpSite}/wordpress`)).json();
    expect(wp).toMatchObject({
      app: 'wordpress',
      state: 'ready',
      phase: 'installed',
      loginUrl: `https://${domain}/wp-admin`,
      verification: { answers: true, adminPage: true },
      handover: { state: 'pending' },
    });
    expect(main.controls.siteState(domain)).toEqual({
      answers: true,
      phase: 'installed',
      adminPage: true,
    });
    expect(main.controls.wpCalls).toEqual(['core download', 'config create', 'core install']);
    expect(main.controls.users.get(account)!.databases.size).toBe(1); // a dedicated database
    const steps = (
      await sql(
        `SELECT name, state FROM platform.operation_steps WHERE operation_id = $1 ORDER BY seq`,
        [op.id],
      )
    ).map((x: any) => `${x.name}:${x.state}`);
    expect(steps).toEqual(
      expect.arrayContaining([
        'observe:succeeded',
        'wp_cli:succeeded',
        'database:succeeded',
        'download:succeeded',
        'configure:succeeded',
        'install:succeeded',
        'verify:succeeded',
      ]),
    );
  });

  it('no secret is in any response, table, audit entry or log of the platform', async () => {
    const wp = main.controls.domainOf(domain)!.wp;
    const dbPass = [...main.controls.users.get(account)!.databases.values()][0]!.password;
    const everything = JSON.stringify([
      await sql(`SELECT * FROM hosting.site_apps`),
      await sql(`SELECT * FROM hosting.sites`),
      await sql(`SELECT * FROM audit.audit_logs`),
      await sql(`SELECT * FROM platform.operations`),
      await sql(`SELECT * FROM platform.operation_steps`),
      (await hh.call('alice', 'GET', `/v1/hosting/sites/${wpSite}/wordpress`)).json(),
    ]);
    expect(everything).not.toContain(wp.adminPassword!);
    expect(everything).not.toContain(dbPass);
    expect(everything).toContain('vault://hosting/org/'); // references only
  });

  it('the admin access is handed over ONCE: the first read gets it, a second (even parallel) read does not, and it is gone from the vault', async () => {
    const wp = main.controls.domainOf(domain)!.wp;
    // another organization and a viewer cannot reach it at all
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          `/v1/hosting/sites/${wpSite}/wordpress/handover`,
          undefined,
          hh.orgs.B!,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await hh.call('carol', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`)).statusCode,
    ).toBe(403);
    const [a, b] = await Promise.all([
      hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`),
      hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const won = a.statusCode === 200 ? a : b;
    expect(won.json()).toEqual({
      username: wp.adminUser,
      password: wp.adminPassword,
      loginUrl: `https://${domain}/wp-admin`,
    });
    expect(won.headers['cache-control']).toBe('no-store');
    expect((await appRow(wpSite))!.handover_state).toBe('consumed');
    expect(await vault.exists((await appRow(wpSite))!.admin_secret_ref)).toBe(false);
    const later = await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`);
    expect(later.statusCode).toBe(409);
    expect(JSON.stringify(later.json())).not.toContain(wp.adminPassword!);
  });

  it('a new admin password goes through `wp user update` and starts a new one-time handover', async () => {
    const before = main.controls.domainOf(domain)!.wp.adminPassword;
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/admin-resets`);
    expect(r.statusCode).toBe(202);
    await run(hh.orgs.A!, r.json().operationId);
    expect(main.controls.domainOf(domain)!.wp.adminPassword).not.toBe(before);
    const h = await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`);
    expect(h.statusCode).toBe(200);
    expect(h.json().password).toBe(main.controls.domainOf(domain)!.wp.adminPassword);
  });

  it('an unread handover expires and its secret leaves the vault', async () => {
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/admin-resets`);
    await run(hh.orgs.A!, r.json().operationId);
    const ref = (await appRow(wpSite))!.admin_secret_ref;
    expect(await vault.exists(ref)).toBe(true);
    await sql(
      `UPDATE hosting.site_apps SET handover_expires_at = now() - interval '1 minute' WHERE site_id = $1`,
      [wpSite],
    );
    expect(
      (await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSite}/wordpress/handover`)).statusCode,
    ).toBe(410);
    const swept = await hh.app.get(WordPressService).sweep();
    expect(swept.expired).toBeGreaterThanOrEqual(0);
    await hh.app.get(WordPressService).sweep();
    expect((await appRow(wpSite))!.handover_state).toBe('expired');
    expect(await vault.exists(ref)).toBe(false);
  });

  it('a second worker running the same install changes nothing and loses no content', async () => {
    main.controls.domainOf(domain)!.wp.posts.push('a real post');
    const svc = hh.app.get(WordPressService);
    const op = await wpOp(wpSite);
    const results = await Promise.allSettled([
      svc.execute({ orgId: op.org_id, operationId: op.id, input: { siteId: wpSite }, attempts: 1 }),
      svc.execute({ orgId: op.org_id, operationId: op.id, input: { siteId: wpSite }, attempts: 1 }),
    ]);
    expect(
      results.map((x) => (x.status === 'fulfilled' ? 'ok' : String((x.reason as Error).message))),
    ).toEqual(['ok', 'ok']);
    expect(main.controls.wpCalls.filter((c) => c === 'core install')).toHaveLength(1);
    expect(main.controls.domainOf(domain)!.wp.posts).toEqual(['Hello world!', 'a real post']);
    expect((await appRow(wpSite))!.state).toBe('ready');
  });
});

describe('WordPress failures: timeout, bootstrap failure, restart before completion, retry that keeps the content', () => {
  const fresh = async (name: string) => {
    const q = await hh.quote('alice', hh.orgs.A!, planWp, 'php:8.3');
    const r = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: q.json().id,
      planId: planWp,
      name,
      projectId: proj,
      runtime: 'php:8.3',
    });
    await run(hh.orgs.A!, r.json().operationId);
    const siteId = r.json().site.id as string;
    const account = (await siteRow(siteId)).node_name as string;
    return { siteId, account, domain: `${account}.sites.nuzm.invalid`, op: await wpOp(siteId) };
  };

  it('a provider timeout during the download is a retry that resumes: one download, one database', async () => {
    const s = await fresh('blog-timeout');
    main.controls.inject('v-run-cli-cmd', 'drop', 1); // the answer to the first WP-CLI call never arrives (and neither does its effect)
    await run(s.op.org_id, s.op.id);
    expect((await opRow(s.op.id)).state).toBe('pending'); // retried with backoff, not failed
    expect((await appRow(s.siteId))!.state).toBe('installing');
    await again(s.op.org_id, s.op.id);
    expect((await opRow(s.op.id)).state).toBe('succeeded');
    expect((await appRow(s.siteId))!.state).toBe('ready');
    expect(main.controls.users.get(s.account)!.databases.size).toBe(1);
  });

  it('a restart in the middle (the process dies after the download): the next run starts at the configuration, never downloads again', async () => {
    const s = await fresh('blog-restart');
    main.controls.failWp('config create', 21, 1);
    await run(s.op.org_id, s.op.id);
    expect(main.controls.siteState(s.domain).phase).toBe('unconfigured');
    const downloadsBefore = main.controls.wpCalls.filter((c) => c === 'core download').length;
    await again(s.op.org_id, s.op.id);
    expect((await appRow(s.siteId))!.state).toBe('ready');
    expect(main.controls.wpCalls.filter((c) => c === 'core download').length).toBe(downloadsBefore); // exactly one download for this site
  });

  it('a lost answer to `core install` (the install DID happen) is settled by looking at the site: ready, installed once', async () => {
    const s = await fresh('blog-lost');
    main.controls.dropWpAnswer('core install', 1);
    const before = main.controls.wpCalls.filter((c) => c === 'core install').length;
    await run(s.op.org_id, s.op.id);
    expect((await appRow(s.siteId))!.state).toBe('ready');
    expect(main.controls.wpCalls.filter((c) => c === 'core install').length - before).toBe(1);
    expect((await appRow(s.siteId))!.handover_state).toBe('pending'); // our install: the access can be handed over
  });

  let failedSite: Awaited<ReturnType<typeof fresh>>;
  it('a bootstrap failure that never clears fails the installation visibly (state, reason, alert) without losing the site', async () => {
    failedSite = await fresh('blog-failed');
    main.controls.failWp('core install', 21, 50);
    let guard = 0;
    while ((await opRow(failedSite.op.id)).state !== 'failed' && guard++ < 8)
      await again(failedSite.op.org_id, failedSite.op.id);
    expect((await opRow(failedSite.op.id)).state).toBe('failed');
    const wp = (
      await hh.call('alice', 'GET', `/v1/hosting/sites/${failedSite.siteId}/wordpress`)
    ).json();
    expect(wp).toMatchObject({ state: 'failed', phase: 'uninstalled' });
    expect(wp.lastError).toContain('install');
    expect((await siteRow(failedSite.siteId)).status).toBe('active');
    const m = await hh.app.get(MonitorService).sweep();
    expect(m.open).toBeGreaterThan(0);
    const alerts = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts')).json().items;
    expect(
      alerts.some((a: any) => a.kind === 'wordpress_failed' && a.siteId === failedSite.siteId),
    ).toBe(true);
  });

  it('retry on the same site resumes and keeps the database and the files; the alert resolves by itself', async () => {
    main.controls.wpCalls.length = 0;
    main.controls.clearWpFaults(); // the cause is fixed
    const r = await hh.call(
      'alice',
      'POST',
      `/v1/hosting/sites/${failedSite.siteId}/wordpress/retry`,
    );
    expect(r.statusCode).toBe(202);
    let guard = 0;
    const op = r.json().operationId as string;
    while ((await appRow(failedSite.siteId))!.state !== 'ready' && guard++ < 60)
      await again(hh.orgs.A!, op);
    expect((await appRow(failedSite.siteId))!.state).toBe('ready');
    expect(main.controls.users.get(failedSite.account)!.databases.size).toBe(1);
    expect(main.controls.wpCalls).not.toContain('core download');
    expect(main.controls.wpCalls).not.toContain('config create');
    await hh.app.get(MonitorService).sweep();
    const open = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts')).json().items;
    expect(
      open.some((a: any) => a.kind === 'wordpress_failed' && a.siteId === failedSite.siteId),
    ).toBe(false);
  });

  it('retry is refused unless the installation failed, and by anyone who cannot update the site', async () => {
    expect(
      (await hh.call('alice', 'POST', `/v1/hosting/sites/${failedSite.siteId}/wordpress/retry`))
        .statusCode,
    ).toBe(409);
    expect(
      (await hh.call('carol', 'POST', `/v1/hosting/sites/${failedSite.siteId}/wordpress/retry`))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          `/v1/hosting/sites/${failedSite.siteId}/wordpress/retry`,
          undefined,
          hh.orgs.B!,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('restart safety: a lost application row or a pending one without a live operation is queued again by the sweep, and the install still completes once', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planWp, 'php:8.3');
    const r = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: q.json().id,
      planId: planWp,
      name: 'blog-sweep',
      projectId: proj,
      runtime: 'php:8.3',
    });
    await run(hh.orgs.A!, r.json().operationId);
    const siteId = r.json().site.id as string;
    const svc = hh.app.get(WordPressService);
    // the process died after activating the site and before the application row existed
    await sql(
      `DELETE FROM platform.operation_steps WHERE operation_id IN (SELECT id FROM platform.operations WHERE kind = 'hosting.wordpress.install' AND resource_id = $1)`,
      [siteId],
    );
    await sql(
      `DELETE FROM platform.operations WHERE kind = 'hosting.wordpress.install' AND resource_id = $1`,
      [siteId],
    );
    await sql(`DELETE FROM hosting.site_apps WHERE site_id = $1`, [siteId]);
    expect((await svc.sweep()).queued).toBeGreaterThanOrEqual(1);
    expect(await appRow(siteId)).toMatchObject({ state: 'pending' });
    expect((await svc.sweep()).queued).toBe(0); // the live operation is seen: no second one
    // and a pending row whose operation vanished (marked failed by hand) is queued again once it is old enough
    const op1 = await wpOp(siteId);
    await sql(`UPDATE platform.operations SET state = 'failed' WHERE id = $1`, [op1.id]);
    await sql(
      `UPDATE hosting.site_apps SET updated_at = now() - interval '10 minutes' WHERE site_id = $1`,
      [siteId],
    );
    expect((await svc.sweep()).queued).toBe(1);
    const op2 = await wpOp(siteId);
    expect(op2.id).not.toBe(op1.id);
    await run(op2.org_id, op2.id);
    expect((await appRow(siteId))!.state).toBe('ready');
    expect(main.controls.users.get((await siteRow(siteId)).node_name)!.databases.size).toBe(1);
  });

  it('capacity exhausted: a WordPress order is refused with no site, no app row and no operation', async () => {
    const huge = await hh.plan('wp-huge', {
      runtimes: ['php'],
      app: 'wordpress',
      disk: 10_000_000,
    });
    const sitesBefore = (await sql(`SELECT count(*)::int AS n FROM hosting.sites`))[0]!.n;
    const r = await hh.createSite('alice', hh.orgs.A!, huge, 'php:8.3', 'blog-huge', proj);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('no_capacity');
    expect((await sql(`SELECT count(*)::int AS n FROM hosting.sites`))[0]!.n).toBe(sitesBefore);
  });
});

describe('backups: scheduled, on demand, off the node, restore', () => {
  let siteId = '';
  let account = '';
  let backupId = '';
  it('the daily schedule queues one backup per site and never a second the same day', async () => {
    const s = await newSite(planShared, 'php:8.3', 'bk-1');
    siteId = s.siteId;
    account = (await siteRow(siteId)).node_name;
    const svc = hh.app.get(BackupService);
    const first = await svc.scheduleDue();
    expect(first.queued).toBeGreaterThanOrEqual(1);
    const rows = await sql(`SELECT id, kind, status FROM hosting.site_backups WHERE site_id = $1`, [
      siteId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'scheduled', status: 'creating' });
    expect((await svc.scheduleDue()).queued).toBe(0);
    expect(
      await sql(`SELECT 1 FROM hosting.site_backups WHERE site_id = $1`, [siteId]),
    ).toHaveLength(1);
    const op = (
      await sql(
        `SELECT id, org_id FROM platform.operations WHERE kind = 'hosting.backup.create' AND resource_id = $1`,
        [siteId],
      )
    )[0]!;
    await run(op.org_id, op.id);
    const b = (await sql(`SELECT * FROM hosting.site_backups WHERE site_id = $1`, [siteId]))[0]!;
    backupId = b.id;
    expect(b.status).toBe('available');
    expect(b.archive_name).toMatch(new RegExp(`^${account}\\.`));
    expect(b.sink_ref).toBe(`${REGION}/${account}/${b.archive_name}`);
    expect(sink.store.has(b.sink_ref)).toBe(true); // OFF the node, in the site's region
    expect(b.provider_state).toMatchObject({
      encrypted: false,
      snapshot: { domains: [expect.stringContaining(account)] },
    });
    expect(b.provider_state.known).toEqual([]);
    expect(
      main.controls.commands.filter((c) => c === 'v-schedule-user-backup').length,
    ).toBeGreaterThanOrEqual(1);
    const list = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}/backups`)).json()
      .items;
    expect(list[0]).toMatchObject({ kind: 'scheduled', status: 'available', encrypted: false });
  });

  it('a retry of the backup operation after a restart does not schedule a second archive', async () => {
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${siteId}/backups`, {
      label: 'manual',
    });
    expect(r.statusCode).toBe(202);
    const sched = () => main.controls.archives.get(account)?.size ?? 0; // archives of THIS account (other due operations may run too)
    const before = sched();
    main.controls.inject('v-schedule-user-backup', 'drop-after'); // the schedule happened, the answer was lost
    await run(hh.orgs.A!, r.json().operationId);
    const op = await opRow(r.json().operationId);
    expect(['needs_reconcile', 'pending']).toContain(op.state);
    await hh.jobs().runDue();
    if ((await opRow(r.json().operationId)).state === 'pending')
      await again(hh.orgs.A!, r.json().operationId);
    expect((await opRow(r.json().operationId)).state).toBe('succeeded');
    expect(sched() - before).toBe(1);
    expect(
      (await sql(`SELECT status FROM hosting.site_backups WHERE id = $1`, [r.json().backup.id]))[0]!
        .status,
    ).toBe('available');
  });

  it('a backup the panel never produces fails visibly (status, reason, alert) and does not count as a backup', async () => {
    main.controls.backupQueueRuns = false;
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${siteId}/backups`, {
      label: 'stuck',
    });
    await run(hh.orgs.A!, r.json().operationId);
    main.controls.backupQueueRuns = true;
    const row = (
      await sql(`SELECT status, failure_reason FROM hosting.site_backups WHERE id = $1`, [
        r.json().backup.id,
      ])
    )[0]!;
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toContain('did not appear');
    await hh.app.get(MonitorService).sweep();
    const alerts = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts')).json().items;
    expect(alerts.some((a: any) => a.kind === 'backup_failed' && a.siteId === siteId)).toBe(true);
  });

  it('restore: a pre-restore safety backup, the account restored from the off-server archive, verified against the snapshot', async () => {
    main.controls.users.get(account)!.domains.clear(); // the customer lost the site
    main.controls.keepLocalCopy = false;
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${siteId}/restores`, { backupId });
    expect(r.statusCode).toBe(202);
    await run(hh.orgs.A!, r.json().operationId);
    main.controls.keepLocalCopy = true;
    expect((await opRow(r.json().operationId)).state).toBe('succeeded');
    expect((await siteRow(siteId)).status).toBe('active');
    expect(main.controls.users.get(account)!.domains.size).toBe(1);
    expect(main.controls.restores.at(-1)).toMatchObject({ user: account });
    const kinds = (
      await sql(`SELECT kind FROM hosting.site_backups WHERE site_id = $1`, [siteId])
    ).map((x: any) => x.kind);
    expect(kinds).toContain('pre_restore');
  });

  it('a tampered archive is detected before anything is overwritten, and marked corrupt', async () => {
    const b = (await sql(`SELECT * FROM hosting.site_backups WHERE id = $1`, [backupId]))[0]!;
    const good = sink.store.get(b.sink_ref)!;
    sink.store.set(b.sink_ref, Buffer.from('tampered'));
    const restoresBefore = main.controls.restores.length;
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${siteId}/restores`, { backupId });
    await run(hh.orgs.A!, r.json().operationId);
    sink.store.set(b.sink_ref, good);
    expect((await opRow(r.json().operationId)).state).toBe('failed');
    expect(main.controls.restores.length).toBe(restoresBefore);
    expect(
      (await sql(`SELECT status FROM hosting.site_backups WHERE id = $1`, [backupId]))[0]!.status,
    ).toBe('corrupt');
    expect((await siteRow(siteId)).status).toBe('active');
    await sql(
      `UPDATE hosting.site_backups SET status = 'available', failure_reason = NULL WHERE id = $1`,
      [backupId],
    );
  });

  it('retention removes the archive from the store AND the node copy, and the row says deleted', async () => {
    const b = (await sql(`SELECT * FROM hosting.site_backups WHERE id = $1`, [backupId]))[0]!;
    await sql(
      `UPDATE hosting.site_backups SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [backupId],
    );
    const out = await hh.app.get(BackupService).sweepRetention();
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(sink.store.has(b.sink_ref)).toBe(false);
    expect(main.controls.archives.get(account)?.has(b.archive_name)).toBeFalsy();
    expect(
      (await sql(`SELECT status FROM hosting.site_backups WHERE id = $1`, [backupId]))[0]!.status,
    ).toBe('deleted');
  });

  it("a site at its backup limit expires its OLDEST scheduled backup first; a quota filled by the customer's own backups is left alone", async () => {
    const s = await newSite(planShared, 'php:8.3', 'bk-limit');
    const orgId = hh.orgs.A!;
    const mk = (kind: string, age: number) =>
      sql(
        `INSERT INTO hosting.site_backups (id, site_id, org_id, kind, status, size_bytes, checksum, sink_ref, enc_key_ref, data_region, created_at, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'available', 1, $4, 'x/y/z', 'vault://k', $5, now() - make_interval(hours => $6), now() + interval '20 days') RETURNING id`,
        [s.siteId, orgId, kind, 'a'.repeat(64), REGION, age],
      );
    const oldest = (await mk('scheduled', 60))[0]!.id;
    await mk('scheduled', 50);
    await mk('on_demand', 40);
    const q = await hh.app.get(BackupService).scheduleDue();
    expect(q.queued).toBeGreaterThanOrEqual(1);
    const exp = (
      await sql(
        `SELECT expires_at < now() + interval '1 minute' AS soon FROM hosting.site_backups WHERE id = $1`,
        [oldest],
      )
    )[0]!;
    expect(exp.soon).toBe(true);
    // all on-demand: nothing to expire, nothing queued
    const s2 = await newSite(planShared, 'php:8.3', 'bk-full');
    for (const age of [60, 50, 40])
      await sql(
        `INSERT INTO hosting.site_backups (id, site_id, org_id, kind, status, size_bytes, checksum, sink_ref, enc_key_ref, data_region, created_at, expires_at) VALUES (gen_random_uuid(), $1, $2, 'on_demand', 'available', 1, $3, 'x/y/z', 'vault://k', $4, now() - make_interval(hours => $5), now() + interval '20 days')`,
        [s2.siteId, orgId, 'b'.repeat(64), REGION, age],
      );
    await hh.app.get(BackupService).scheduleDue();
    expect(
      await sql(`SELECT 1 FROM hosting.site_backups WHERE site_id = $1 AND kind = 'scheduled'`, [
        s2.siteId,
      ]),
    ).toHaveLength(0);
  });
});

describe('restore drills: a real backup restored into an isolated node, with duration and result', () => {
  let wpSiteId = '';
  let wpAccount = '';
  let backup = '';
  it('prepares a backup of a WordPress site', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planWp, 'php:8.3');
    const r = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: q.json().id,
      planId: planWp,
      name: 'drill-blog',
      projectId: proj,
      runtime: 'php:8.3',
    });
    await run(hh.orgs.A!, r.json().operationId);
    wpSiteId = r.json().site.id;
    wpAccount = (await siteRow(wpSiteId)).node_name;
    const op = await wpOp(wpSiteId);
    await run(op.org_id, op.id);
    expect((await appRow(wpSiteId))!.state).toBe('ready');
    const b = await hh.call('alice', 'POST', `/v1/hosting/sites/${wpSiteId}/backups`, {
      label: 'for-drill',
    });
    await run(hh.orgs.A!, b.json().operationId);
    backup = b.json().backup.id;
    expect(
      (await sql(`SELECT status FROM hosting.site_backups WHERE id = $1`, [backup]))[0]!.status,
    ).toBe('available');
  });

  it("refuses a drill anywhere but on an isolated drill node of the backup's own region", async () => {
    const post = (b: object) => hh.admin('host', 'POST', '/v1/admin/hosting/restore-drills', b);
    expect((await post({ backupId: backup, nodeId })).statusCode).toBe(409); // a customer node
    const eu = await post({ backupId: backup, nodeId: euDrillNodeId });
    expect(eu.statusCode).toBe(403);
    expect(eu.json().code).toBe('residency_denied'); // customer data never leaves its region
    expect((await post({ backupId: backup, nodeId: drillNodeId, extra: 1 })).statusCode).toBe(422);
    expect(
      (
        await hh.admin(
          'host',
          'PATCH',
          `/v1/admin/hosting/nodes/${drillNodeId}`,
          { status: 'active' },
          {
            'if-match': (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${drillNodeId}`))
              .headers.etag as string,
          },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await hh.admin('support', 'POST', '/v1/admin/hosting/restore-drills', {
          backupId: backup,
          nodeId: drillNodeId,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('restores the backup on the drill node, checks the account and the WordPress site, wipes it, and records the duration', async () => {
    const r = await hh.admin('host', 'POST', '/v1/admin/hosting/restore-drills', {
      backupId: backup,
      nodeId: drillNodeId,
    });
    expect(r.statusCode).toBe(202);
    const id = r.json().drill.id as string;
    await run(hh.orgs.A!, r.json().operationId);
    const d = (await hh.admin('host', 'GET', `/v1/admin/hosting/restore-drills/${id}`)).json();
    expect(d).toMatchObject({
      state: 'passed',
      backupId: backup,
      nodeId: drillNodeId,
      checks: { restore: 'passed', account: 'passed', wordpress: 'passed', wipe: 'passed' },
    });
    expect(d.durationMs).toBeGreaterThanOrEqual(0);
    expect(d.finishedAt).toBeTruthy();
    expect(drill.controls.restores).toEqual([expect.objectContaining({ user: wpAccount })]);
    expect(drill.controls.users.has(wpAccount)).toBe(false); // the customer's account does not stay on the drill node
    expect(main.controls.users.has(wpAccount)).toBe(true); // and the production node was never touched
    expect(
      (await hh.admin('host', 'GET', '/v1/admin/hosting/restore-drills')).json().items[0].id,
    ).toBe(id);
  });

  it('a drill whose archive does not match fails visibly, still wipes, and raises an alert', async () => {
    const b = (await sql(`SELECT sink_ref FROM hosting.site_backups WHERE id = $1`, [backup]))[0]!;
    const good = sink.store.get(b.sink_ref)!;
    sink.store.set(b.sink_ref, Buffer.from('tampered'));
    const r = await hh.admin('host', 'POST', '/v1/admin/hosting/restore-drills', {
      backupId: backup,
      nodeId: drillNodeId,
    });
    await run(hh.orgs.A!, r.json().operationId);
    sink.store.set(b.sink_ref, good);
    const d = (
      await hh.admin('host', 'GET', `/v1/admin/hosting/restore-drills/${r.json().drill.id}`)
    ).json();
    expect(d.state).toBe('failed');
    expect(d.checks.restore).toContain('failed');
    expect(d.checks.wipe).toBe('passed');
    await hh.app.get(MonitorService).sweep();
    const alerts = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts')).json().items;
    expect(alerts.some((a: any) => a.kind === 'restore_drill_failed')).toBe(true);
  });
});

describe('monitoring and alerts', () => {
  const kinds = async () =>
    (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts'))
      .json()
      .items.map((a: any) => a.kind);
  it('capacity: a node that is nearly full raises one alert, not one per sweep, and resolves when room returns', async () => {
    const cap = (
      await sql(
        `SELECT sellable, reserved FROM hosting.node_capacity WHERE node_id = $1 AND dim = 'disk_mb'`,
        [nodeId],
      )
    )[0]!;
    await sql(
      `UPDATE hosting.node_capacity SET sellable = reserved + 50 WHERE node_id = $1 AND dim = 'disk_mb'`,
      [nodeId],
    ); // 99% reserved
    const mon = hh.app.get(MonitorService);
    await mon.sweep();
    const r2 = await mon.sweep();
    expect(r2.opened).toBe(0); // idempotent
    const a = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts'))
      .json()
      .items.filter((x: any) => x.kind === 'capacity_low');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: 'critical', nodeId, state: 'open' });
    await sql(
      `UPDATE hosting.node_capacity SET sellable = $2 WHERE node_id = $1 AND dim = 'disk_mb'`,
      [nodeId, cap.sellable],
    );
    await mon.sweep();
    expect(await kinds()).not.toContain('capacity_low');
    expect(
      (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts?state=resolved'))
        .json()
        .items.some((x: any) => x.kind === 'capacity_low'),
    ).toBe(true);
  });

  it('panel link: a node whose database service is down is `degraded` and alerts; it resolves when the service is back', async () => {
    main.controls.services.mariadb = 'stopped';
    await hh.app.get(MonitorService).sweep();
    const a = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts'))
      .json()
      .items.find((x: any) => x.kind === 'panel_unreachable' && x.nodeId === nodeId);
    expect(a?.summary).toContain('degraded');
    expect((await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).json().health).toBe(
      'degraded',
    );
    main.controls.services.mariadb = 'running';
    await hh.app.get(MonitorService).sweep();
    expect((await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).json().health).toBe(
      'healthy',
    );
    expect(await kinds()).not.toContain('panel_unreachable');
  });

  it('backup store: an unreachable store of a region raises a critical alert', async () => {
    sink.healthy = false;
    await hh.app.get(MonitorService).sweep();
    const a = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts'))
      .json()
      .items.find((x: any) => x.kind === 'backup_host_unreachable');
    expect(a).toMatchObject({ severity: 'critical' });
    sink.healthy = true;
    await hh.app.get(MonitorService).sweep();
    expect(await kinds()).not.toContain('backup_host_unreachable');
  });

  it('certificates, stuck activation and a site without a recent backup are all reported', async () => {
    const s = await newSite(planShared, 'php:8.3', 'mon-1');
    await sql(
      `INSERT INTO hosting.ssl_certificates (id, site_id, org_id, domains, mode, status, not_after, issued_at) VALUES (gen_random_uuid(), $1, $2, ARRAY['mon.example.com'], 'managed', 'issued', now() + interval '3 days', now() - interval '80 days')`,
      [s.siteId, hh.orgs.A],
    );
    await sql(`UPDATE hosting.sites SET created_at = now() - interval '3 days' WHERE id = $1`, [
      s.siteId,
    ]);
    const q = await hh.quote('alice', hh.orgs.A!, planShared, 'php:8.3');
    const stuck = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: q.json().id,
      planId: planShared,
      name: 'mon-stuck',
      projectId: proj,
      runtime: 'php:8.3',
    });
    await sql(`UPDATE hosting.sites SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      stuck.json().site.id,
    ]);
    await hh.app.get(MonitorService).sweep();
    const k = await kinds();
    expect(k).toEqual(
      expect.arrayContaining(['certificate_expiring', 'activation_stuck', 'backup_missing']),
    );
    await run(hh.orgs.A!, stuck.json().operationId); // the activation completes: its alert resolves
    await hh.app.get(MonitorService).sweep();
    const open = (await hh.admin('host', 'GET', '/v1/admin/hosting/alerts')).json().items;
    expect(
      open.some((x: any) => x.kind === 'activation_stuck' && x.siteId === stuck.json().site.id),
    ).toBe(false);
  });

  it('alerts are staff-only and can be run on demand', async () => {
    expect(
      (await hh.call('alice', 'GET', '/v1/admin/hosting/alerts')).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const r = await hh.admin('host', 'POST', '/v1/admin/hosting/monitor-runs');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      open: expect.any(Number),
      opened: expect.any(Number),
      resolved: expect.any(Number),
    });
  });

  it('serves the node setup material: one package per plan and the access profile that matches the adapter', async () => {
    const r = (await hh.admin('host', 'GET', '/v1/admin/hosting/node-packages')).json();
    expect(r.packages.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(['nz-shared', 'nz-wp']),
    );
    expect(r.packages.find((p: any) => p.name === 'nz-wp').file).toContain("BACKUPS='3'");
    expect(r.accessProfile).toContain("COMMANDS='v-add-cron-job,v-add-database,");
  });
});

describe('customer isolation', () => {
  it('another organization cannot read, retry, reset, back up, restore or download anything of a site (404, never 403)', async () => {
    const s = (
      await sql(
        `SELECT id FROM hosting.sites WHERE app_kind = 'wordpress' AND org_id = $1 LIMIT 1`,
        [hh.orgs.A],
      )
    )[0]!.id as string;
    const bk = (
      await sql(
        `SELECT id FROM hosting.site_backups WHERE org_id = $1 AND status = 'available' LIMIT 1`,
        [hh.orgs.A],
      )
    )[0]!;
    const siteWithBackup = (
      await sql(`SELECT site_id FROM hosting.site_backups WHERE id = $1`, [bk.id])
    )[0]!.site_id as string;
    const B = hh.orgs.B!;
    for (const [m, u] of [
      ['GET', `/v1/hosting/sites/${s}/wordpress`],
      ['POST', `/v1/hosting/sites/${s}/wordpress/retry`],
      ['POST', `/v1/hosting/sites/${s}/wordpress/admin-resets`],
      ['POST', `/v1/hosting/sites/${s}/wordpress/handover`],
      ['GET', `/v1/hosting/sites/${siteWithBackup}/backups`],
      ['POST', `/v1/hosting/sites/${siteWithBackup}/backups`],
      ['POST', `/v1/hosting/sites/${siteWithBackup}/restores`],
      ['POST', `/v1/hosting/sites/${siteWithBackup}/backups/${bk.id}/download-links`],
    ] as const) {
      const r = await hh.call('bob', m, u, m === 'POST' ? { backupId: bk.id } : undefined, B);
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
  });
  it("row-level security hides another organization's applications, backups and drills even from a direct query", async () => {
    const db = hh.app.get(DB) as any;
    const seen = await db.withOrg(hh.orgs.B, async (c: any) => ({
      apps: (await c.query(`SELECT count(*)::int AS n FROM hosting.site_apps`)).rows[0].n,
      backups: (await c.query(`SELECT count(*)::int AS n FROM hosting.site_backups`)).rows[0].n,
    }));
    expect(seen).toEqual({ apps: 0, backups: 0 });
    const mine = await db.withOrg(
      hh.orgs.A,
      async (c: any) =>
        (await c.query(`SELECT count(*)::int AS n FROM hosting.site_apps`)).rows[0].n,
    );
    expect(mine).toBeGreaterThan(0);
    const drills = await db.withOrg(
      hh.orgs.A,
      async (c: any) =>
        (await c.query(`SELECT count(*)::int AS n FROM hosting.restore_drills`)).rows[0].n,
    );
    expect(drills).toBe(0); // drills are platform-scope only
  });
  it('deleting a WordPress site removes its secrets from the vault', async () => {
    const s = (
      await sql(
        `SELECT s.id, s.name, a.admin_secret_ref, a.db_secret_ref FROM hosting.sites s JOIN hosting.site_apps a ON a.site_id = s.id WHERE s.name = 'blog-1'`,
      )
    )[0]!;
    expect(await vault.exists(s.db_secret_ref)).toBe(true);
    const d = await hh.call('alice', 'DELETE', `/v1/hosting/sites/${s.id}`, undefined, hh.orgs.A!, {
      'x-confirm-delete': 'blog-1',
    });
    expect(d.statusCode).toBe(202);
    await sql(`UPDATE hosting.sites SET export_until = now() - interval '1 minute' WHERE id = $1`, [
      s.id,
    ]);
    await again(hh.orgs.A!, d.json().operationId);
    const op = await opRow(d.json().operationId);
    expect({ state: op.state, error: op.error }).toEqual({ state: 'succeeded', error: null });
    expect(await vault.exists(s.db_secret_ref)).toBe(false);
    expect(await vault.exists(s.admin_secret_ref)).toBe(false);
  });
});

export { MemoryVault };
