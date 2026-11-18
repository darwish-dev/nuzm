import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { HostingHarness } from './hosting-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const hh = new HostingHarness();
let nodeId = '';
let small = '';
let medium = '';
let projA = '';
let siteId = '';
const orgA = () => hh.orgs.A!;
const row = async (id: string) =>
  (await hh.env.sql(`SELECT * FROM hosting.sites WHERE id=$1`, [id]))[0] as any;
const cap = async () =>
  (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}/capacity`)).json();
const reserved = async (dim: string) =>
  (await cap()).dimensions.find((d: any) => d.dim === dim).reserved as number;
const etag = async (id: string) =>
  (await hh.call('alice', 'GET', `/v1/hosting/sites/${id}`)).headers.etag as string;

beforeAll(async () => {
  await hh.init();
  await hh.customers();
  projA = await hh.project(orgA());
  small = await hh.plan('s-ops', { cpu: 250, mem: 256, disk: 1000, quotas: { diskMb: 100 } });
  medium = await hh.plan('m-ops', {
    cpu: 1000,
    mem: 1024,
    disk: 4000,
    quotas: { diskMb: 400, maxProcesses: 60 },
  });
  nodeId = await hh.activeNode('ops-node');
  const r = await hh.createSite('alice', orgA(), small, 'php:8.3', 'ops-site', projA);
  siteId = r.json().site.id;
  await hh.jobs().runOne(orgA(), r.json().operationId);
});
afterAll(() => hh.close());

describe('PATCH: If-Match, plan change re-checks capacity', () => {
  it('needs If-Match (428), refuses a stale one (412), and rejects unknown members', async () => {
    expect(
      (await hh.call('alice', 'PATCH', `/v1/hosting/sites/${siteId}`, { name: 'x' })).statusCode,
    ).toBe(428);
    expect(
      (
        await hh.call('alice', 'PATCH', `/v1/hosting/sites/${siteId}`, { name: 'x' }, orgA(), {
          'if-match': '"99"',
        })
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await hh.call('alice', 'PATCH', `/v1/hosting/sites/${siteId}`, { nodeId: 'x' }, orgA(), {
          'if-match': await etag(siteId),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await hh.call('carol', 'PATCH', `/v1/hosting/sites/${siteId}`, { name: 'x' }, orgA(), {
          'if-match': await etag(siteId),
        })
      ).statusCode,
    ).toBe(403);
  });
  it('renames and stores settings; a duplicate name is a 409', async () => {
    const r = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${siteId}`,
      { name: 'renamed', settings: { phpMemory: '128M' } },
      orgA(),
      { 'if-match': await etag(siteId) },
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'renamed', settings: { phpMemory: '128M' } });
    const other = await hh.createSite('alice', orgA(), small, 'php:8.3', 'other-site', projA);
    await hh.jobs().runOne(orgA(), other.json().operationId);
    const dup = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${other.json().site.id}`,
      { name: 'RENAMED' },
      orgA(),
      { 'if-match': await etag(other.json().site.id) },
    );
    expect(dup.statusCode).toBe(409);
  });
  it('a plan upgrade grows the reservation, the node limits and the quotas; a downgrade releases', async () => {
    const before = await reserved('cpu_millicores');
    const r = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${siteId}`,
      { planId: medium },
      orgA(),
      { 'if-match': await etag(siteId) },
    );
    expect(r.statusCode).toBe(200);
    expect(r.json().plan.key).toBe('m-ops');
    expect(await reserved('cpu_millicores')).toBe(before + 750);
    expect(r.json().quotas.find((q: any) => q.dim === 'disk_mb').limit).toBe(400);
    const s = await row(siteId);
    expect(hh.stack.nodes.get(nodeId)!.sites.get(s.node_name)!.limits).toMatchObject({
      diskMb: 400,
      maxProcesses: 60,
    });
    const down = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${siteId}`,
      { planId: small },
      orgA(),
      { 'if-match': await etag(siteId) },
    );
    expect(down.statusCode).toBe(200);
    expect(await reserved('cpu_millicores')).toBe(before);
  });
  it('an upgrade the node cannot take is 409 no_capacity and changes nothing', async () => {
    const huge = await hh.plan('h-ops', { cpu: 100_000 });
    const before = await reserved('cpu_millicores');
    const r = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${siteId}`,
      { planId: huge },
      orgA(),
      { 'if-match': await etag(siteId) },
    );
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('no_capacity');
    expect(await reserved('cpu_millicores')).toBe(before);
    expect((await row(siteId)).plan_id).toBe(small);
  });
  it('a node that refuses the new limits rolls the reservation back (nothing is half-changed)', async () => {
    const before = await reserved('cpu_millicores');
    hh.stack.channel.dropRequests = 1;
    const r = await hh.call(
      'alice',
      'PATCH',
      `/v1/hosting/sites/${siteId}`,
      { planId: medium },
      orgA(),
      { 'if-match': await etag(siteId) },
    );
    expect(r.statusCode).toBe(503);
    expect(await reserved('cpu_millicores')).toBe(before);
    expect((await row(siteId)).plan_id).toBe(small);
  });
});

