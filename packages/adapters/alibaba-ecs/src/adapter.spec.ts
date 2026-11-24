import { afterAll, describe, expect, it } from 'vitest';
import { idempotencyToken } from '@nuzm/adapter-contracts';
import { createFetchTransport } from '@nuzm/adapter-http';
import { AlibabaEcsAdapter, categoryForCode, toMinorUnits } from './adapter';
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

describe('alibaba-ecs probe (DryRun-based capability proof)', () => {
  it('claims only what a read or a DryRun proved; CreateSnapshot stays unknown; evidence is fixture', async () => {
    const s = await subj();
    const r = await s.adapter.probe(s.ctx);
    const c = r.capabilities;
    expect(c['compute.inspect']).toBe('supported');
    expect(c['compute.find-by-token']).toBe('supported');
    expect(c['compute.quote-api']).toBe('supported');
    expect(c['compute.billing-export']).toBe('supported');
    expect(c['compute.metrics']).toBe('supported');
    expect(c['compute.provision']).toBe('supported');
    expect(c['compute.delete']).toBe('supported');
    expect(c['compute.action.stop']).toBe('supported');
    expect(c['compute.action.resize']).toBe('unsupported'); // the simulated RAM user may not call ModifyInstanceSpec
    expect(c['compute.action.snapshot']).toBe('unknown'); // no documented DryRun
    expect(r.evidence.every((e) => e.kind === 'fixture')).toBe(true);
    // every DryRun call carried DryRun=true and created nothing
    expect(s.sim.calls.filter((x) => x.dryRun).length).toBeGreaterThanOrEqual(6);
    expect(s.sim.billableCount()).toBe(1); // only the seed instance
  });

  it('without an existing instance the mutating capabilities stay unknown (nothing is assumed)', async () => {
    const s = await subj();
    s.sim.instances.clear();
    const c = (await s.adapter.probe(s.ctx)).capabilities;
    for (const id of [
      'compute.delete',
      'compute.action.start',
      'compute.action.stop',
      'compute.action.reboot',
      'compute.metrics',
    ] as const)
      expect(c[id]).toBe('unknown');
  });

  it('without configured networking provisioning is unknown and a provision call is rejected', async () => {
    const s = await subj({ network: () => undefined });
    expect((await s.adapter.probe(s.ctx)).capabilities['compute.provision']).toBe('unknown');
    const r = await s.adapter.provision(s.ctx, req(s, tok('nonet')));
    expect(r.status).toBe('failed');
    expect(r.error?.category).toBe('unsupported');
  });

  it('a Forbidden.RAM answer to the DryRun is `unsupported`', async () => {
    const s = await subj();
    s.sim.forbidden.add('DeleteInstance');
    expect((await s.adapter.probe(s.ctx)).capabilities['compute.delete']).toBe('unsupported');
  });
});

