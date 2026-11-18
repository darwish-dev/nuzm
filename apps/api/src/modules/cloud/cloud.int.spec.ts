import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputeAdapter } from '@nuzm/adapter-contracts';
import { Db } from '@nuzm/platform';
import { MockComputeAdapter } from '@nuzm/adapter-mock-compute';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { AuditSink } from '../../common/audit';
import { AdapterRegistry, HealthService, VAULT } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let sink: { events: Row[] };
const staff: Record<string, Record<string, string>> = {};
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const admin = (
  who: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!),
      'x-csrf-token': staff[who]!.nuzm_admin_csrf!,
      ...headers,
    },
    ...(body ? { payload: body } : {}),
  });
const CANARY = 'CANARY-AKSECRET-7d41f0c2-NEVER-STORE';
let mock: MockComputeAdapter;
let registry: AdapterRegistry;
let providerIds: Record<string, string> = {};

async function waitJob(id: string, who = 'pa') {
  for (let i = 0; i < 100; i++) {
    const j = (await admin(who, 'GET', `/v1/admin/provider-jobs/${id}`)).json();
    if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}
const newAccount = async (provider: string, name: string, ref = `vault://dev/test/${name}`) => {
  const r = await admin('pa', 'POST', '/v1/admin/provider-accounts', {
    providerId: providerIds[provider],
    name,
    credentialRef: ref,
  });
  expect(r.statusCode).toBe(201);
  return r.json() as Row;
};
const verify = async (id: string) => {
  const r = await admin('pa', 'POST', `/v1/admin/provider-accounts/${id}/verification`);
  expect(r.statusCode).toBe(202);
  return waitJob(r.json().operationId);
};

beforeAll(async () => {
  await h.init();
  const built = await h.buildApp({}, undefined, [], { realAudit: false });
  app = built.app;
  sink = built.sink as unknown as { events: Row[] };
  for (const [name, roles] of Object.entries({
    pa: ['platform_admin'],
    sec: ['security'],
    co: ['compliance_officer'],
  })) {
    staff[name] = (await h.platformUser(app, `cloud-${name}`, roles)).jar;
  }
  registry = app.get(AdapterRegistry);
  mock = registry.entry('mock-compute')!.create() as MockComputeAdapter;
  providerIds = Object.fromEntries(
    (await sql(`SELECT id, key FROM cloud.providers`)).map((r) => [r.key, r.id]),
  );
  void app.get(AuditSink);
});
afterAll(() => h.close());

describe('provider registry (FR-CLD-01)', () => {
  it('lists the seeded providers; the simulator is non-production-only and real vendors have no adapter yet', async () => {
    const r = await admin('pa', 'GET', '/v1/admin/providers');
    expect(r.statusCode).toBe(200);
    const by = Object.fromEntries(r.json().items.map((p: Row) => [p.key, p]));
    expect(Object.keys(by).sort()).toEqual(['alibaba', 'cloudpanel', 'contabo', 'huawei', 'mock']);
    expect(by.mock).toMatchObject({
      kind: 'compute',
      adapterId: 'mock-compute',
      environmentPolicy: 'non_production_only',
      adapterAvailable: true,
    });
    // M05 S18-S22 registered the real vendor adapters (documentation-built, NOT VERIFIED); hosting still has none
    for (const k of ['alibaba', 'huawei', 'contabo']) expect(by[k].adapterAvailable).toBe(true);
    expect(by.cloudpanel.adapterAvailable).toBe(false);
  });
  it('enforces platform permissions: security may read but not register; compliance officer has no provider access', async () => {
    expect((await admin('sec', 'GET', '/v1/admin/providers')).statusCode).toBe(200);
    expect(
      (
        await admin('sec', 'POST', '/v1/admin/providers', {
          key: 'x1',
          kind: 'compute',
          adapterId: 'x1-adapter',
        })
      ).statusCode,
    ).toBe(403);
    expect((await admin('co', 'GET', '/v1/admin/providers')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/providers' })).statusCode).toBe(401);
  });
  it('registers a provider once; unknown id is 404', async () => {
    const r = await admin('pa', 'POST', '/v1/admin/providers', {
      key: 'testcloud',
      kind: 'compute',
      adapterId: 'test-compute',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().adapterAvailable).toBe(false);
    expect(
      (
        await admin('pa', 'POST', '/v1/admin/providers', {
          key: 'testcloud',
          kind: 'compute',
          adapterId: 'test-compute',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await admin('pa', 'GET', '/v1/admin/providers/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });
});

describe('provider accounts hold vault references only (FR-CLD-03)', () => {
  it('rejects credential values with 422 credential_value_rejected and never stores them', async () => {
    const attempts: object[] = [
      { providerId: providerIds.mock, name: 'bad1', credentialRef: CANARY },
      {
        providerId: providerIds.mock,
        name: 'bad2',
        credentialRef: 'vault://dev/ok',
        accessKeySecret: CANARY,
      },
      {
        providerId: providerIds.mock,
        name: 'bad3',
        credentialRef: 'vault://dev/ok',
        password: CANARY,
      },
      { providerId: providerIds.mock, name: 'bad4', credentialRef: `https://user:${CANARY}@x` },
    ];
    for (const a of attempts) {
      const r = await admin('pa', 'POST', '/v1/admin/provider-accounts', a);
      expect(r.statusCode).toBe(422);
      expect(r.json().code ?? r.json().type).toMatch(/credential_value_rejected/);
      expect(JSON.stringify(r.json())).not.toContain(CANARY);
    }
    expect(await sql(`SELECT 1 FROM cloud.provider_accounts WHERE name LIKE 'bad%'`)).toHaveLength(
      0,
    );
  });
  it('the database itself refuses a non-vault reference (CHECK), and has no secret column', async () => {
    await expect(
      sql(
        `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, created_by) VALUES (gen_random_uuid(), $1, 'raw', 'AKIA-NOT-A-REF', gen_random_uuid())`,
        [providerIds.mock],
      ),
    ).rejects.toThrow(/provider_accounts_vault_ref_check|check constraint/i);
    const cols = (
      await sql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='cloud' AND table_name='provider_accounts'`,
      )
    ).map((r) => r.column_name);
    expect(
      cols.filter((c: string) => /secret|password|token|key(?!s)/i.test(c) && c !== 'vault_ref'),
    ).toEqual([]);
  });
  it('creates, reads (with ETag), updates with If-Match and refuses stale writes', async () => {
    const a = await newAccount('mock', 'acct-crud');
    expect(a).toMatchObject({
      credentialRef: 'vault://dev/test/acct-crud',
      status: 'active',
      health: { state: 'unknown' },
      verifiedAt: null,
      version: 1,
    });
    const g = await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}`);
    expect(g.headers.etag).toBe('"1"');
    expect(
      (await admin('pa', 'PATCH', `/v1/admin/provider-accounts/${a.id}`, { scopeNote: 'x' }))
        .statusCode,
    ).toBe(428);
    const u = await admin(
      'pa',
      'PATCH',
      `/v1/admin/provider-accounts/${a.id}`,
      {
        scopeNote: 'least-privilege test user',
        spendCap: { amountMinor: '50000', currency: 'SAR' },
      },
      { 'if-match': '"1"' },
    );
    expect(u.statusCode).toBe(200);
    expect(u.json()).toMatchObject({
      scopeNote: 'least-privilege test user',
      spendCap: { amountMinor: '50000', currency: 'SAR' },
      version: 2,
    });
    expect(
      (
        await admin(
          'pa',
          'PATCH',
          `/v1/admin/provider-accounts/${a.id}`,
          { scopeNote: 'y' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await admin(
          'pa',
          'PATCH',
          `/v1/admin/provider-accounts/${a.id}`,
          { credentialSecret: CANARY },
          { 'if-match': '"2"' },
        )
      ).statusCode,
    ).toBe(422);
    expect(
      sink.events.some((e) => e.action === 'provider.account.created' && e.resource?.id === a.id),
    ).toBe(true);
    expect(JSON.stringify(sink.events)).not.toContain(CANARY);
  });
});

describe('verification: capabilities and verified regions come only from the probe (FR-CLD-02)', () => {
  it('before verification every capability is unknown and no region exists', async () => {
    const a = await newAccount('mock', 'acct-unverified');
    const caps = (
      await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/capabilities`)
    ).json().items;
    expect(caps).toHaveLength(12);
    expect(
      caps.every(
        (c: Row) =>
          c.state === 'unknown' && c.effective === 'unsupported' && c.evidenceRef === null,
      ),
    ).toBe(true);
    expect(
      (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/regions`)).json().items,
    ).toHaveLength(0);
  });

  it('verification job: capability matrix with evidence, verified regions with evidence_ref (mock kind), plans, health, audit', async () => {
    const a = await newAccount('mock', 'acct-verify');
    const job = await verify(a.id);
    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({
      health: 'healthy',
      regions: { verified: 2, withdrawn: 0 },
      capabilities: { supported: 11, unsupported: 1, unknown: 0 },
    });
    const caps = (
      await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/capabilities`)
    ).json().items as Row[];
    const sup = caps.filter((c) => c.state === 'supported');
    expect(sup).toHaveLength(11);
    expect(sup.every((c) => /^evidence:[0-9a-f-]{36}$/.test(c.evidenceRef) && c.probedAt)).toBe(
      true,
    );
    expect(caps.find((c) => c.capabilityId === 'compute.quote-api')).toMatchObject({
      state: 'unsupported',
      effective: 'unsupported',
    });
    const regions = (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/regions`)).json()
      .items as Row[];
    expect(regions.map((r) => r.providerRegionId).sort()).toEqual(['mock-eu-1', 'mock-sa-1']); // mock-us-1 is not in the account listing
    for (const r of regions) {
      expect(r).toMatchObject({ state: 'verified', evidenceKind: 'mock' });
      expect(r.evidenceRef).toMatch(/^evidence:/);
      expect(r.verifiedAt).toBeTruthy();
    }
    const plans = (
      await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/plans?region=mock-eu-1`)
    ).json().items as Row[];
    expect(plans.map((p) => `${p.planRef}:${p.availability}`).sort()).toEqual([
      'mock.large:sold_out',
      'mock.medium:available',
      'mock.small:available',
    ]);
    expect(plans.find((p) => p.planRef === 'mock.small')!.providerPrice).toEqual({
      amountMinor: '12',
      currency: 'SAR',
      period: 'hour',
    });
    const acct = (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}`)).json();
    expect(acct.verifiedAt).toBeTruthy();
    expect(acct.health).toMatchObject({ state: 'healthy', breaker: { state: 'closed' } });
    expect(
      sink.events.some((e) => e.action === 'provider.account.verified' && e.resource?.id === a.id),
    ).toBe(true);
    expect(
      sink.events.some(
        (e) => e.action === 'provider.capability.changed' && e.resource?.id === a.id,
      ),
    ).toBe(true);
    // evidence is stored, redacted, append-only
    const ev = await sql(
      `SELECT kind, operation FROM cloud.evidence_items WHERE account_id = $1 ORDER BY operation`,
      [a.id],
    );
    expect(ev.map((e) => `${e.operation}:${e.kind}`)).toEqual(['catalog:mock', 'probe:mock']);
    await expect(
      sql(`UPDATE cloud.evidence_items SET kind = 'live' WHERE account_id = $1`, [a.id]),
    ).rejects.toThrow(/append-only/);
    expect(
      await sql(`SELECT 1 FROM cloud.catalog_snapshots WHERE account_id = $1`, [a.id]),
    ).toHaveLength(1);
  });

  it('a repeated Idempotency-Key returns the same job', async () => {
    const a = await newAccount('mock', 'acct-idem');
    const k = { 'idempotency-key': 'verify-once' };
    const r1 = await admin(
      'pa',
      'POST',
      `/v1/admin/provider-accounts/${a.id}/verification`,
      undefined,
      k,
    );
    const r2 = await admin(
      'pa',
      'POST',
      `/v1/admin/provider-accounts/${a.id}/verification`,
      undefined,
      k,
    );
    expect(r1.json().operationId).toBe(r2.json().operationId);
    await waitJob(r1.json().operationId);
  });

  it('a changed probe changes the matrix (and is audited); an unlisted region is withdrawn and keeps no evidence', async () => {
    const a = await newAccount('mock', 'acct-change');
    await verify(a.id);
    const before = sink.events.filter(
      (e) => e.action === 'provider.capability.changed' && e.resource?.id === a.id,
    ).length;
    mock.setCapabilities({ 'compute.action.resize': 'unsupported', 'compute.metrics': 'unknown' });
    mock.setRegions([
      { id: 'mock-eu-1', country: 'DE', listed: true },
      { id: 'mock-sa-1', country: 'SA', listed: false },
    ]);
    try {
      const j = await verify(a.id);
      expect(j.result.regions).toMatchObject({ verified: 1, withdrawn: 1 });
      const caps = (
        await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/capabilities`)
      ).json().items as Row[];
      expect(caps.find((c) => c.capabilityId === 'compute.action.resize')).toMatchObject({
        state: 'unsupported',
        effective: 'unsupported',
      });
      expect(caps.find((c) => c.capabilityId === 'compute.metrics')).toMatchObject({
        state: 'unknown',
        effective: 'unsupported',
      });
      const reg = (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/regions`)).json()
        .items as Row[];
      expect(reg.find((r) => r.providerRegionId === 'mock-sa-1')).toMatchObject({
        state: 'withdrawn',
        verifiedAt: null,
        evidenceRef: null,
      });
      expect(
        sink.events.filter(
          (e) => e.action === 'provider.capability.changed' && e.resource?.id === a.id,
        ).length,
      ).toBe(before + 1);
      // plans of the withdrawn region are no longer available
      const plans = (
        await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/plans?region=mock-sa-1`)
      ).json().items as Row[];
      expect(plans.every((p) => p.availability === 'unavailable')).toBe(true);
    } finally {
      mock.setCapabilities({
        'compute.action.resize': 'supported',
        'compute.metrics': 'supported',
      });
      mock.setRegions([
        { id: 'mock-eu-1', country: 'DE', listed: true },
        { id: 'mock-sa-1', country: 'SA', listed: true },
        { id: 'mock-us-1', country: 'US', listed: false },
      ]);
    }
  });

  it('catalog sync is a separate job and records price changes without touching capabilities', async () => {
    const a = await newAccount('mock', 'acct-sync');
    await verify(a.id);
    mock.setPrice('mock.small', '15');
    try {
      const r = await admin('pa', 'POST', `/v1/admin/provider-accounts/${a.id}/catalog-syncs`);
      expect(r.statusCode).toBe(202);
      expect((await waitJob(r.json().operationId)).state).toBe('succeeded');
      const p = (
        await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/plans?region=mock-eu-1`)
      )
        .json()
        .items.find((x: Row) => x.planRef === 'mock.small');
      expect(p.providerPrice.amountMinor).toBe('15');
      expect(
        await sql(`SELECT 1 FROM cloud.catalog_snapshots WHERE account_id = $1`, [a.id]),
      ).toHaveLength(2);
    } finally {
      mock.setPrice('mock.small', '12');
    }
  });

  it('a provider without an adapter fails verification honestly (no invented capabilities or regions)', async () => {
    const a = await newAccount('cloudpanel', 'acct-cloudpanel-noadapter');
    const j = await verify(a.id);
    expect(j.state).toBe('failed');
    expect(j.error.code).toBe('adapter_not_available');
    expect(
      await sql(`SELECT 1 FROM cloud.provider_regions WHERE account_id = $1`, [a.id]),
    ).toHaveLength(0);
    expect(
      (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}/capabilities`))
        .json()
        .items.every((c: Row) => c.state === 'unknown'),
    ).toBe(true);
  });

  it('an unresolvable vault reference fails an adapter that needs credentials, without echoing anything secret', async () => {
    const fake = new MockComputeAdapter();
    registry.register({
      adapterId: 'needs-creds',
      nonProductionOnly: true,
      requiresCredentials: true,
      egress: { adapterId: 'needs-creds', hosts: [] },
      create: () => fake as unknown as ComputeAdapter,
    });
    const p = (
      await admin('pa', 'POST', '/v1/admin/providers', {
        key: 'needscreds',
        kind: 'compute',
        adapterId: 'needs-creds',
        environmentPolicy: 'non_production_only',
      })
    ).json();
    providerIds.needscreds = p.id;
    const a = await newAccount('needscreds', 'acct-nocreds', 'vault://dev/test/missing');
    const j = await verify(a.id);
    expect(j.state).toBe('failed');
    expect(j.error.code).toBe('credential_unresolvable');
  });

  it('CANARY: a secret that reaches an adapter error never appears in job results, audit, evidence or any cloud table', async () => {
    const vault = app.get<{ resolve: unknown }>(VAULT);
    const original = vault.resolve;
    vault.resolve = async (ref: string) => {
      const m = {
        ref,
        fields: { accessKeyId: 'AKID-TEST', accessKeySecret: CANARY },
        version: 't',
      };
      registry.redactor.register(m);
      return m;
    };
    const leaky = new MockComputeAdapter();
    leaky.probe = async () => {
      throw new Error(`auth failed for key AKID-TEST secret ${CANARY}`);
    };
    registry.register({
      adapterId: 'leaky-compute',
      nonProductionOnly: true,
      requiresCredentials: true,
      egress: { adapterId: 'leaky-compute', hosts: [] },
      create: () => leaky as unknown as ComputeAdapter,
    });
    try {
      const p = (
        await admin('pa', 'POST', '/v1/admin/providers', {
          key: 'leakycloud',
          kind: 'compute',
          adapterId: 'leaky-compute',
          environmentPolicy: 'non_production_only',
        })
      ).json();
      providerIds.leakycloud = p.id;
      const a = await newAccount('leakycloud', 'acct-leaky', 'vault://dev/test/leaky');
      const j = await verify(a.id);
      expect(j.state).toBe('failed');
      expect(JSON.stringify(j)).not.toContain(CANARY);
      expect(JSON.stringify(sink.events)).not.toContain(CANARY);
      for (const t of [
        'provider_accounts',
        'evidence_items',
        'provider_jobs',
        'provider_capabilities',
        'catalog_snapshots',
        'provider_regions',
        'provider_plans',
      ])
        expect(
          await sql(`SELECT 1 FROM cloud.${t} x WHERE row_to_json(x)::text LIKE $1`, [
            `%${CANARY}%`,
          ]),
        ).toHaveLength(0);
    } finally {
      vault.resolve = original;
    }
  });
});

describe('DB constraints (AC-M05-21)', () => {
  it('a verified region needs verified_at AND evidence_ref; a supported capability needs evidence', async () => {
    const a = await newAccount('mock', 'acct-constraints');
    await expect(
      sql(
        `INSERT INTO cloud.provider_regions (id, account_id, provider_region_id, country_code, state) VALUES (gen_random_uuid(), $1, 'sa-x', 'SA', 'verified')`,
        [a.id],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      sql(
        `INSERT INTO cloud.provider_regions (id, account_id, provider_region_id, country_code, state, verified_at, evidence_ref, evidence_kind) VALUES (gen_random_uuid(), $1, 'sa-y', 'SA', 'verified', now(), NULL, 'live')`,
        [a.id],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      sql(
        `INSERT INTO cloud.provider_capabilities (account_id, capability_id, state, probed_at) VALUES ($1, 'compute.provision', 'supported', now())`,
        [a.id],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      sql(
        `INSERT INTO cloud.provider_capabilities (account_id, capability_id, state, probed_at, evidence_ref) VALUES ($1, 'compute.teleport', 'supported', now(), 'evidence:x')`,
        [a.id],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
  it('runtime role cannot read cloud tables without the platform scope (RLS)', async () => {
    const db = new Db(h.env.appUrl);
    try {
      expect(
        (
          await db.withoutScope((c) =>
            c.query(`SELECT count(*)::int AS n FROM cloud.provider_accounts`),
          )
        ).rows[0]!.n,
      ).toBe(0);
      await expect(
        db.withoutScope((c) =>
          c.query(
            `INSERT INTO cloud.providers (id, key, kind, adapter_id) VALUES (gen_random_uuid(), 'rls-x', 'compute', 'rls-x')`,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        db.withPlatformScope((c) => c.query(`DELETE FROM cloud.provider_regions`)),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.close();
    }
  });
});

describe('health and circuit breaker (S16 task 5)', () => {
  it('health sweep records state; an outage opens the breaker and exposes it; recovery closes it', async () => {
    const a = await newAccount('mock', 'acct-health');
    await verify(a.id);
    const health = app.get(HealthService);
    expect(await health.checkAccount(a.id)).toMatchObject({ state: 'healthy' });
    const breakerCfg = { failureThreshold: 5 };
    mock.inject({ op: 'health', kind: 'outage', times: breakerCfg.failureThreshold });
    for (let i = 0; i < breakerCfg.failureThreshold; i++) await health.checkAccount(a.id);
    const down = (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}`)).json();
    expect(down.health.state).toBe('unhealthy');
    expect(down.health.breaker.state).toBe('open');
    expect(
      sink.events.some(
        (e) => e.action === 'provider.account.health_changed' && e.resource?.id === a.id,
      ),
    ).toBe(true);
    const r = await health.checkAccount(a.id); // faults consumed; adapter is healthy again
    expect(r).toMatchObject({ state: 'healthy' });
    expect(
      (await admin('pa', 'GET', `/v1/admin/provider-accounts/${a.id}`)).json().health.breaker.state,
    ).toBe('closed');
  });
  it('sweep() checks every active account', async () => {
    expect(await app.get(HealthService).sweep()).toBeGreaterThan(0);
  });
});

describe('customers and other realms cannot reach the admin API', () => {
  it('an org session without a platform role is refused', async () => {
    const id = await h.createUser('cloud-customer');
    const jar = await h.sessionFor(app, id);
    const r = await app.inject({
      method: 'GET',
      url: '/v1/admin/provider-accounts',
      headers: { cookie: cookieHeader(jar) },
    });
    expect([401, 403, 404]).toContain(r.statusCode);
  });
});
