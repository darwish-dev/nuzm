import { afterAll, describe, expect, it } from 'vitest';
import { Redactor, idempotencyToken } from '@nuzm/adapter-contracts';
import { ReplayTransport, createFetchTransport, type RecordedExchange } from '@nuzm/adapter-http';
import { MemoryVaultClient } from '@nuzm/adapter-runtime';
import { ContaboVpsAdapter } from './adapter';
import { makeSubject, REF } from './test-subject';
import { snapshotsDocumented } from './products';

const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const s of stops) await s();
});
const req = (planRef: string, token: string) => ({
  providerRegionId: 'EU',
  planRef,
  imageRef: 'afecbb85-e2fc-46f0-9684-b46b1faf00bb',
  name: 'n1',
  sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkey0000 test'],
  tags: { 'nuzm-org': 'abcd' },
  idempotencyToken: token,
});
const CREDS = {
  clientId: 'sim-client',
  clientSecret: 'sim-client-secret-value',
  apiUser: 'sim-user@example.invalid',
  apiPassword: 'sim-api-password-value',
};

describe('contabo-vps', () => {
  it('read-only mode (the live default): mutating capabilities are unknown, so nothing is provisioned', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    const ro = new ContaboVpsAdapter({
      vault: new MemoryVaultClient({ [REF]: CREDS }),
      redactor: new Redactor(),
      transport: createFetchTransport({
        policy: { adapterId: 'contabo-vps', hosts: ['127.0.0.1'], allowLoopback: true },
      }),
      apiBase: s.sim.baseUrl,
      tokenUrl: s.sim.tokenUrl,
    });
    const rep = await ro.probe(s.ctx);
    expect(rep.capabilities['compute.inspect']).toBe('supported');
    expect(rep.capabilities['compute.find-by-token']).toBe('supported');
    for (const id of [
      'compute.provision',
      'compute.delete',
      'compute.action.start',
      'compute.action.snapshot',
    ] as const)
      expect(rep.capabilities[id]).toBe('unknown');
    expect(rep.capabilities['compute.action.resize']).toBe('unsupported');
    expect(rep.capabilities['compute.billing-export']).toBe('unsupported');
    expect(rep.capabilities['compute.metrics']).toBe('unsupported');
    const r = await ro.provision(s.ctx, req('V153', idempotencyToken('o', 'p', 's')));
    expect(r.status).toBe('failed');
    expect(r.error?.category).toBe('unsupported');
    expect(s.sim.billableCount()).toBe(0);
    expect(rep.evidence.every((e) => e.kind === 'fixture')).toBe(true);
  });

  it('plan-specific detection: snapshots are rejected for VDS/Storage VPS, allowed for Cloud VPS', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    await s.adapter.probe(s.ctx);
    const vds = await s.adapter.provision(s.ctx, req('V8', idempotencyToken('o', 'p', 'vds')));
    const cloud = await s.adapter.provision(
      s.ctx,
      req('V153', idempotencyToken('o', 'p', 'cloud')),
    );
    const a = await s.adapter.act!(s.ctx, vds.providerRef!, 'snapshot', {});
    const b = await s.adapter.act!(s.ctx, cloud.providerRef!, 'snapshot', {});
    expect(a.status).toBe('failed');
    expect(a.error?.category).toBe('unsupported');
    expect(b.status).toBe('accepted');
    expect(snapshotsDocumented('V93')).toBe(false);
    expect(snapshotsDocumented('V159')).toBe(true);
  });

  it('an unknown product or region is a local validation error (unknown = unsupported), nothing is sent', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    await s.adapter.probe(s.ctx);
    const before = s.sim.requests.length;
    const r = await s.adapter.provision(s.ctx, req('V91', idempotencyToken('o', 'p', 'x')));
    expect(r.error?.category).toBe('validation');
    expect(s.sim.requests.length).toBe(before);
  });

  it('displayName carries the token marker, never the org name; SSH keys go through cloud-init userData', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    await s.adapter.probe(s.ctx);
    const tok = idempotencyToken('o', 'p', 'marker');
    await s.adapter.provision(s.ctx, req('V153', tok));
    const inst = [...s.sim.instances.values()][0]!;
    expect(inst.displayName.startsWith(`nuzm:${tok}|`)).toBe(true);
    expect(inst.userData).toContain('ssh_authorized_keys');
  });

  it('delete is a cancel (no DELETE endpoint exists): the cancel call is made once and never repeated', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req('V153', idempotencyToken('o', 'p', 'c')));
    await s.adapter.delete(s.ctx, p.providerRef!);
    await s.adapter.delete(s.ctx, p.providerRef!);
    expect(s.sim.requests.filter((r) => r.path.endsWith('/cancel')).length).toBe(1);
    expect(s.sim.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('no verified region from fixture evidence; regions come from the account listing and map to documented countries', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    const regions = await s.adapter.listRegions(s.ctx);
    expect(regions.map((r) => [r.providerRegionId, r.countryCode])).toEqual([
      ['EU', 'EU'],
      ['UK', 'GB'],
    ]);
    expect(regions.every((r) => r.verifiedAt === null)).toBe(true);
    const plans = await s.adapter.listPlans(s.ctx, 'EU');
    expect(plans.length).toBe(5); // only VDS plans have a complete documented spec
    expect(plans.every((p) => p.availability === 'unavailable' && p.price === undefined)).toBe(
      true,
    );
  });

  it('replays the documented sample object (fixture): get mapping', async () => {
    const sample: RecordedExchange[] = [
      {
        method: 'POST',
        url: 'https://auth.example.invalid/token',
        status: 200,
        responseBody: JSON.stringify({ access_token: 'tok-doc-sample-0001' }),
      },
      {
        method: 'GET',
        url: 'https://api.example.invalid/v1/compute/instances/100',
        status: 200,
        // shape of the documented GET /v1/compute/instances/{instanceId} 200 sample (api.contabo.com, read 2026-11-18), trimmed
        responseBody: JSON.stringify({
          data: [
            {
              tenantId: 'DE',
              instanceId: 100,
              region: 'EU',
              productId: 'V5',
              status: 'running',
              ipConfig: { v4: { ip: '192.168.0.1' } },
            },
          ],
          _links: { self: '/v1/compute/instances/100' },
        }),
      },
    ];
    const a = new ContaboVpsAdapter({
      vault: new MemoryVaultClient({
        [REF]: {
          clientId: 'c',
          clientSecret: 'secret-12345',
          apiUser: 'u@example.invalid',
          apiPassword: 'pass-12345',
        },
      }),
      redactor: new Redactor(),
      transport: new ReplayTransport(sample),
      apiBase: 'https://api.example.invalid',
      tokenUrl: 'https://auth.example.invalid/token',
    });
    const r = await a.inspect(
      { providerAccountId: 'x', credentialRef: REF, traceId: 't', deadlineMs: 100 },
      '100',
    );
    expect(r.status).toBe('succeeded');
    expect(r.data?.status).toBe('running');
    expect(r.data?.publicIps).toEqual(['192.168.0.1']);
    expect(r.raw.kind).toBe('fixture');
  });

  it('credentials never appear in evidence or results', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    const out = JSON.stringify([
      await s.adapter.probe(s.ctx),
      await s.adapter.health(s.ctx),
      await s.adapter.provision(s.ctx, req('V153', idempotencyToken('o', 'p', 'canary'))),
    ]);
    for (const secret of [CREDS.clientSecret, CREDS.apiPassword])
      expect(out.includes(secret)).toBe(false);
  });

  it('a rejected credential is an auth failure (health unhealthy)', async () => {
    const s = await makeSubject();
    stops.push(s.stop);
    s.sim.requireCredentials.client_secret = 'rotated-elsewhere-value';
    const h = await s.adapter.health(s.ctx);
    expect(h.state).toBe('unhealthy');
  });
});
