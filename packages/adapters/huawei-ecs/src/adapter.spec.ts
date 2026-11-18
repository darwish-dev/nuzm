import { afterAll, describe, expect, it } from 'vitest';
import { idempotencyToken } from '@nuzm/adapter-contracts';
import { createFetchTransport } from '@nuzm/adapter-http';
import {
  HuaweiEcsAdapter,
  categoryForCode,
  clientTokenUuid,
  serverName,
  toMinorUnits,
} from './adapter';
import { makeSubject } from './test-subject';

const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const s of stops) await s();
});
const subj = async (...a: Parameters<typeof makeSubject>) => {
  const s = await makeSubject(...a);
  stops.push(s.stop);
  return s;
};
const tok = (n: string) => idempotencyToken('org-1', `op-${n}`, 'provision');
const req = (
  s: Awaited<ReturnType<typeof subj>>,
  token: string,
  over: Record<string, unknown> = {},
) => ({
  providerRegionId: s.fixture.providerRegionId,
  planRef: s.fixture.planRef,
  imageRef: s.fixture.imageRef,
  name: 'web 1',
  sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkey0000 test'],
  tags: { 'nuzm-org': 'a1b2c3d4e5f60718' },
  idempotencyToken: token,
  ...over,
});

describe('huawei-ecs probe (read-only mode is the live default)', () => {
  it('claims only what a read proved; every mutating capability stays unknown; nothing is created', async () => {
    const s = await subj({ capabilityMode: 'read-only', disabledCapabilities: [] });
    const r = await s.adapter.probe(s.ctx);
    const c = r.capabilities;
    for (const id of [
      'compute.inspect',
      'compute.find-by-token',
      'compute.quote-api',
      'compute.billing-export',
      'compute.metrics',
    ] as const)
      expect(c[id]).toBe('supported');
    for (const id of [
      'compute.provision',
      'compute.delete',
      'compute.action.start',
      'compute.action.stop',
      'compute.action.reboot',
      'compute.action.resize',
      'compute.action.snapshot',
    ] as const)
      expect(c[id]).toBe('unknown');
    expect(r.evidence.every((e) => e.kind === 'fixture')).toBe(true);
    expect(s.sim.billableCount()).toBe(1); // only the seed server; the Create dry_run flag is never used by the probe
    expect(s.sim.calls.some((x) => x.method === 'POST' && /cloudservers$/.test(x.path))).toBe(
      false,
    );
    const p = await s.adapter.provision(s.ctx, req(s, tok('ro')));
    expect(p.error?.category).toBe('unsupported');
  });

  it('documented mode (fixture runs only) is refused for a live endpoint', async () => {
    const inner = createFetchTransport({
      policy: { adapterId: 'huawei-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
    });
    const s = await subj({ transport: { send: (q) => inner.send(q), evidenceKind: () => 'live' } });
    await expect(s.adapter.probe(s.ctx)).rejects.toThrow(/fixture runs only/);
  });
});

describe('huawei-ecs regions, plans, prices', () => {
  it('lists regions from the account IAM project list (AK/SK and token mode): enabled + documented country only; Saudi is NOT verified by a fixture', async () => {
    for (const tokenMode of [false, true]) {
      const s = await subj({}, tokenMode);
      const r = await s.adapter.listRegions(s.ctx);
      expect(r.map((x) => [x.providerRegionId, x.countryCode])).toEqual([
        ['ap-southeast-1', 'HK'],
        ['me-east-1', 'SA'],
      ]); // cn-north-4 unmapped, ae-ad-1 disabled
      expect(r.every((x) => x.verifiedAt === null)).toBe(true);
    }
  });

  it('the verified state is set only from LIVE evidence (logic test through a transport that claims `live`)', async () => {
    const inner = createFetchTransport({
      policy: { adapterId: 'huawei-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
    });
    const s = await subj({
      transport: { send: (q) => inner.send(q), evidenceKind: () => 'live' },
      capabilityMode: 'read-only',
    });
    const r = await s.adapter.listRegions(s.ctx);
    expect(r.find((x) => x.providerRegionId === 'me-east-1')?.verifiedAt).not.toBeNull();
    expect(r.every((x) => x.evidence.every((e) => e.kind === 'live'))).toBe(true);
  });

  it('plans: availability from cond:operation:status/az, pay-per-use price of flavor + volume rounded UP to integer minor units', async () => {
    const s = await subj();
    const plans = await s.adapter.listPlans(s.ctx, 'me-east-1');
    expect(
      plans.map((p) => [p.planRef, p.availability, p.price?.amountMinor, p.price?.currency]),
    ).toEqual([
      ['s6.large.2', 'available', '8', 'USD'], // 0.0585 + 40 GB × 0.000307 = 0.07078 → 8
      ['s6.xlarge.2', 'available', '13', 'USD'], // an AZ is normal although another is sellout
      ['s6.2xlarge.2', 'sold_out', '25', 'USD'],
    ]);
    expect(plans[0]).toMatchObject({ vcpu: 2, memoryMb: 4096, diskGb: 40 });
    expect(plans.some((p) => p.planRef === 'old.flavor' || p.planRef === 's6.4xlarge.2')).toBe(
      false,
    ); // abandon / beyond the filter
    expect(toMinorUnits(0.07078, 'ceil')).toBe('8');
    expect(toMinorUnits(8.128, 'round')).toBe('813');
  });

  it('images come from IMS (Linux, active)', async () => {
    const s = await subj();
    const imgs = await s.adapter.listImages(s.ctx, 'me-east-1');
    expect(imgs[0]).toMatchObject({
      imageRef: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
      osFamily: 'linux',
    });
  });
});

describe('huawei-ecs lifecycle', () => {
  it('Create sends a UUID X-Client-Token, the token in the NAME and in server_tags; replaying creates nothing new', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('tags');
    const r = await s.adapter.provision(s.ctx, req(s, t));
    expect(r.status).toBe('accepted');
    expect(r.providerRef).toMatch(/^me-east-1\/[0-9a-f-]{36}$/);
    const srv = [...s.sim.servers.values()].find((x) => x.clientToken)!;
    expect(srv.clientToken).toBe(clientTokenUuid(t));
    expect(srv.name.startsWith(`nz-${t}-`)).toBe(true);
    expect(srv.tags['nuzm-token']).toBe(t);
    expect(srv.tags['nuzm-org']).toBe('a1b2c3d4e5f60718');
    expect(srv.userData).toContain('ssh_authorized_keys');
    expect((await s.adapter.provision(s.ctx, req(s, t))).providerRef).toBe(r.providerRef);
    expect(s.sim.billableByToken(t)).toBe(1);
  });

  it('a replay AFTER the 8-hour client-token window still creates nothing (lookup first)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('late');
    const a = await s.adapter.provision(s.ctx, req(s, t));
    s.controls.advance(9 * 3600_000);
    const b = await s.adapter.provision(s.ctx, req(s, t));
    expect(b.providerRef).toBe(a.providerRef);
    expect(s.sim.billableByToken(t)).toBe(1);
  });

  it('local validation sends nothing: unmapped region, missing network, bad token', async () => {
    const s = await subj({
      network: (r) =>
        r === 'me-east-1' ? undefined : { vpcId: 'v', subnetId: 's', securityGroupId: 'g' },
    });
    await s.adapter.probe(s.ctx);
    const n = s.sim.calls.length;
    const a = await s.adapter.provision(
      s.ctx,
      req(s, tok('a'), { providerRegionId: 'cn-north-4' }),
    );
    const b = await s.adapter.provision(s.ctx, req(s, tok('b')));
    const c = await s.adapter.provision(
      s.ctx,
      req(s, 'nothex', { providerRegionId: 'ap-southeast-1' }),
    );
    expect([a.error?.category, b.error?.category, c.error?.category]).toEqual([
      'validation',
      'validation',
      'validation',
    ]);
    expect(s.sim.calls.length).toBe(n);
  });

  it('error mapping on create: sold out ⇒ retryable capacity, 429 ⇒ rate_limit, HTTP 202 + Common.0024 ⇒ failed rate_limit (not accepted), 500 ⇒ uncertain', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const cap = await s.adapter.provision(s.ctx, req(s, tok('cap'), { planRef: 's6.2xlarge.2' }));
    expect(cap.error).toMatchObject({
      category: 'capacity',
      providerCode: 'Ecs.0018',
      retryable: true,
    });
    s.sim.inject('provision', 'rate_limit');
    expect((await s.adapter.provision(s.ctx, req(s, tok('rl')))).error?.category).toBe(
      'rate_limit',
    );
    s.sim.inject('provision', 'flow_limit_202');
    const f = await s.adapter.provision(s.ctx, req(s, tok('fl')));
    expect(f.status).toBe('failed');
    expect(f.error?.category).toBe('rate_limit');
    s.sim.inject('provision', 'outage');
    expect((await s.adapter.provision(s.ctx, req(s, tok('500')))).status).toBe('uncertain');
    expect(s.sim.billableCount()).toBe(1);
  });

  it('resize needs a stopped server (documented): conflict while running, then the V1.1 resize call', async () => {
    const s = await subj({ disabledCapabilities: [] });
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('rz')));
    expect(
      (await s.adapter.act!(s.ctx, p.providerRef!, 'resize', { planRef: 's6.xlarge.2' })).error
        ?.category,
    ).toBe('conflict');
    await s.adapter.act!(s.ctx, p.providerRef!, 'stop', {});
    expect(
      (await s.adapter.act!(s.ctx, p.providerRef!, 'resize', { planRef: 's6.xlarge.2' })).status,
    ).toBe('accepted');
    expect((await s.adapter.inspect(s.ctx, p.providerRef!)).data?.planRef).toBe('s6.xlarge.2');
  });

  it('snapshot goes through EVS on the BOOT volume (ECS has no snapshot API)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('sn')));
    expect((await s.adapter.act!(s.ctx, p.providerRef!, 'snapshot', {})).status).toBe('accepted');
    expect(s.sim.calls.some((c) => c.path.endsWith('/cloudsnapshots'))).toBe(true);
  });

  it('delete releases EIP and volumes, is `succeeded` when the job is already SUCCESS, and a second delete is a no-op', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('del')));
    expect((await s.adapter.delete(s.ctx, p.providerRef!)).status).toBe('succeeded');
    const before = s.sim.calls.length;
    expect((await s.adapter.delete(s.ctx, p.providerRef!)).status).toBe('succeeded');
    expect(s.sim.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
  });

  it('findByToken: restart case searches the account regions; an unsearchable region means absence is NOT proven', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('find');
    const p = await s.adapter.provision(s.ctx, req(s, t));
    const fresh = new HuaweiEcsAdapter({
      ...(s.adapter as unknown as { o: ConstructorParameters<typeof HuaweiEcsAdapter>[0] }).o,
    });
    await fresh.probe(s.ctx);
    expect((await fresh.findByToken(s.ctx, t)).data?.providerRef).toBe(p.providerRef);
    expect(await fresh.findByToken(s.ctx, tok('absent'))).toMatchObject({
      status: 'succeeded',
      data: null,
    });
    s.sim.inject('findByToken', 'outage', 5);
    const f = await fresh.findByToken(s.ctx, tok('x'));
    expect(f.status).toBe('failed');
    expect(f.data).toBeUndefined();
  });

  it('inspect maps documented statuses and returns the floating IP and nuzm tags', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('ins')));
    const i = await s.adapter.inspect(s.ctx, p.providerRef!);
    expect(i.data).toMatchObject({
      status: 'running',
      planRef: 's6.large.2',
      providerRegionId: 'me-east-1',
    });
    expect(i.data!.publicIps[0]).toMatch(/^203\.0\.113\./);
    expect(i.data!.tags['nuzm-org']).toBe('a1b2c3d4e5f60718');
    await s.adapter.act!(s.ctx, p.providerRef!, 'stop', {});
    expect((await s.adapter.inspect(s.ctx, p.providerRef!)).data?.status).toBe('stopped');
  });

  it('metrics: CES cpu_util with the documented window rule', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('mx')));
    const m = await s.adapter.metrics!(s.ctx, p.providerRef!, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-01T01:00:00Z',
    });
    expect(m.data?.series[0]).toMatchObject({ name: 'cpu_util', unit: '%' });
    const wide = await s.adapter.metrics!(s.ctx, p.providerRef!, {
      from: '2000-01-01T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });
    expect(wide.error?.category).toBe('validation');
  });
});