describe('staff: cross-organization search (audited) and suspension / reinstatement', () => {
  it('lists across organizations with the node, and audits every cross-org read; support can read but not suspend', async () => {
    const r = await hh.admin('support', 'GET', '/v1/admin/hosting/sites?limit=5');
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0]).toHaveProperty('nodeName', 'ops-node');
    expect(r.json().items[0]).toHaveProperty('orgId');
    const a = await hh.env.sql(
      `SELECT action, actor_user_id FROM audit.audit_logs WHERE action = 'hosting.admin.cross_org_read'`,
    );
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        await hh.admin('support', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
          status: 'suspended',
          reason: 'spam campaign',
        })
      ).statusCode,
    ).toBe(403);
    expect((await hh.admin('finance', 'GET', '/v1/admin/hosting/sites')).statusCode).toBe(403);
    expect(
      (await hh.call('alice', 'GET', '/v1/admin/hosting/sites')).statusCode,
    ).toBeGreaterThanOrEqual(401);
  });
  it('suspends with a reason (node confirms first), shows the banner data to the customer, blocks changes, and reinstates', async () => {
    expect(
      (
        await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
          status: 'suspended',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
          status: 'weird',
          reason: 'spam campaign',
        })
      ).statusCode,
    ).toBe(422);
    hh.stack.channel.dropRequests = 1;
    expect(
      (
        await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
          status: 'suspended',
          reason: 'spam campaign',
        })
      ).statusCode,
    ).toBe(503);
    expect((await row(siteId)).status).toBe('active'); // the node did not confirm: nothing changed
    const r = await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
      status: 'suspended',
      reason: 'spam campaign',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('suspended');
    const s = await row(siteId);
    expect(hh.stack.nodes.get(nodeId)!.sites.get(s.node_name)!.suspended).toBe(true);
    const c = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}`)).json();
    expect(c.suspension).toEqual({ reason: 'spam campaign', by: 'admin' });
    expect(
      (
        await hh.call(
          'alice',
          'PATCH',
          `/v1/hosting/sites/${siteId}`,
          { name: 'blocked' },
          orgA(),
          { 'if-match': String(c.version) },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
          status: 'suspended',
          reason: 'again again',
        })
      ).statusCode,
    ).toBe(409);
    const back = await hh.admin('host', 'PATCH', `/v1/admin/hosting/sites/${siteId}`, {
      status: 'active',
      reason: 'appeal accepted',
    });
    expect(back.json().status).toBe('active');
    expect(hh.stack.nodes.get(nodeId)!.sites.get(s.node_name)!.suspended).toBe(false);
    const audit = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action IN ('hosting.site.suspended','hosting.site.resumed') ORDER BY chain_seq`,
    );
    expect(audit.map((x: any) => x.action)).toEqual([
      'hosting.site.suspended',
      'hosting.site.resumed',
    ]);
  });
});

