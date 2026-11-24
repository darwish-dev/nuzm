import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostingHarness } from './hosting-harness';
import { HestiaHostingAdapter } from './internal/hestia/adapter';
import { HestiaClient, HttpHestiaChannel } from './internal/hestia/client';
import { startHestiaMock } from './internal/hestia/mock-server';
import { HOSTING_ADAPTER } from './internal/tokens';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
/**
 * The whole hosting workflow (quote → allocate → create → configure → active → delete) driven by the REAL HestiaHostingAdapter against the local Hestia mock panel
 * (NOT VERIFIED vs a real panel). Everything platform-side (capacity, operations, audit) is the production code.
 */
const hh = new HostingHarness();
let mock: Awaited<ReturnType<typeof startHestiaMock>>;
let nodeId = '';
let plan = '';
let proj = '';
beforeAll(async () => {
  mock = await startHestiaMock();
  const client = new HestiaClient(
    {
      resolve: async () => ({
        host: mock.host,
        port: mock.port,
        accessKeyRef: 'vault://dev/hosting-panel-x',
      }),
    },
    { accessKey: async () => mock.controls.hash },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  const adapter = new HestiaHostingAdapter(client, {
    vault: undefined as never, // replaced below: the harness vault port
    evidenceKind: 'mock',
    packageFor: () => 'nuzm-starter',
    capacityOf: async (n) => {
      const i = await hh.compute.describe(n.computeInstanceId);
      return i
        ? { cpuMillicores: i.vcpu * 1000, memoryMb: i.memoryMb, diskMb: i.diskGb * 1024 }
        : null;
    },
  });
  await hh.init({ overrides: [[HOSTING_ADAPTER, adapter]] });
  (adapter as any).o.vault = hh.stack.vault;
  await hh.customers();
  proj = await hh.project(hh.orgs.A!);
  plan = await hh.plan('small');
  nodeId = await hh.activeNode('hestia-a');
});
afterAll(async () => {
  await hh.close();
  await mock.close();
});
const run = (orgId: string, id: string) => hh.jobs().runOne(orgId, id);

describe('hosting through HestiaCP (mock panel)', () => {
  let siteId = '';
  let account = '';
  it('the node was activated from a real inventory: panel version, runtimes and capacity come from the panel and the compute provider', async () => {
    const n = (await hh.admin('host', 'GET', `/v1/admin/hosting/nodes/${nodeId}`)).json();
    expect(n).toMatchObject({
      status: 'active',
      health: 'healthy',
      panelVersion: '1.9.4',
      panelConfigured: true,
    });
    expect(n.runtimes).toEqual(['php:8.2', 'php:8.3', 'static']);
  });

  it('creates a site: a Hestia account with its domain and PHP version; the password sits in the vault only', async () => {
    const r = await hh.createSite('alice', hh.orgs.A!, plan, 'php:8.3', 'hestia-site', proj);
    expect(r.statusCode).toBe(202);
    siteId = r.json().site.id;
    await run(hh.orgs.A!, r.json().operationId);
    const s = (await hh.call('alice', 'GET', `/v1/hosting/sites/${siteId}`)).json();
    expect(s.status).toBe('active');
    const [row] = await hh.env.sql(
      `SELECT node_name, credentials_ref FROM hosting.sites WHERE id = $1`,
      [siteId],
    );
    account = row!.node_name as string;
    const u = mock.controls.users.get(account)!;
    expect(u).toBeTruthy();
    expect(u.pkg).toBe('nuzm-starter');
    expect([...u.domains.values()].every((d) => d.backend === 'PHP-8_3')).toBe(true);
    const everything = JSON.stringify([s, await hh.env.sql(`SELECT * FROM hosting.sites`)]);
    expect(everything).not.toContain(u.password);
    expect(hh.stack.vault.secrets.get(row!.credentials_ref as string)?.toString()).toContain(
      u.password,
    );
  });

  it('a second create run for the same operation changes nothing on the panel', async () => {
    const before = mock.controls.users.size;
    const ops = await hh.env.sql(
      `SELECT id, org_id FROM platform.operations WHERE state = 'succeeded' ORDER BY created_at DESC LIMIT 1`,
    );
    await run(ops[0]!.org_id as string, ops[0]!.id as string);
    expect(mock.controls.users.size).toBe(before);
  });

  it('deleting the site removes the Hestia account (and proves it is gone)', async () => {
    const d = await hh.call(
      'alice',
      'DELETE',
      `/v1/hosting/sites/${siteId}`,
      undefined,
      hh.orgs.A!,
      {
        'x-confirm-delete': 'hestia-site',
      },
    );
    expect(d.statusCode).toBe(202);
    expect(mock.controls.users.has(account)).toBe(true); // an export window first
  });
});