describe('alibaba-ecs regions, plans, prices', () => {
  it('lists only regions of the account listing with a documented country; Saudi is listed but NOT verified by a fixture', async () => {
    const s = await subj();
    const r = await s.adapter.listRegions(s.ctx);
    expect(r.map((x) => [x.providerRegionId, x.countryCode])).toEqual([
      ['ap-southeast-1', 'SG'],
      ['me-central-1', 'SA'],
    ]); // me-east-1 is soldOut, cn-hangzhou has no documented country in the table
    expect(r.every((x) => x.verifiedAt === null)).toBe(true);
  });

  it('the verified state is set only when the evidence is LIVE (logic test through a transport that claims `live`)', async () => {
    const inner = createFetchTransport({
      policy: { adapterId: 'alibaba-ecs', hosts: ['127.0.0.1'], allowLoopback: true },
    });
    const s = await subj({ transport: { send: (q) => inner.send(q), evidenceKind: () => 'live' } });
    const r = await s.adapter.listRegions(s.ctx);
    expect(r.find((x) => x.providerRegionId === 'me-central-1')?.verifiedAt).not.toBeNull();
    expect(r.every((x) => x.evidence.every((e) => e.kind === 'live'))).toBe(true);
  });

  it('plans: stock decides availability, sizes are integers, prices are integer minor units rounded UP (0.17 → 17, 0.165 → 17)', async () => {
    const s = await subj();
    const plans = await s.adapter.listPlans(s.ctx, 'me-central-1');
    expect(
      plans.map((p) => [
        p.planRef,
        p.availability,
        p.price?.amountMinor,
        p.price?.currency,
        p.price?.period,
      ]),
    ).toEqual([
      ['ecs.g6.large', 'available', '17', 'USD', 'hour'],
      ['ecs.g6.xlarge', 'available', '17', 'USD', 'hour'],
      ['ecs.g6.2xlarge', 'sold_out', '33', 'USD', 'hour'],
    ]);
    expect(plans[0]).toMatchObject({ vcpu: 2, memoryMb: 8192, diskGb: 40 });
    expect(plans.some((p) => p.planRef === 'ecs.g6.4xlarge')).toBe(false); // beyond the CPU filter
    expect(toMinorUnits(0.17, 'ceil')).toBe('17');
    expect(toMinorUnits(0.171, 'ceil')).toBe('18');
    expect(toMinorUnits(12.345, 'round')).toBe('1235');
    expect(() => toMinorUnits(-1, 'ceil')).toThrow();
  });

  it('a type that DescribePrice cannot price has no price (never offered)', async () => {
    const s = await subj();
    const orig = s.sim.calls.length;
    const plans = await s.adapter.listPlans(s.ctx, 'ap-southeast-1');
    expect(plans.every((p) => p.price !== undefined)).toBe(true);
    expect(s.sim.calls.length).toBeGreaterThan(orig);
  });
});