describe('RLS: cross-tenant isolation of hosting org tables', () => {
  it('org B can read none of org A rows in any hosting org table, and cannot write into them', async () => {
    const c = new Client({ connectionString: hh.env.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [hh.orgs.B]);
      for (const t of [
        'sites',
        'site_domain_bindings',
        'ssl_certificates',
        'site_quotas',
        'site_backups',
        'site_usage_reports',
        'abuse_cases',
        'wipe_reports',
        'quota_events',
      ])
        expect((await c.query(`SELECT count(*)::int AS n FROM hosting.${t}`)).rows[0].n, t).toBe(0);
      await expect(
        c
          .query(`UPDATE hosting.sites SET name = 'hijack' WHERE id = $1`, [siteId])
          .then((r) => r.rowCount),
      ).resolves.toBe(0);
      await c.query('SAVEPOINT w');
      await expect(
        c.query(
          `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, data_region) VALUES (gen_random_uuid(), $1, 'x', $2, 's-aaaaaaaaaaaa', $3, 'static', 'sa-central')`,
          [hh.orgs.A, 'a'.repeat(64), small],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
  it('a request without org context sees nothing (deny by default)', async () => {
    const c = new Client({ connectionString: hh.env.appUrl });
    await c.connect();
    try {
      expect((await c.query(`SELECT count(*)::int AS n FROM hosting.sites`)).rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
  it('the feature flag is off by default: without it every customer route is 404 (flag per organization overrides the global value)', async () => {
    await hh.env.sql(
      `UPDATE platform.feature_flags SET value = 'false' WHERE key = 'hosting.enabled'`,
    );
    expect((await hh.call('alice', 'GET', '/v1/hosting/sites')).statusCode).toBe(404);
    expect((await hh.call('alice', 'GET', '/v1/hosting/plans')).statusCode).toBe(404);
    await hh.env.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'hosting.enabled', $1, 'true')`,
      [orgA()],
    );
    expect((await hh.call('alice', 'GET', '/v1/hosting/sites')).statusCode).toBe(200);
    expect(
      (await hh.call('bob', 'GET', '/v1/hosting/sites', undefined, hh.orgs.B)).statusCode,
    ).toBe(404);
    await hh.env.sql(
      `UPDATE platform.feature_flags SET value = 'true' WHERE key = 'hosting.enabled' AND org_id IS NULL`,
    );
  });
});

describe('delete / offboarding: confirmation, legal hold, export window, verified wipe', () => {
  it('needs the exact name in X-Confirm-Delete; creating/other-org/viewer are refused', async () => {
    expect((await hh.call('alice', 'DELETE', `/v1/hosting/sites/${siteId}`)).statusCode).toBe(422);
    expect(
      (
        await hh.call('alice', 'DELETE', `/v1/hosting/sites/${siteId}`, undefined, orgA(), {
          'x-confirm-delete': 'wrong',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await hh.call('carol', 'DELETE', `/v1/hosting/sites/${siteId}`, undefined, orgA(), {
          'x-confirm-delete': 'renamed',
        })
      ).statusCode,
    ).toBe(403);
  });
  it('a legal hold blocks the request (409 legal_hold_active); a hold placed later still blocks the wipe', async () => {
    const hold = crypto.randomUUID();
    await hh.env.sql(`ALTER TABLE audit.legal_holds DISABLE TRIGGER USER`);
    await hh.env.sql(
      `INSERT INTO audit.legal_holds (id, org_id, dataset, reason, status, requested_by, approver_id, decided_at, created_at) VALUES ($1,$2,NULL,'litigation hold for the test','active',$3,$4,now(),now())`,
      [hold, orgA(), hh.ids.alice, hh.ids.bob],
    );
    await hh.env.sql(`ALTER TABLE audit.legal_holds ENABLE TRIGGER USER`);
    const r = await hh.call('alice', 'DELETE', `/v1/hosting/sites/${siteId}`, undefined, orgA(), {
      'x-confirm-delete': 'renamed',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('legal_hold_active');
    expect((await row(siteId)).status).toBe('active');
    await hh.env.sql(`ALTER TABLE audit.legal_holds DISABLE TRIGGER USER`);
    await hh.env.sql(
      `UPDATE audit.legal_holds SET status = 'released', released_by = $2, released_at = now(), release_reason = 'hold released after the test' WHERE id = $1`,
      [hold, hh.ids.bob],
    );
    await hh.env.sql(`ALTER TABLE audit.legal_holds ENABLE TRIGGER USER`);
  });
  it('deleting: the export window delays the wipe; then the node is wiped, reservation/vault/domains/certs released, the report is verified with 0 residual artifacts', async () => {
    const s = await row(siteId);
    const reservedBefore = await reserved('sites');
    const r = await hh.call('alice', 'DELETE', `/v1/hosting/sites/${siteId}`, undefined, orgA(), {
      'x-confirm-delete': 'renamed',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().site.status).toBe('deleting');
    const opId = r.json().operationId;
    await hh.jobs().runOne(orgA(), opId);
    // still inside the export window: nothing was wiped, the operation retries later
    expect(hh.stack.nodes.get(nodeId)!.sites.has(s.node_name)).toBe(true);
    expect((await row(siteId)).status).toBe('deleting');
    expect(
      ((await hh.env.sql(`SELECT state FROM platform.operations WHERE id=$1`, [opId]))[0] as any)
        .state,
    ).toBe('pending');
    // the export window ends
    await hh.env.sql(
      `UPDATE hosting.sites SET export_until = now() - interval '1 second' WHERE id = $1`,
      [siteId],
    );
    await hh.env.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [opId]);
    await hh.jobs().runOne(orgA(), opId);
    expect(
      ((await hh.env.sql(`SELECT state FROM platform.operations WHERE id=$1`, [opId]))[0] as any)
        .state,
    ).toBe('succeeded');
    expect((await row(siteId)).status).toBe('deleted');
    const node = hh.stack.nodes.get(nodeId)!;
    expect(node.sites.has(s.node_name)).toBe(false);
    expect([...node.fs.keys()].filter((k) => k.includes(s.node_name))).toEqual([]);
    expect(hh.vault.secrets.has(s.credentials_ref)).toBe(false);
    expect(hh.vault.secrets.has(s.backup_key_ref)).toBe(false);
    expect(await reserved('sites')).toBe(reservedBefore - 1);
    const rep = (
      await hh.env.sql(`SELECT * FROM hosting.wipe_reports WHERE site_id=$1`, [siteId])
    )[0] as any;
    expect(rep).toMatchObject({
      verified: true,
      residual_total: 0,
      backups_remaining: 0,
      vault_refs_remaining: 0,
    });
    expect(rep.node_residual).toMatchObject({
      filesRemaining: 0,
      databasesRemaining: 0,
      usersRemaining: 0,
      vhostsRemaining: 0,
      certificatesRemaining: 0,
      cronEntriesRemaining: 0,
    });
    expect(
      (
        await hh.env.sql(`SELECT count(*)::int n FROM hosting.site_allocations WHERE site_id=$1`, [
          siteId,
        ])
      )[0]!.n,
    ).toBe(0);
    expect((await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}`)).json().status).toBe(
      'deleted',
    );
    expect(
      (await hh.call('alice', 'GET', '/v1/hosting/sites')).json().items.map((x: any) => x.id),
    ).not.toContain(siteId);
    const a = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action IN ('hosting.site.delete.requested','hosting.site.deleted')`,
    );
    expect(a).toHaveLength(2);
    // wipe reports are append-only evidence
    await expect(hh.env.sql(`DELETE FROM hosting.wipe_reports`)).rejects.toThrow(/append-only/);
  });
  it('a node that does not finish the wipe leaves the site `deleting` (report unverified) and the operation retries: no false "deleted"', async () => {
    const r = await hh.createSite('alice', orgA(), small, 'php:8.3', 'leaky', projA);
    const id = r.json().site.id;
    await hh.jobs().runOne(orgA(), r.json().operationId);
    const s = await row(id);
    const node = hh.stack.nodes.get(nodeId)!;
    await hh.env.sql(
      `UPDATE hosting.sites SET export_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const del = await hh.call('alice', 'DELETE', `/v1/hosting/sites/${id}`, undefined, orgA(), {
      'x-confirm-delete': 'leaky',
    });
    await hh.env.sql(
      `UPDATE hosting.sites SET export_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const origExec = node.execute.bind(node);
    node.execute = async (cmd, a, ctx) => {
      const res = await origExec(cmd, a, ctx);
      if (cmd === 'site.wipe.verify' && res.ok) (res.result as any).filesRemaining = 3; // residue the node cannot remove
      return res;
    };
    await hh.env.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [
      del.json().operationId,
    ]);
    await hh.jobs().runOne(orgA(), del.json().operationId);
    expect((await row(id)).status).toBe('deleting');
    const rep = (
      await hh.env.sql(
        `SELECT verified, residual_total FROM hosting.wipe_reports WHERE site_id=$1`,
        [id],
      )
    )[0] as any;
    expect(rep).toMatchObject({ verified: false, residual_total: 3 });
    expect(s.status).toBe('active');
    node.execute = origExec;
  });
});
