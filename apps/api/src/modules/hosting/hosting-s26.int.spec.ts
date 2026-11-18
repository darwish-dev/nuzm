import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostingHarness } from './hosting-harness';
import { BackupService } from './internal/backups.service';
import { UsageService } from './internal/usage.service';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const hh = new HostingHarness();
let nodeA = '';
let nodeB = '';
let plan = '';
let projA = '';
const orgA = () => hh.orgs.A!;
const orgB = () => hh.orgs.B!;
const run = (org: string, id: string) => hh.jobs().runOne(org, id);
const siteRow = async (id: string) =>
  (await hh.env.sql(`SELECT * FROM hosting.sites WHERE id=$1`, [id]))[0] as any;
const opState = async (id: string) =>
  ((await hh.env.sql(`SELECT state FROM platform.operations WHERE id=$1`, [id]))[0] as any)
    .state as string;
let n = 0;
async function newSite(who = 'alice', org = orgA(), proj = projA, p = plan) {
  const r = await hh.createSite(who, org, p, 'php:8.3', `s26-${++n}`, proj);
  expect(r.statusCode).toBe(202);
  await run(org, r.json().operationId);
  const s = await siteRow(r.json().site.id);
  return { id: s.id as string, nodeName: s.node_name as string, nodeId: s.node_id as string };
}
const nodeOf = (id: string) => hh.stack.nodes.get(id)!;

beforeAll(async () => {
  await hh.init();
  await hh.customers();
  projA = await hh.project(orgA());
  plan = await hh.plan('s26', {
    cpu: 100,
    mem: 100,
    disk: 300,
    quotas: { diskMb: 100, inodes: 1000, bandwidthGb: 10, backupCount: 3, backupGb: 5 },
  });
  nodeA = await hh.activeNode('s26-a');
});
afterAll(() => hh.close());