describe('huawei-ecs billing, auth, secrets', () => {
  it('fetchBilling pages with offset/limit, rounds to 2 decimals, keeps res_instance_id', async () => {
    const s = await subj();
    s.sim.bills = [
      {
        cycle: '2026-01',
        res_instance_id: 'srv-a',
        consume_amount: 1.005,
        product_spec_desc: 's6.large.2',
      },
      {
        cycle: '2026-01',
        res_instance_id: 'srv-b',
        consume_amount: 0.1,
        product_spec_desc: 's6.large.2',
      },
    ];
    const rows = await s.adapter.fetchBilling!(s.ctx, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T00:00:00Z',
    });
    expect(rows.map((r) => [r.providerRef, r.amountMinor, r.currency])).toEqual([
      ['srv-a', '101', 'USD'],
      ['srv-b', '10', 'USD'],
    ]);
  });

  it('credentials (AK/SK, IAM password, issued token) never appear in evidence or results; a bad secret is an auth failure', async () => {
    for (const tokenMode of [false, true]) {
      const s = await subj({}, tokenMode);
      const out = JSON.stringify([
        await s.adapter.probe(s.ctx),
        await s.adapter.health(s.ctx),
        await s.adapter.provision(s.ctx, req(s, tok('canary'))),
      ]);
      for (const secret of [s.sim.credentials.secretKey, s.sim.credentials.iamPassword])
        expect(out.includes(secret)).toBe(false);
      expect(s.redactor.leaks(out)).toBe(false);
    }
    const bad = await subj();
    (bad.sim.credentials as { secretKey: string }).secretKey = 'rotated-elsewhere-secret-value';
    expect((await bad.adapter.health(bad.ctx)).state).toBe('unhealthy');
  });

  it('error normalization table and idempotency helpers', () => {
    const t: [string | null, number, string][] = [
      ['Common.1503', 429, 'rate_limit'],
      ['Common.0024', 202, 'rate_limit'],
      ['APIGW.0308', 429, 'rate_limit'],
      ['Ecs.0018', 400, 'capacity'],
      ['Ecs.0001', 400, 'quota'],
      ['Ecs.0067', 403, 'quota'],
      ['Ecs.0114', 404, 'not_found'],
      ['Ecs.0110', 403, 'auth'],
      ['Pdp.0001', 403, 'auth'],
      ['Ecs.0122', 400, 'conflict'],
      ['Ecs.0005', 400, 'validation'],
      ['Common.0001', 500, 'provider_outage'],
      [null, 503, 'provider_outage'],
    ];
    for (const [code, status, cat] of t) expect(categoryForCode(code, status)).toBe(cat);
    expect(clientTokenUuid('a'.repeat(64))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(clientTokenUuid('a'.repeat(64))).toBe(clientTokenUuid('a'.repeat(64)));
    expect(serverName('t'.repeat(64), 'web 1/x').startsWith(`nz-${'t'.repeat(64)}-web-1-x`)).toBe(
      true,
    );
    expect(serverName('t'.repeat(64), 'x'.repeat(200)).length).toBe(128);
  });
});