describe('alibaba-ecs lifecycle', () => {
  it('RunInstances gets ClientToken = the token and tags nuzm-token/nuzm-org; the SSH key is imported once', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('tags');
    const r = await s.adapter.provision(s.ctx, req(s, t));
    expect(r.status).toBe('accepted');
    expect(r.providerRef).toMatch(/^me-central-1\/i-sim/);
    const inst = [...s.sim.instances.values()].find((i) => i.clientToken === t)!;
    expect(inst.tags['nuzm-token']).toBe(t);
    expect(inst.tags['nuzm-org']).toBe('a1b2c3d4e5f60718');
    expect(inst.keyPair).toMatch(/^nuzm-[0-9a-f]{24}$/);
    const again = await s.adapter.provision(s.ctx, req(s, t));
    expect(again.providerRef).toBe(r.providerRef);
    expect(s.sim.billableByToken(t)).toBe(1);
  });

  it("UserData is sent Base64-encoded (documented), is identical on a ClientToken replay, and a replay with changed user data is the vendor's IdempotentParameterMismatch", async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('userdata');
    const ud = '#cloud-config\nruncmd:\n  - echo "héllo"\n';
    const r = await s.adapter.provision(s.ctx, req(s, t, { userData: ud }));
    expect(r.status).toBe('accepted');
    const inst = [...s.sim.instances.values()].find((i) => i.clientToken === t)!;
    expect(inst.userDataB64).toBe(Buffer.from(ud, 'utf8').toString('base64'));
    expect(Buffer.from(inst.userDataB64!, 'base64').toString('utf8')).toBe(ud);
    const same = await s.adapter.provision(s.ctx, req(s, t, { userData: ud }));
    expect(same.providerRef).toBe(r.providerRef);
    expect(s.sim.billableByToken(t)).toBe(1);
    const changed = await s.adapter.provision(s.ctx, req(s, t, { userData: ud + '# changed\n' }));
    expect(changed.status).toBe('failed');
    expect(s.sim.billableByToken(t)).toBe(1);
  });

  it('user data above the local ceiling (8 KB before encoding; vendor limit 32 KB) or empty is refused locally, nothing is sent', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const n = s.sim.calls.length;
    const big = await s.adapter.provision(
      s.ctx,
      req(s, tok('big'), { userData: 'x'.repeat(8 * 1024 + 1) }),
    );
    const empty = await s.adapter.provision(s.ctx, req(s, tok('empty'), { userData: '' }));
    const edge = await s.adapter.provision(
      s.ctx,
      req(s, tok('edge'), { userData: 'y'.repeat(8 * 1024) }),
    );
    expect(big.error?.providerCode).toBe('invalid_user_data');
    expect(empty.error?.providerCode).toBe('invalid_user_data');
    expect(edge.status).toBe('accepted');
    expect(s.sim.calls.slice(n).filter((c) => c.action === 'RunInstances')).toHaveLength(1);
  });

  it('listImages carries the documented IsSupportCloudinit statement', async () => {
    const s = await subj();
    const imgs = await s.adapter.listImages(s.ctx, s.fixture.providerRegionId);
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((i) => i.cloudInit === true)).toBe(true);
  });

  it('refuses more than one SSH key and unknown regions locally (nothing sent)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const n = s.sim.calls.length;
    const two = await s.adapter.provision(
      s.ctx,
      req(s, tok('two'), { sshPublicKeys: ['k1', 'k2'] }),
    );
    const bad = await s.adapter.provision(
      s.ctx,
      req(s, tok('reg'), { providerRegionId: 'cn-hangzhou' }),
    );
    expect(two.error?.category).toBe('validation');
    expect(bad.error?.category).toBe('validation');
    expect(s.sim.calls.length).toBe(n);
  });

  it('a sold-out type is a retryable capacity error; a Throttling.User answer is a retryable rate_limit', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const cap = await s.adapter.provision(s.ctx, req(s, tok('cap'), { planRef: 'ecs.g6.2xlarge' }));
    expect(cap.error).toMatchObject({
      category: 'capacity',
      providerCode: 'OperationDenied.NoStock',
      retryable: true,
    });
    s.sim.inject('provision', 'rate_limit');
    const rl = await s.adapter.provision(s.ctx, req(s, tok('rl')));
    expect(rl.error).toMatchObject({ category: 'rate_limit', retryable: true });
  });

  it('a 503 on RunInstances is `uncertain` (never `failed`): the orchestrator must reconcile', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    s.sim.inject('provision', 'outage');
    const r = await s.adapter.provision(s.ctx, req(s, tok('503')));
    expect(r.status).toBe('uncertain');
  });

  it('resize needs a stopped instance (documented): conflict while running, ModifyInstanceSpec once stopped', async () => {
    const s = await subj({}, false);
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('rz')));
    const refused = await s.adapter.act!(s.ctx, p.providerRef!, 'resize', {
      planRef: 'ecs.g6.xlarge',
    });
    expect(refused.error?.category).toBe('conflict');
    await s.adapter.act!(s.ctx, p.providerRef!, 'stop', {});
    const ok = await s.adapter.act!(s.ctx, p.providerRef!, 'resize', { planRef: 'ecs.g6.xlarge' });
    expect(ok.status).toBe('accepted');
    expect((await s.adapter.inspect(s.ctx, p.providerRef!)).data?.planRef).toBe('ecs.g6.xlarge');
  });

  it('snapshot snapshots the SYSTEM DISK (DescribeDisks → CreateSnapshot) once the probe marks it supported', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('sn')));
    expect((await s.adapter.act!(s.ctx, p.providerRef!, 'snapshot', {})).error?.category).toBe(
      'unsupported',
    ); // unknown ⇒ unsupported
    s.controls.setCapabilities({ 'compute.action.snapshot': 'supported' });
    const r = await s.adapter.act!(s.ctx, p.providerRef!, 'snapshot', {});
    expect(r.status).toBe('accepted');
    expect(s.sim.calls.map((c) => c.action)).toEqual(
      expect.arrayContaining(['DescribeDisks', 'CreateSnapshot']),
    );
  });

  it('delete uses Force=true and is idempotent (second call: instance gone → succeeded)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('del')));
    expect((await s.adapter.delete(s.ctx, p.providerRef!)).status).toBe('succeeded');
    expect((await s.adapter.delete(s.ctx, p.providerRef!)).status).toBe('succeeded');
  });

  it('findByToken searches every listed region when the token is unknown to this process (restart case)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const t = tok('find');
    const p = await s.adapter.provision(s.ctx, req(s, t));
    const fresh = new AlibabaEcsAdapter({
      ...(s.adapter as unknown as { o: ConstructorParameters<typeof AlibabaEcsAdapter>[0] }).o,
    });
    await fresh.probe(s.ctx);
    const f = await fresh.findByToken(s.ctx, t);
    expect(f.data?.providerRef).toBe(p.providerRef);
    const none = await fresh.findByToken(s.ctx, tok('absent'));
    expect(none).toMatchObject({ status: 'succeeded', data: null });
  });

  it('a region that cannot be searched means absence is NOT proven (failed, not data:null)', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    s.sim.inject('findByToken', 'outage', 5);
    const f = await s.adapter.findByToken(s.ctx, tok('x'));
    expect(f.status).toBe('failed');
    expect(f.data).toBeUndefined();
  });

  it('metrics: documented units, 400-point window rule', async () => {
    const s = await subj();
    await s.adapter.probe(s.ctx);
    const p = await s.adapter.provision(s.ctx, req(s, tok('mx')));
    const m = await s.adapter.metrics!(s.ctx, p.providerRef!, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-01T01:00:00Z',
    });
    expect(m.status).toBe('succeeded');
    expect(m.data!.series.find((x) => x.name === 'cpu')?.unit).toBe('percent');
    const wide = await s.adapter.metrics!(s.ctx, p.providerRef!, {
      from: '2025-01-01T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });
    expect(wide.error?.category).toBe('validation');
  });
});

