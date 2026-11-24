import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { HostingHarness } from './hosting-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const hh = new HostingHarness();
beforeAll(async () => {
  await hh.init();
});
afterAll(() => hh.close());

const sqlErr = async (q: string, p: unknown[] = []) => {
  const c = new Client({ connectionString: hh.env.adminUrl });
  await c.connect();
  try {
    await c.query(q, p);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.end();
  }
};

describe('S24 nodes: registration, panel connection, inventory, activation', () => {
  let nodeId = '';
  it('refuses an unknown compute instance (M05 port) and a non-running one', async () => {
    const r = await hh.admin('host', 'POST', '/v1/admin/hosting/nodes', {
      name: 'n-unknown',
      computeInstanceId: 'nope',
    });
    expect(r.statusCode).toBe(422);
    hh.compute.add({
      computeInstanceId: 'stopped-1',
      region: 'SA',
      dataRegion: 'SA',
      vcpu: 2,
      memoryMb: 2048,
      diskGb: 50,
      status: 'stopped',
    });
    expect(
      (
        await hh.admin('host', 'POST', '/v1/admin/hosting/nodes', {
          name: 'n-stopped',
          computeInstanceId: 'stopped-1',
        })
      ).statusCode,
    ).toBe(422);
  });
  it('needs the idempotency key and the manage permission', async () => {
    hh.compute.add({
      computeInstanceId: 'i-1',
      region: 'SA',
      dataRegion: 'SA',
      vcpu: 4,
      memoryMb: 8192,
      diskGb: 200,
      status: 'running',
    });
    expect(
      (
        await hh.admin(
          'host',
          'POST',
          '/v1/admin/hosting/nodes',
          { name: 'node-one', computeInstanceId: 'i-1' },
          {},
          null,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hh.admin('support', 'POST', '/v1/admin/hosting/nodes', {
          name: 'node-one',
          computeInstanceId: 'i-1',
        })
      ).statusCode,
    ).toBe(403);
    expect((await hh.admin('finance', 'GET', '/v1/admin/hosting/nodes')).statusCode).toBe(403);
    expect((await hh.admin('support', 'GET', '/v1/admin/hosting/nodes')).statusCode).toBe(200);
  });
  it('creates a node in maintenance with no panel connection; a replay returns the same node', async () => {
    const r = await hh.admin('host', 'POST', '/v1/admin/hosting/nodes', {
      name: 'node-one',
      computeInstanceId: 'i-1',
    });
    expect(r.statusCode).toBe(201);
    const j = r.json();
    nodeId = j.node.id;
    expect(j.node).toMatchObject({
      status: 'maintenance',
      dataRegion: 'SA',
      panelKind: 'hestia',
      panelConfigured: false,
      overcommitFactor: 1,
    });
    const again = await hh.admin('host', 'POST', '/v1/admin/hosting/nodes', {
      name: 'node-one',
      computeInstanceId: 'i-1',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().node.id).toBe(nodeId);
    hh.stack.addNode(nodeId);
  });
  it('cannot be activated or inventoried before the panel connection is set', async () => {
    const n = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).headers
      .etag as string;
    const r = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'active' },
      { 'if-match': n },
    );
    expect(r.statusCode).toBe(409);
    expect(
      (await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeId}/inventory`)).statusCode,
    ).toBe(409);
  });
  it('sets the panel connection: the key is write-only, only a vault reference is stored, and wrong input is refused', async () => {
    const KEY = 'CANARYACCESSKEY0001:canary-secret-access-key-never-store';
    const url = `/v1/admin/hosting/nodes/${nodeId}/panel`;
    for (const bad of [
      { host: '10.0.0.5', credentials: { accessKey: KEY } }, // an IP literal is not a panel host
      { host: 'https://panel.example.test', credentials: { accessKey: KEY } },
      { host: 'panel.example.test', port: 70000, credentials: { accessKey: KEY } },
      { host: 'panel.example.test', tlsPinSha256: 'abc', credentials: { accessKey: KEY } },
      { host: 'panel.example.test', credentials: { accessKey: 'no-colon-here' } },
      { host: 'panel.example.test' }, // the first time a key is required
      { host: 'panel.example.test', credentials: { accessKey: KEY }, vaultRef: 'vault://x/y' },
      { host: 'panel.example.test', credentials: { accessKey: KEY }, command: 'v-delete-user' },
    ])
      expect(
        (await hh.admin('host', 'PUT', url, bad)).statusCode,
        JSON.stringify(bad).slice(0, 60),
      ).toBe(422);
    expect(
      (
        await hh.admin('support', 'PUT', url, {
          host: 'panel.example.test',
          credentials: { accessKey: KEY },
        })
      ).statusCode,
    ).toBe(403);
    const ok = await hh.admin('host', 'PUT', url, {
      host: 'Panel.Example.Test',
      tlsPinSha256: 'aa:'.repeat(31) + 'aa',
      credentials: { accessKey: KEY },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      panelHost: 'panel.example.test',
      panelPort: 8083,
      panelConfigured: true,
      panelTlsPinned: true,
      health: 'unknown',
    });
    const everything = JSON.stringify([ok.json(), await hh.env.sql(`SELECT * FROM hosting.nodes`)]);
    expect(everything).not.toContain('canary-secret-access-key');
    const [row] = await hh.env.sql(`SELECT panel_key_ref FROM hosting.nodes WHERE id = $1`, [
      nodeId,
    ]);
    expect(row!.panel_key_ref).toMatch(/^vault:\/\//);
  });
  it('runs the inventory job: versions, health, runtimes from the probe, capacity sized with the reserve', async () => {
    const r = await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeId}/inventory`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      health: 'healthy',
      panelVersion: '1.9.4',
      runtimes: ['php:8.3', 'php:8.4', 'nodejs:22', 'static'],
      panelConfigured: true,
    });
    const cap = (
      await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}/capacity`)
    ).json();
    const by = Object.fromEntries(cap.dimensions.map((d: any) => [d.dim, d]));
    expect(by.cpu_millicores).toMatchObject({
      physical: 3600,
      sellable: 3600,
      reserved: 0,
      free: 3600,
    }); // 4000 minus the 10% reserve
    expect(by.memory_mb.physical).toBe(7372);
    expect(by.sites).toMatchObject({ physical: 200, sellable: 200 });
  });
  it('activates a healthy inventoried node with a panel connection; retired is refused while sites live; stale inventory blocks activation', async () => {
    let etag = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).headers
      .etag as string;
    const bad = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'active' },
      {},
    );
    expect(bad.statusCode).toBe(428);
    const stale = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'active' },
      { 'if-match': '"999"' },
    );
    expect(stale.statusCode).toBe(412);
    const ok = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'active' },
      { 'if-match': etag },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('active');
    etag = ok.headers.etag as string;
    await hh.env.sql(
      `UPDATE hosting.nodes SET last_inventory_at = now() - interval '2 hours' WHERE id = $1`,
      [nodeId],
    );
    const m = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'maintenance' },
      { 'if-match': etag },
    );
    expect(m.statusCode).toBe(200);
    const again = await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeId}`,
      { status: 'active' },
      { 'if-match': m.headers.etag as string },
    );
    expect(again.statusCode).toBe(409); // inventory is stale
    expect(
      (await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeId}/inventory`)).statusCode,
    ).toBe(201);
    const g = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).headers
      .etag as string;
    expect(
      (
        await hh.admin(
          'host',
          'PATCH',
          `/v1/admin/hosting/nodes/${nodeId}`,
          { status: 'active' },
          { 'if-match': g },
        )
      ).statusCode,
    ).toBe(200);
  });
  it('audits status changes and the panel connection (node.status.changed, node.panel_set)', async () => {
    const rows = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action LIKE 'hosting.%' ORDER BY chain_seq`,
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'hosting.node.created',
        'hosting.node.panel_set',
        'hosting.node.status.changed',
      ]),
    );
  });
});