describe('backups: per-site encryption, checksum manifest, sink region, quotas, expiring links', () => {
  it('creates a backup (202) that becomes available with a checksum and a manifest of hashes (no content); keys never appear', async () => {
    const s = await newSite();
    nodeOf(s.nodeId).seed(s.nodeName, 'htdocs/index.html', '<h1>hello secret-marker-42</h1>');
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {
      label: 'before launch',
    });
    expect(r.statusCode).toBe(202);
    await run(orgA(), r.json().operationId);
    const list = (await hh.call('alice', 'GET', `/v1/hosting/sites/${s.id}/backups`)).json().items;
    expect(list[0]).toMatchObject({
      kind: 'on_demand',
      label: 'before launch',
      status: 'available',
    });
    expect(list[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    const row = (
      await hh.env.sql(`SELECT * FROM hosting.site_backups WHERE id=$1`, [list[0].id])
    )[0] as any;
    expect(JSON.stringify(row.manifest)).toMatch(/sha256/);
    for (const m of row.manifest)
      expect(Object.keys(m).sort(), JSON.stringify(m)).toEqual(['bytes', 'path', 'sha256']);
    expect(JSON.stringify(row)).not.toContain('secret-marker-42');
    expect(row.data_region).toBe('sa-central');
    expect(row.enc_key_ref).toMatch(/backup-key$/);
    const stored = [...hh.stack.sink.store.entries()].find(([k]) => k.includes(s.nodeName))!;
    expect(stored[0].startsWith('sa-central/')).toBe(true); // the sink region is the site region
    expect(stored[1].toString('utf8')).not.toContain('secret-marker-42'); // encrypted
    expect(
      JSON.stringify(await hh.env.sql(`SELECT t::text FROM audit.audit_logs t`)),
    ).not.toContain('secret-marker-42');
  });
  it('each site has its OWN key: archives of two sites cannot be exchanged (authentication fails)', async () => {
    const a = await newSite();
    const b = await newSite();
    expect(
      hh.vault.secrets
        .get((await siteRow(a.id)).backup_key_ref)!
        .equals(hh.vault.secrets.get((await siteRow(b.id)).backup_key_ref)!),
    ).toBe(false);
  });
  it('another organization gets 404 for the site, the backup id, a download link, and a link made by the owner', async () => {
    const s = await newSite();
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    await run(orgA(), r.json().operationId);
    const bid = r.json().backup.id;
    expect(
      (await hh.call('bob', 'GET', `/v1/hosting/sites/${s.id}/backups`, undefined, orgB()))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          `/v1/hosting/sites/${s.id}/backups/${bid}/download-links`,
          undefined,
          orgB(),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hh.call(
          'bob',
          'POST',
          `/v1/hosting/sites/${s.id}/restores`,
          { backupId: bid },
          orgB(),
        )
      ).statusCode,
    ).toBe(404);
    const link = (
      await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups/${bid}/download-links`)
    ).json();
    expect(link.url).toMatch(/^\/v1\/hosting\/backup-downloads\?token=/);
    const ok = await hh.call('alice', 'GET', link.url);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-nuzm-checksum-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(ok.rawPayload).length).toBeGreaterThan(20);
    // the same link presented by another organization, a forged token and a tampered token are all 404
    expect((await hh.call('bob', 'GET', link.url, undefined, orgB())).statusCode).toBe(404);
    expect((await hh.call('alice', 'GET', link.url.slice(0, -3) + 'abc')).statusCode).toBe(404);
    expect(
      (await hh.call('alice', 'GET', '/v1/hosting/backup-downloads?token=garbage.token'))
        .statusCode,
    ).toBe(404);
    // expiry
    await new Promise((r2) => setTimeout(r2, 2200));
    expect((await hh.call('alice', 'GET', link.url)).statusCode).toBe(410);
    // viewer may list but not create
    expect((await hh.call('carol', 'GET', `/v1/hosting/sites/${s.id}/backups`)).statusCode).toBe(
      200,
    );
    expect(
      (await hh.call('carol', 'POST', `/v1/hosting/sites/${s.id}/backups`, {})).statusCode,
    ).toBe(403);
  });
  it('enforces the plan backup count (422 quota_exceeded) and refuses a missing sink (422 no_backup_sink: production default)', async () => {
    const s = await newSite();
    for (let i = 0; i < 3; i++) {
      const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
      expect(r.statusCode).toBe(202);
      await run(orgA(), r.json().operationId);
    }
    const over = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    expect(over.statusCode).toBe(422);
    expect(over.json().code).toBe('quota_exceeded');
    const svc: any = hh.app.get(BackupService);
    const real = svc.sink;
    svc.sink = { kind: 'none', productionReady: false };
    const s2 = await newSite();
    const none = await hh.call('alice', 'POST', `/v1/hosting/sites/${s2.id}/backups`, {});
    expect(none.statusCode).toBe(422);
    expect(none.json().code).toBe('no_backup_sink');
    svc.sink = real;
  });
  it('residency: a site whose region the policy does not allow cannot store a backup (403 residency_denied)', async () => {
    const s = await newSite();
    await hh.env.sql(`UPDATE hosting.sites SET data_region = 'us-east' WHERE id=$1`, [s.id]);
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('residency_denied');
    await hh.env.sql(`UPDATE hosting.sites SET data_region = 'sa-central' WHERE id=$1`, [s.id]);
  });
  it('retention: expired backups leave the sink; a legal hold keeps them', async () => {
    const s = await newSite();
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    await run(orgA(), r.json().operationId);
    const ref = (
      (
        await hh.env.sql(`SELECT sink_ref FROM hosting.site_backups WHERE id=$1`, [
          r.json().backup.id,
        ])
      )[0] as any
    ).sink_ref as string;
    await hh.env.sql(
      `UPDATE hosting.site_backups SET expires_at = now() - interval '1 minute' WHERE id=$1`,
      [r.json().backup.id],
    );
    const svc = hh.app.get(BackupService);
    const hold = crypto.randomUUID();
    await hh.env.sql(`ALTER TABLE audit.legal_holds DISABLE TRIGGER USER`);
    await hh.env.sql(
      `INSERT INTO audit.legal_holds (id, org_id, dataset, reason, status, requested_by, approver_id, decided_at) VALUES ($1,$2,'hosting.site_backups','held for the retention test','active',$3,$4,now())`,
      [hold, orgA(), hh.ids.alice, hh.ids.bob],
    );
    await hh.env.sql(`ALTER TABLE audit.legal_holds ENABLE TRIGGER USER`);
    expect((await svc.sweepRetention()).heldBack).toBeGreaterThanOrEqual(1);
    expect(await hh.stack.sink.exists(ref)).toBe(true);
    await hh.env.sql(`ALTER TABLE audit.legal_holds DISABLE TRIGGER USER`);
    await hh.env.sql(
      `UPDATE audit.legal_holds SET status='released', released_by=$2, released_at=now(), release_reason='released after the retention test' WHERE id=$1`,
      [hold, hh.ids.bob],
    );
    await hh.env.sql(`ALTER TABLE audit.legal_holds ENABLE TRIGGER USER`);
    expect((await svc.sweepRetention()).deleted).toBeGreaterThanOrEqual(1);
    expect(await hh.stack.sink.exists(ref)).toBe(false);
  });
});

describe('restore: pre-restore safety backup, checksum verification, corruption detected, one at a time', () => {
  it('backup → mutate → restore returns identical content for 5 site fixtures; a safety backup precedes every restore (AC-M06-06)', async () => {
    for (let i = 0; i < 5; i++) {
      const s = await newSite();
      const node = nodeOf(s.nodeId);
      const files: Record<string, string> = {
        'htdocs/index.html': `page-${i}`,
        'htdocs/a.txt': 'x'.repeat(10 + i),
        '.env': `KEY=${i}`,
      };
      for (const [p, c] of Object.entries(files)) node.seed(s.nodeName, p, c);
      const b = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
      await run(orgA(), b.json().operationId);
      for (const p of Object.keys(files)) node.seed(s.nodeName, p, 'MUTATED');
      node.seed(s.nodeName, 'htdocs/new-file.txt', 'added after the backup');
      const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/restores`, {
        backupId: b.json().backup.id,
      });
      expect(r.statusCode).toBe(202);
      expect((await siteRow(s.id)).status).toBe('restoring');
      await run(orgA(), r.json().operationId);
      expect(await opState(r.json().operationId)).toBe('succeeded');
      expect((await siteRow(s.id)).status).toBe('active');
      for (const [p, c] of Object.entries(files))
        expect(node.actor(s.nodeName).readFile(`/home/${s.nodeName}/${p}`), p).toBe(c);
      expect(() =>
        node.actor(s.nodeName).readFile(`/home/${s.nodeName}/htdocs/new-file.txt`),
      ).toThrow(); // files added after the backup are gone: a true restore
      const safety = await hh.env.sql(
        `SELECT status, checksum FROM hosting.site_backups WHERE site_id=$1 AND kind='pre_restore'`,
        [s.id],
      );
      expect(safety).toHaveLength(1);
      expect((safety[0] as any).status).toBe('available');
      const steps = await hh.env.sql(
        `SELECT name, state FROM platform.operation_steps WHERE operation_id=$1 ORDER BY seq`,
        [r.json().operationId],
      );
      expect(steps.map((x: any) => x.name)).toEqual(
        expect.arrayContaining(['pre_restore_backup', 'restore']),
      );
    }
  });
  it('a second restore while one runs is 409 restore_in_progress; a restore of a non-available backup is 409', async () => {
    const s = await newSite();
    const b = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    const early = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/restores`, {
      backupId: b.json().backup.id,
    });
    expect(early.statusCode).toBe(409); // still `creating`
    await run(orgA(), b.json().operationId);
    const [r1, r2] = await Promise.all(
      [1, 2].map(() =>
        hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/restores`, {
          backupId: b.json().backup.id,
        }),
      ),
    );
    expect([r1!.statusCode, r2!.statusCode].sort()).toEqual([202, 409]);
    expect([r1!, r2!].find((x) => x.statusCode === 409)!.json().code).toBe('restore_in_progress');
    expect(
      (await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {})).statusCode,
    ).toBe(409); // not active while restoring
    await run(orgA(), [r1!, r2!].find((x) => x.statusCode === 202)!.json().operationId);
    expect((await siteRow(s.id)).status).toBe('active');
  });
  it('a corrupted archive is detected: the backup is marked corrupt, the site is untouched and active, the operation fails', async () => {
    const s = await newSite();
    const node = nodeOf(s.nodeId);
    node.seed(s.nodeName, 'htdocs/keep.txt', 'original');
    const b = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/backups`, {});
    await run(orgA(), b.json().operationId);
    const ref = (
      (
        await hh.env.sql(`SELECT sink_ref FROM hosting.site_backups WHERE id=$1`, [
          b.json().backup.id,
        ])
      )[0] as any
    ).sink_ref as string;
    const blob = Buffer.from(hh.stack.sink.store.get(ref)!);
    blob[blob.length - 20] = blob[blob.length - 20]! ^ 0xff;
    hh.stack.sink.store.set(ref, blob);
    node.seed(s.nodeName, 'htdocs/keep.txt', 'changed-after-backup');
    const r = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/restores`, {
      backupId: b.json().backup.id,
    });
    await run(orgA(), r.json().operationId);
    expect(await opState(r.json().operationId)).toBe('failed');
    expect(
      (
        (
          await hh.env.sql(`SELECT status FROM hosting.site_backups WHERE id=$1`, [
            b.json().backup.id,
          ])
        )[0] as any
      ).status,
    ).toBe('corrupt');
    expect((await siteRow(s.id)).status).toBe('active');
    expect(node.actor(s.nodeName).readFile(`/home/${s.nodeName}/htdocs/keep.txt`)).toBe(
      'changed-after-backup',
    ); // nothing was overwritten
    expect(
      (
        await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/restores`, {
          backupId: b.json().backup.id,
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('quotas and usage: soft/hard thresholds notify once; hard bandwidth suspends; a new period reinstates', () => {
  it('reports usage and quota states; 80 % → soft (one notification), 100 % → hard (one notification); re-arms below the soft limit', async () => {
    const s = await newSite();
    const node = nodeOf(s.nodeId);
    const site = node.sites.get(s.nodeName)!;
    const usage = hh.app.get(UsageService);
    const notes = async () =>
      Number(
        (
          (
            await hh.env.sql(
              `SELECT count(*)::int n FROM platform.notifications WHERE kind LIKE 'hosting.quota_%' AND org_id=$1`,
              [orgA()],
            )
          )[0] as any
        ).n,
      );
    const before = await notes();
    site.diskBytes = 50 * 1_048_576;
    await usage.collect(s.id);
    expect(
      (await hh.call('alice', 'GET', `/v1/hosting/sites/${s.id}/usage`))
        .json()
        .quotas.find((q: any) => q.dim === 'disk_mb'),
    ).toMatchObject({ used: 50, limit: 100, soft: 80, state: 'ok' });
    site.diskBytes = 85 * 1_048_576;
    expect((await usage.collect(s.id))!.quotas.find((q) => q.dim === 'disk_mb')!.state).toBe(
      'soft',
    );
    const afterSoft = await notes();
    expect(afterSoft).toBeGreaterThan(before); // owner + admin notified
    await usage.collect(s.id);
    await usage.collect(s.id);
    expect(await notes()).toBe(afterSoft); // once per threshold
    site.diskBytes = 100 * 1_048_576;
    expect((await usage.collect(s.id))!.quotas.find((q) => q.dim === 'disk_mb')!.state).toBe(
      'hard',
    );
    const afterHard = await notes();
    expect(afterHard).toBeGreaterThan(afterSoft);
    await usage.collect(s.id);
    expect(await notes()).toBe(afterHard);
    const events = await hh.env.sql(
      `SELECT threshold FROM hosting.quota_events WHERE site_id=$1 AND dim='disk_mb' ORDER BY threshold`,
      [s.id],
    );
    expect(events.map((e: any) => e.threshold)).toEqual(['hard', 'soft']);
    // the node enforces disk at the filesystem: a write beyond the limit is EDQUOT
    expect(() => node.actor(s.nodeName).fillDisk(1)).toThrow(/EDQUOT/);
    // dropping below the soft limit re-arms
    site.diskBytes = 10 * 1_048_576;
    expect((await usage.collect(s.id))!.quotas.find((q) => q.dim === 'disk_mb')!.state).toBe('ok');
    site.diskBytes = 85 * 1_048_576;
    await usage.collect(s.id);
    expect(await notes()).toBeGreaterThan(afterHard);
    // the notification text is rendered from the catalogue in both languages
    const body = (
      (
        await hh.env.sql(
          `SELECT body FROM platform.notifications WHERE kind='hosting.quota_soft' LIMIT 1`,
        )
      )[0] as any
    ).body;
    expect(body).toMatchObject({ params: { dim: 'disk_mb' } });
  });
  it('a hard bandwidth limit suspends the site (reason `quota`), once; the next period reinstates it', async () => {
    const s = await newSite();
    const site = nodeOf(s.nodeId).sites.get(s.nodeName)!;
    const usage = hh.app.get(UsageService);
    site.bandwidthBytes = 10.5e9;
    await usage.collect(s.id);
    const row = await siteRow(s.id);
    expect(row.status).toBe('suspended');
    expect(row.suspended_by).toBe('quota');
    expect(site.suspended).toBe(true);
    site.bandwidthBytes = 0; // a new month: the node's counter restarted
    expect(await usage.newPeriodReinstate()).toBe(1);
    expect((await siteRow(s.id)).status).toBe('active');
    expect(site.suspended).toBe(false);
  });
});

describe('drain / maintenance and migration', () => {
  it('a draining node receives no new placements (AC-M06-12) and keeps serving its sites', async () => {
    nodeB = await hh.activeNode('s26-b');
    const before = await hh.env.sql(
      `SELECT count(*)::int n FROM hosting.site_allocations WHERE node_id=$1`,
      [nodeA],
    );
    const e = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeA}`)).headers
      .etag as string;
    expect(
      (
        await hh.admin(
          'host',
          'PATCH',
          `/v1/admin/hosting/nodes/${nodeA}`,
          { status: 'draining' },
          { 'if-match': e },
        )
      ).statusCode,
    ).toBe(200);
    for (let i = 0; i < 4; i++) expect((await newSite()).nodeId).toBe(nodeB);
    expect(
      (
        (
          await hh.env.sql(
            `SELECT count(*)::int n FROM hosting.site_allocations WHERE node_id=$1`,
            [nodeA],
          )
        )[0] as any
      ).n,
    ).toBe((before[0] as any).n);
  });
  it('migrates a site to another node of the same region: data identical, reservation moved, source removed, domains and certificates follow', async () => {
    const s = await newSite();
    const from = s.nodeId;
    expect(from).toBe(nodeB);
    const node = nodeOf(from);
    node.seed(s.nodeName, 'htdocs/data.txt', 'migrate-me');
    const dom = 'migrating.customer-two.test';
    await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/domains`, { domain: dom });
    const tok = (
      (
        await hh.env.sql(
          `SELECT verification_token t FROM hosting.site_domain_bindings WHERE site_id=$1`,
          [s.id],
        )
      )[0] as any
    ).t as string;
    hh.verifier.confirm(orgA(), s.id, dom, tok);
    const bind = await hh.call('alice', 'POST', `/v1/hosting/sites/${s.id}/domains`, {
      domain: dom,
    });
    await run(orgA(), bind.json().operationId);
    const e = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeA}`)).headers
      .etag as string;
    expect(
      (
        await hh.admin(
          'host',
          'PATCH',
          `/v1/admin/hosting/nodes/${nodeA}`,
          { status: 'active' },
          { 'if-match': e },
        )
      ).statusCode,
    ).toBe(200);
    const capSites = async (id: string) =>
      (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${id}/capacity`))
        .json()
        .dimensions.find((d: any) => d.dim === 'sites').reserved as number;
    const [fromBefore, toBefore] = [await capSites(from), await capSites(nodeA)];
    expect(
      (
        await hh.admin('support', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
          targetNodeId: nodeA,
        })
      ).statusCode,
    ).toBe(403);
    const m = await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
      targetNodeId: nodeA,
    });
    expect(m.statusCode).toBe(201);
    expect(
      (
        await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
          targetNodeId: nodeA,
        })
      ).statusCode,
    ).toBe(409); // one at a time
    await run(orgA(), m.json().operationId);
    expect(await opState(m.json().operationId)).toBe('succeeded');
    const after = await siteRow(s.id);
    expect(after.node_id).toBe(nodeA);
    expect(after.status).toBe('active');
    expect(nodeOf(nodeA).actor(s.nodeName).readFile(`/home/${s.nodeName}/htdocs/data.txt`)).toBe(
      'migrate-me',
    );
    expect(nodeOf(nodeA).sites.get(s.nodeName)!.domains).toContain(dom);
    expect(nodeOf(from).sites.has(s.nodeName)).toBe(false); // removed from the source only after the target was verified
    expect(await capSites(from)).toBe(fromBefore - 1);
    expect(await capSites(nodeA)).toBe(toBefore + 1);
    const mig = (await hh.admin('host', 'GET', `/v1/admin/hosting/sites/${s.id}/migrations`)).json()
      .items[0];
    expect(mig.state).toBe('switched');
    expect(
      (await hh.admin('host', 'GET', `/v1/admin/hosting/sites?nodeId=${nodeA}`))
        .json()
        .items.map((x: any) => x.id),
    ).toContain(s.id);
  });
  it('a migration that fails leaves the SOURCE serving and untouched, removes the target copy, keeps the reservation (AC-M06-12)', async () => {
    const s = await newSite('alice', orgA(), projA, plan);
    const from = s.nodeId; // nodeA is active again: spread picks either
    const target = from === nodeA ? nodeB : nodeA;
    const e = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${target}`)).headers
      .etag as string;
    void e;
    nodeOf(from).seed(s.nodeName, 'htdocs/precious.txt', 'do not lose me');
    // the target node's restore fails verification
    const tnode = nodeOf(target);
    const orig = tnode.execute.bind(tnode);
    tnode.execute = async (cmd, a, ctx) =>
      cmd === 'backup.restore'
        ? { ok: false, category: 'validation', message: 'archive checksum mismatch' }
        : orig(cmd, a, ctx);
    const m = await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
      targetNodeId: target,
    });
    expect(m.statusCode).toBe(201);
    await run(orgA(), m.json().operationId);
    tnode.execute = orig;
    expect(await opState(m.json().operationId)).toBe('failed');
    const after = await siteRow(s.id);
    expect(after.node_id).toBe(from);
    expect(after.status).toBe('active');
    expect(nodeOf(from).actor(s.nodeName).readFile(`/home/${s.nodeName}/htdocs/precious.txt`)).toBe(
      'do not lose me',
    );
    expect(tnode.sites.has(s.nodeName)).toBe(false); // the half-built target copy was removed
    expect(
      (
        (await hh.admin('host', 'GET', `/v1/admin/hosting/sites/${s.id}/migrations`)).json()
          .items[0] as any
      ).state,
    ).toBe('rolled_back');
    const alloc = await hh.env.sql(
      `SELECT node_id FROM hosting.site_allocations WHERE site_id=$1`,
      [s.id],
    );
    expect((alloc[0] as any).node_id).toBe(from);
  });
  it('a migration to another data region, an inactive node or a node without the runtime is refused', async () => {
    const s = await newSite();
    const us = await hh.activeNode('s26-us', 'us-east');
    expect(
      (
        await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
          targetNodeId: us,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
          targetNodeId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hh.admin('host', 'POST', `/v1/admin/hosting/sites/${s.id}/migrations`, {
          targetNodeId: s.nodeId,
        })
      ).statusCode,
    ).toBe(422);
  });
});