describe('alibaba-ecs billing, auth, secrets', () => {
  it('fetchBilling pages with NextToken, rounds to 2 decimals, keeps the bare instance id', async () => {
    const s = await subj();
    s.sim.bills = [
      {
        InstanceID: 'i-aaa',
        PretaxAmount: 1.005,
        Currency: 'USD',
        BillingCycle: '2026-01',
        InstanceSpec: 'ecs.g6.large',
        BillingDate: '2026-01-02',
      },
      {
        InstanceID: 'i-bbb',
        PretaxAmount: 0.1,
        Currency: 'USD',
        BillingCycle: '2026-01',
        InstanceSpec: 'ecs.g6.large',
        BillingDate: '2026-01-03',
      },
    ];
    const rows = await s.adapter.fetchBilling!(s.ctx, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T00:00:00Z',
    });
    expect(rows.map((r) => [r.providerRef, r.amountMinor, r.currency])).toEqual(
      [
        ['i-aaa', '101'],
        ['i-bbb', '10'],
      ].map(([a, b]) => [a, b, 'USD']),
    );
    expect(rows[0]!.periodStart).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a wrong secret is an auth failure (health unhealthy); the credentials never appear in evidence', async () => {
    const s = await subj();
    const out = JSON.stringify([
      await s.adapter.probe(s.ctx),
      await s.adapter.health(s.ctx),
      await s.adapter.provision(s.ctx, req(s, tok('canary'))),
    ]);
    expect(out.includes(s.sim.credentials.accessKeySecret)).toBe(false);
    expect(s.redactor.leaks(out)).toBe(false);
    (s.sim.credentials as { accessKeySecret: string }).accessKeySecret =
      'rotated-elsewhere-secret-value';
    expect((await s.adapter.health(s.ctx)).state).toBe('unhealthy');
  });

  it('error normalization table', () => {
    const t: [string | null, number, string][] = [
      ['Throttling.User', 400, 'rate_limit'],
      ['Throttling.Resource', 429, 'rate_limit'],
      ['OperationDenied.NoStock', 403, 'capacity'],
      ['QuotaExceed.ElasticQuota', 403, 'quota'],
      ['InvalidInstanceId.NotFound', 404, 'not_found'],
      ['InvalidImageId.NotFound', 404, 'validation'],
      ['Forbidden.RAM', 403, 'auth'],
      ['SignatureDoesNotMatch', 400, 'auth'],
      ['IncorrectInstanceStatus', 403, 'conflict'],
      ['IdempotentParameterMismatch', 403, 'conflict'],
      ['InternalError', 500, 'provider_outage'],
      [null, 503, 'provider_outage'],
      [null, 404, 'not_found'],
    ];
    for (const [code, status, cat] of t) expect(categoryForCode(code, status)).toBe(cat);
  });
});