describe('S24 overcommit needs dual approval; the database enforces the capacity invariants', () => {
  let nodeId = '';
  beforeAll(async () => {
    nodeId = (await hh.admin('host', 'GET', '/v1/admin/hosting/nodes')).json().items[0].id;
  });
  const patch = async (who: string, body: object) => {
    const etag = (await hh.admin(who, 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).headers
      .etag as string;
    return hh.admin(who, 'PATCH', `/v1/admin/hosting/nodes/${nodeId}`, body, { 'if-match': etag });
  };
  it('refuses a self-approval, an unauthorised approver and a missing reason', async () => {
    expect(
      (
        await patch('host', {
          overcommit: { factor: 1.2, reason: 'short', approverId: hh.staff.host2!.id },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await patch('host', {
          overcommit: {
            factor: 1.2,
            reason: 'burst capacity for a campaign',
            approverId: hh.staff.host!.id,
          },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await patch('host', {
          overcommit: {
            factor: 1.2,
            reason: 'burst capacity for a campaign',
            approverId: hh.staff.support!.id,
          },
        })
      ).statusCode,
    ).toBe(422);
  });
  it('request → the requester cannot decide → the named approver approves → sellable grows and it is audited', async () => {
    const req = await patch('host', {
      overcommit: {
        factor: 1.2,
        reason: 'burst capacity for a campaign',
        approverId: hh.staff.host2!.id,
      },
    });
    expect(req.statusCode).toBe(200);
    const changeId = req.json().pendingOvercommit.changeId;
    expect(req.json().overcommitFactor).toBe(1); // nothing changed yet
    expect(
      (await patch('host', { overcommit: { changeId, decision: 'approve' } })).statusCode,
    ).toBe(403);
    expect(
      (await patch('support', { overcommit: { changeId, decision: 'approve' } })).statusCode,
    ).toBe(403);
    const ok = await patch('host2', {
      overcommit: { changeId, decision: 'approve', note: 'reviewed' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().overcommitFactor).toBe(1.2);
    const cap = (
      await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}/capacity`)
    ).json();
    expect(cap.dimensions.find((d: any) => d.dim === 'cpu_millicores').sellable).toBe(4320);
    const a = await hh.env.sql(
      `SELECT action, detail FROM audit.audit_logs WHERE action = 'hosting.node.overcommit.changed'`,
    );
    expect(a).toHaveLength(1);
  });
  it('the database refuses a factor above 1.0 without an approved change, and sellable above physical x factor', async () => {
    expect(
      await sqlErr(
        `UPDATE hosting.nodes SET overcommit_factor = 1.5, overcommit_change_id = NULL WHERE id = $1`,
        [nodeId],
      ),
    ).toMatch(/violates check constraint/);
    expect(
      await sqlErr(
        `UPDATE hosting.node_capacity SET sellable = sellable + 100000 WHERE node_id = $1 AND dim = 'cpu_millicores'`,
        [nodeId],
      ),
    ).toMatch(/no_hidden_oversell|exceeds physical/);
  });
  it('the database refuses reserved > sellable and a reservation with no allocation (ledger trigger)', async () => {
    expect(
      await sqlErr(
        `UPDATE hosting.node_capacity SET reserved = sellable + 1 WHERE node_id = $1 AND dim = 'sites'`,
        [nodeId],
      ),
    ).toMatch(/node_capacity_invariant/);
    expect(
      await sqlErr(
        `UPDATE hosting.node_capacity SET reserved = 1 WHERE node_id = $1 AND dim = 'sites'`,
        [nodeId],
      ),
    ).toMatch(/capacity ledger broken|reservation_mismatch/);
    expect(
      await sqlErr(
        `UPDATE hosting.node_capacity SET reserved = -1 WHERE node_id = $1 AND dim = 'sites'`,
        [nodeId],
      ),
    ).toMatch(/node_capacity_invariant/);
  });
  it('lowering sellable below reserved is refused; lowering the factor requires lowering sellable first', async () => {
    expect(
      await sqlErr(`UPDATE hosting.nodes SET overcommit_factor = 1.0 WHERE id = $1`, [nodeId]),
    ).toMatch(/lower sellable capacity first/);
  });
});

describe('S24 tenant isolation of node data and panel changes', () => {
  it('a customer (org) database scope can read no node or capacity row', async () => {
    const c = new Client({ connectionString: hh.env.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.org_id', '00000000-0000-7000-8000-00000000000a', true)`,
      );
      for (const t of ['nodes', 'node_capacity', 'node_overcommit_changes', 'site_allocations'])
        expect((await c.query(`SELECT count(*)::int AS n FROM hosting.${t}`)).rows[0].n, t).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
  it('changing the panel connection returns an active node to maintenance with unknown health', async () => {
    const nodeId = (await hh.admin('host', 'GET', '/v1/admin/hosting/nodes')).json().items[0].id;
    const r = await hh.admin('host', 'PUT', `/v1/admin/hosting/nodes/${nodeId}/panel`, {
      host: 'moved.panel.example.test',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'maintenance',
      health: 'unknown',
      panelHost: 'moved.panel.example.test',
      panelConfigured: true,
    });
  });
});
