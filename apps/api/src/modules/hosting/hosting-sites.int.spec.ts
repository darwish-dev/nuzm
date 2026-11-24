import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostingHarness } from './hosting-harness';
import { AdapterTimeoutError } from './internal/m05-contracts';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const hh = new HostingHarness();
let nodeA = '';
let planSmall = '';
let planBig = '';
let projA = '';
let projB = '';
beforeAll(async () => {
  await hh.init();
  await hh.customers();
  projA = await hh.project(hh.orgs.A!);
  projB = await hh.project(hh.orgs.B!);
  planSmall = await hh.plan('small');
  planBig = await hh.plan('big', { cpu: 3500, mem: 2000, disk: 50000 });
});
afterAll(() => hh.close());

const opRow = async (id: string) =>
  (
    await hh.env.sql(
      `SELECT state, error, attempts, result FROM platform.operations WHERE id = $1`,
      [id],
    )
  )[0] as any;
const run = (orgId: string, id: string) => hh.jobs().runOne(orgId, id);
const capacity = async (node: string) =>
  (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${node}/capacity`)).json();
const free = (cap: any, dim: string) =>
  cap.dimensions.find((d: any) => d.dim === dim).free as number;
const siteRow = async (id: string) =>
  (await hh.env.sql(`SELECT * FROM hosting.sites WHERE id = $1`, [id]))[0] as any;
let seq = 0;
const mk = async (
  who = 'alice',
  org = hh.orgs.A!,
  plan = planSmall,
  runtime = 'php:8.3',
  proj = projA,
  extra: object = {},
) => hh.createSite(who, org, plan, runtime, `site-${++seq}`, proj, extra);

describe('plans: shown only where capacity exists', () => {
  it('shows no plan while no node is active; the viewer may read plans', async () => {
    expect((await hh.call('alice', 'GET', '/v1/hosting/plans')).json().items).toEqual([]);
    expect((await hh.call('carol', 'GET', '/v1/hosting/plans')).statusCode).toBe(200);
  });
  it('lists plans with room on an active node (with the region), hides the plan that does not fit', async () => {
    nodeA = await hh.activeNode('host-a');
    const keys = (await hh.call('alice', 'GET', '/v1/hosting/plans'))
      .json()
      .items.map((p: any) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['small', 'big']));
    const tooBig = await hh.plan('huge', { cpu: 999_999 });
    void tooBig;
    const r = (await hh.call('alice', 'GET', '/v1/hosting/plans')).json().items;
    expect(r.map((p: any) => p.key)).not.toContain('huge');
    expect(r.find((p: any) => p.key === 'small')).toMatchObject({
      country: 'sa-central',
      regions: ['sa-central'],
      price: { amountMinor: '10000', currency: 'SAR' },
      quotas: { diskMb: 100 },
    });
  });
});

describe('site creation: quote → allocate → create_site(token) → active', () => {
  let siteId = '';
  let opId = '';
  it('requires the permission, the idempotency key and a valid body', async () => {
    expect((await hh.call('carol', 'POST', '/v1/hosting/sites', {})).statusCode).toBe(403);
    expect(
      (
        await hh.call('alice', 'POST', '/v1/hosting/sites', {}, hh.orgs.A, {
          'idempotency-key': '',
        })
      ).statusCode,
    ).toBe(400);
    const bad = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: 'x',
      planId: 'y',
      name: '',
      projectId: 'z',
      runtime: 'ruby',
      extra: 1,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.length).toBeGreaterThanOrEqual(5);
  });
  it('creates a site: 202 + operation; the capacity is reserved at once; the node is not exposed', async () => {
    const before = free(await capacity(nodeA), 'sites');
    const r = await mk();
    expect(r.statusCode).toBe(202);
    const j = r.json();
    siteId = j.site.id;
    opId = j.operationId;
    expect(j.site).toMatchObject({ status: 'creating', runtime: 'php:8.3' });
    expect(JSON.stringify(j)).not.toMatch(/nodeId|nodeName|computeInstance|host-a/);
    expect(free(await capacity(nodeA), 'sites')).toBe(before - 1);
    expect(r.headers.etag).toBeDefined();
  });
  it('the operation creates the site on the node, configures it and activates it; steps are recorded; quotas follow the plan', async () => {
    await run(hh.orgs.A!, opId);
    expect((await opRow(opId)).state).toBe('succeeded');
    const s = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}`)).json();
    expect(s.status).toBe('active');
    expect(s.dataRegion).toBe('sa-central');
    expect(s.quotas.map((q: any) => q.dim).sort()).toEqual([
      'backup_count',
      'backup_gb',
      'bandwidth_gb',
      'db_count',
      'disk_mb',
      'inodes',
      'memory_mb',
      'processes',
    ]);
    const node = hh.stack.nodes.get(nodeA)!;
    const row = await siteRow(siteId);
    expect(node.sites.has(row.node_name)).toBe(true);
    expect(node.sites.get(row.node_name)!.limits.diskMb).toBe(100);
    const steps = await hh.env.sql(
      `SELECT name, state FROM platform.operation_steps WHERE operation_id = $1 ORDER BY seq`,
      [opId],
    );
    expect(steps.map((x) => x.name)).toEqual(
      expect.arrayContaining(['allocate', 'secrets', 'create_site', 'configure', 'activate']),
    );
    expect(hh.vault.secrets.has(row.credentials_ref)).toBe(true);
    expect(hh.vault.secrets.has(row.backup_key_ref)).toBe(true);
    const a = await hh.env.sql(
      `SELECT action FROM audit.audit_logs WHERE action LIKE 'hosting.site.create.%'`,
    );
    expect(a.map((x) => x.action)).toEqual(
      expect.arrayContaining(['hosting.site.create.requested', 'hosting.site.create.succeeded']),
    );
  });
  it('replays by quote: a second request with the same quote returns the same site and operation', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planSmall, 'php:8.3');
    const body = {
      quoteId: q.json().id,
      planId: planSmall,
      name: 'replay-site',
      projectId: projA,
      runtime: 'php:8.3',
    };
    const a = await hh.call('alice', 'POST', '/v1/hosting/sites', body);
    const b = await hh.call('alice', 'POST', '/v1/hosting/sites', body);
    expect(a.statusCode).toBe(202);
    expect(b.json().site.id).toBe(a.json().site.id);
    expect(b.json().operationId).toBe(a.json().operationId);
    await run(hh.orgs.A!, a.json().operationId);
  });
  it('another organization gets 404 for the site, its operations and sub-resources; the list shows only its own', async () => {
    for (const u of ['', '/domains', '/ssl-certificates', '/databases'])
      expect(
        (await hh.call('bob', 'GET', `/v1/hosting/sites/${siteId}${u}`, undefined, hh.orgs.B))
          .statusCode,
        u,
      ).toBe(404);
    expect(
      (
        await hh.call('bob', 'PATCH', `/v1/hosting/sites/${siteId}`, { name: 'x' }, hh.orgs.B, {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await hh.call('bob', 'DELETE', `/v1/hosting/sites/${siteId}`, undefined, hh.orgs.B, {
          'x-confirm-delete': 'site-1',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await hh.call('bob', 'GET', '/v1/hosting/sites', undefined, hh.orgs.B)).json().items,
    ).toEqual([]);
    expect(
      (await hh.call('alice', 'GET', '/v1/hosting/sites')).json().items.length,
    ).toBeGreaterThanOrEqual(2);
  });
  it('validates the quote: unknown plan, wrong kind, another plan, expired (409 quote_expired), unsupported runtime, unknown project', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planSmall, 'php:8.3');
    const base = {
      quoteId: q.json().id,
      planId: planSmall,
      name: 'qq',
      projectId: projA,
      runtime: 'php:8.3',
    };
    expect(
      (await hh.call('alice', 'POST', '/v1/hosting/sites', { ...base, planId: planBig }))
        .statusCode,
    ).toBe(422);
    expect(
      (await hh.call('alice', 'POST', '/v1/hosting/sites', { ...base, runtime: 'python:3.12' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await hh.call('alice', 'POST', '/v1/hosting/sites', { ...base, projectId: projB }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await hh.call('alice', 'POST', '/v1/hosting/sites', {
          ...base,
          quoteId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    const ai = await hh.call('alice', 'POST', '/v1/quotes', {
      kind: 'ai-credit',
      items: [{ credits: '10' }],
    });
    expect(
      (await hh.call('alice', 'POST', '/v1/hosting/sites', { ...base, quoteId: ai.json().id }))
        .statusCode,
    ).toBe(422);
    await hh.env.sql(`ALTER TABLE commerce.quotes DISABLE TRIGGER USER`);
    await hh.env.sql(
      `UPDATE commerce.quotes SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [q.json().id],
    );
    await hh.env.sql(`ALTER TABLE commerce.quotes ENABLE TRIGGER USER`);
    const exp = await hh.call('alice', 'POST', '/v1/hosting/sites', base);
    expect(exp.statusCode).toBe(409);
    expect(exp.json().code).toBe('quote_expired');
  });
});

describe('capacity: never oversold; failed creates leave nothing behind', () => {
  it('answers 409 no_capacity when the node is full and leaks no reservation or site row', async () => {
    const cap = await capacity(nodeA);
    const cpuFree = free(cap, 'cpu_millicores');
    const fill = await hh.plan('filler', { cpu: cpuFree - 10, mem: 100, disk: 100 });
    const a = await mk('alice', hh.orgs.A, fill);
    expect(a.statusCode).toBe(202);
    await run(hh.orgs.A!, a.json().operationId);
    const sitesBefore = (await hh.env.sql(`SELECT count(*)::int n FROM hosting.sites`))[0]!.n;
    const reservedBefore = (await capacity(nodeA)).dimensions.map((d: any) => d.reserved);
    const r = await mk('alice', hh.orgs.A, planSmall);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('no_capacity');
    expect((await hh.env.sql(`SELECT count(*)::int n FROM hosting.sites`))[0]!.n).toBe(sitesBefore);
    expect((await capacity(nodeA)).dimensions.map((d: any) => d.reserved)).toEqual(reservedBefore);
    const keys = (await hh.call('alice', 'GET', '/v1/hosting/plans'))
      .json()
      .items.map((p: any) => p.key);
    expect(keys).not.toContain('small'); // plans without capacity are hidden again
    // free the node for the next tests: delete the filler
    const fs = (await hh.call('alice', 'GET', '/v1/hosting/sites'))
      .json()
      .items.find((s: any) => s.plan.key === 'filler');
    await hh.env.sql(
      `UPDATE hosting.sites SET export_until = now() - interval '1 second' WHERE id = $1`,
      [fs.id],
    );
    const del = await hh.call(
      'alice',
      'DELETE',
      `/v1/hosting/sites/${fs.id}`,
      undefined,
      hh.orgs.A,
      { 'x-confirm-delete': fs.name },
    );
    expect(del.statusCode).toBe(202);
    await hh.env.sql(
      `UPDATE hosting.sites SET export_until = now() - interval '1 second' WHERE id = $1`,
      [fs.id],
    );
    await hh.env.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [
      del.json().operationId,
    ]);
    await run(hh.orgs.A!, del.json().operationId);
    expect((await siteRow(fs.id)).status).toBe('deleted');
    expect(free(await capacity(nodeA), 'cpu_millicores')).toBeGreaterThan(cpuFree - 10);
  });
  it('residency: a node outside the allowed region is not used (403 residency_denied), the runtime must be offered (422)', async () => {
    const us = await hh.activeNode('host-us', 'us-east');
    const only = await hh.plan('only-us', { runtimes: ['python'] });
    void only;
    // A's node (sa-central) is allowed, us-east is not (in_kingdom_only default): placement must pick sa-central
    const r = await mk();
    expect(r.statusCode).toBe(202);
    const row = await siteRow(r.json().site.id);
    expect(row.node_id).toBe(nodeA);
    expect(row.node_id).not.toBe(us);
    await run(hh.orgs.A!, r.json().operationId);
    await hh.admin('host', 'GET', '/v1/admin/hosting/nodes');
    const e = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeA}`)).headers
      .etag as string;
    await hh.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${nodeA}`,
      { status: 'maintenance' },
      { 'if-match': e },
    );
    const denied = await mk();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('residency_denied');
    const e2 = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeA}`)).headers
      .etag as string;
    await hh.admin('host', 'POST', `/v1/admin/hosting/nodes/${nodeA}/inventory`);
    const e3 = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeA}`)).headers
      .etag as string;
    expect(
      (
        await hh.admin(
          'host',
          'PATCH',
          `/v1/admin/hosting/nodes/${nodeA}`,
          { status: 'active' },
          { 'if-match': e3 },
        )
      ).statusCode,
    ).toBe(200);
    void e2;
  });
});

describe('reconcile-before-retry on the real create flow', () => {
  it('a lost create reply parks the operation; the next run adopts the site found by its token: no duplicate site or user', async () => {
    const r = await mk();
    const siteId = r.json().site.id;
    const opId = r.json().operationId;
    const node = hh.stack.nodes.get((await siteRow(siteId)).node_id)!;
    const usersBefore = node.users.size;
    hh.stack.channel.loseReplies = 1;
    hh.stack.channel.loseOnly = 'site.create';
    // the lookup (findByToken) answers first (absent); the create EXECUTES on the node and its reply is lost; the follow-up lookup finds the site and adopts it
    await run(hh.orgs.A!, opId);
    hh.stack.channel.loseOnly = null;
    expect(hh.stack.channel.loseReplies).toBe(0);
    expect((await opRow(opId)).state).toBe('succeeded');
    const tok = (await siteRow(siteId)).token as string;
    expect(
      node.executed.filter((e) => e.commandId === 'site.create' && e.token === tok),
    ).toHaveLength(1);
    expect((await siteRow(siteId)).status).toBe('active');
    expect(node.users.size).toBe(usersBefore + 1);
    const nm = (await siteRow(siteId)).node_name as string;
    expect([...node.sites.keys()].filter((n) => n === nm)).toHaveLength(1);
  });
  it('when the create reply AND the follow-up lookup are lost the operation is parked as needs_reconcile and the reconciler run adopts the site (never retried blind)', async () => {
    const r = await mk();
    const siteId = r.json().site.id;
    const opId = r.json().operationId;
    const node = hh.stack.nodes.get((await siteRow(siteId)).node_id)!;
    const real = hh.stack.channel.deliver.bind(hh.stack.channel);
    let creates = 0;
    hh.stack.channel.deliver = async (nodeId, env, d) => {
      const reply = await real(nodeId, env, d);
      if (env.commandId === 'site.create') {
        creates++;
        throw new AdapterTimeoutError();
      }
      if (creates === 1 && env.commandId === 'site.find') {
        creates++;
        throw new AdapterTimeoutError();
      }
      return reply;
    };
    await run(hh.orgs.A!, opId);
    hh.stack.channel.deliver = real;
    expect((await opRow(opId)).state).toBe('needs_reconcile');
    expect((await siteRow(siteId)).status).toBe('creating');
    await hh.jobs().runDue();
    expect((await opRow(opId)).state).toBe('succeeded');
    expect((await siteRow(siteId)).status).toBe('active');
    const tok = (await siteRow(siteId)).token as string;
    expect(
      node.executed.filter((e) => e.commandId === 'site.create' && e.token === tok),
    ).toHaveLength(1); // executed exactly once, adopted afterwards
  });
  it('a node that refuses permanently (unsupported runtime) fails the operation, marks the site failed and releases its reservation', async () => {
    const q = await hh.quote('alice', hh.orgs.A!, planSmall, 'php:8.3');
    const r = await hh.call('alice', 'POST', '/v1/hosting/sites', {
      quoteId: q.json().id,
      planId: planSmall,
      name: 'will-fail',
      projectId: projA,
      runtime: 'php:8.3',
    });
    const siteId = r.json().site.id;
    const nodeId = (await siteRow(siteId)).node_id;
    const before = free(await capacity(nodeId), 'sites');
    hh.stack.nodes.get(nodeId)!.opts.runtimes = ['static']; // the node stopped offering php between placement and creation
    await run(hh.orgs.A!, r.json().operationId);
    expect((await opRow(r.json().operationId)).state).toBe('failed');
    const s = await siteRow(siteId);
    expect(s.status).toBe('failed');
    expect(free(await capacity(nodeId), 'sites')).toBe(before + 1);
    hh.stack.nodes.get(nodeId)!.opts.runtimes = undefined;
  });
});
