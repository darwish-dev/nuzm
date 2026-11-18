import 'reflect-metadata';
import { MockComputeAdapter } from '@nuzm/adapter-mock-compute';
import type { OffsetClock } from '@nuzm/adapter-runtime';
import { Harness, cookieHeader, type App } from '../../identity/testing/app-harness';
import { ResidencyService } from '../../compliance';
import { AdapterRegistry, ProvisioningService, ReconcilerService } from '../index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
export type Row = Record<string, any>;

export const SSH_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@example';

/**
 * Test kit for the M05 compute integration specs: one Nest app on a throwaway database with two customer organizations (A, B), staff users, the
 * feature flag on, a published price book with the three compute meters, the `mock` processor registered in ROPA (so residency can allow it) and one
 * verified `mock` provider account (regions mock-sa-1 in the Kingdom and mock-eu-1 in the EU; the EU is denied by the default platform floor).
 */
export class ComputeKit {
  h = new Harness();
  app!: App;
  sink!: { events: Row[] };
  jars: Record<string, Record<string, string>> = {};
  staff: Record<string, Record<string, string>> = {};
  ids: Record<string, string> = {};
  orgA = '';
  orgB = '';
  accountId = '';
  mock!: MockComputeAdapter;
  registry!: AdapterRegistry;
  prov!: ProvisioningService;
  reconciler!: ReconcilerService;
  private n = 0;

  sql = (q: string, p: unknown[] = []) => this.h.env.sql(q, p) as Promise<Row[]>;
  get clock(): OffsetClock {
    return this.registry.clock as OffsetClock;
  }

  /** Advance the simulated time of the whole cloud module and the provider simulator (they share one clock). */
  advance(ms: number) {
    this.clock.advance(ms);
  }

  call(
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    org: string,
    body?: object,
    headers: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(this.jars[who]!),
        'x-csrf-token': this.jars[who]!.nuzm_csrf ?? '',
        'x-nuzm-org': org,
        'idempotency-key': `k-${++this.n}-${Math.random()}`,
        ...headers,
      },
      ...(body ? { payload: body } : {}),
    });
  }
  admin(
    who: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: object,
    headers: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(this.staff[who]!),
        'x-csrf-token': this.staff[who]!.nuzm_admin_csrf!,
        ...headers,
      },
      ...(body ? { payload: body } : {}),
    });
  }

  async init(opts: { env?: Record<string, string> } = {}) {
    await this.h.init();
    const built = await this.h.buildApp(opts.env ?? {}, undefined, [], { realAudit: false });
    this.app = built.app;
    this.sink = built.sink as unknown as { events: Row[] };
    for (const u of ['alice', 'bob', 'carol']) {
      this.ids[u] = await this.h.createUser(u);
      this.jars[u] = await this.h.sessionFor(this.app, this.ids[u]!);
      await this.h.elevate(this.jars[u]!);
    }
    for (const [name, roles] of Object.entries({
      pa: ['platform_admin'],
      co: ['compliance_officer'],
    }))
      this.staff[name] = (await this.h.platformUser(this.app, `kit-${name}`, roles)).jar;
    const mk = async (who: string, name: string) =>
      (
        await this.app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: {
            cookie: cookieHeader(this.jars[who]!),
            'x-csrf-token': this.jars[who]!.nuzm_csrf!,
          },
          payload: { name },
        })
      ).json().id as string;
    this.orgA = await mk('alice', 'Compute A');
    this.orgB = await mk('bob', 'Compute B');
    await this.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
      [this.orgA, this.ids.carol],
    );
    // the free plan has a hard compute limit of 0 (entitlement), so the test organizations get an explicit override
    for (const org of [this.orgA, this.orgB])
      await this.sql(
        `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, limit_value, allowance, mode) VALUES (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute', 1000000, 0, 'hard')`,
        [org],
      );
    this.registry = this.app.get(AdapterRegistry);
    this.mock = this.registry.entry('mock-compute')!.create() as MockComputeAdapter;
    this.prov = this.app.get(ProvisioningService);
    this.prov.autoKick = false;
    this.reconciler = this.app.get(ReconcilerService);
    await this.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'cloud.provisioning', NULL, 'true'::jsonb)`,
    );
    await this.publishComputePrices();
    await this.registerProcessor('mock');
    await this.verifyAccount();
  }

  async publishComputePrices() {
    const book = (
      await this.sql(
        `INSERT INTO billing.price_books (id, name, currency, status, placeholder) VALUES (gen_random_uuid(), 'compute-test', 'SAR', 'active', false) RETURNING id`,
      )
    )[0]!.id as string;
    const ver = (
      await this.sql(
        `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from, note) VALUES (gen_random_uuid(), $1, 1, 'draft', '2026-01-01T00:00:00Z', 'compute test prices') RETURNING id`,
        [book],
      )
    )[0]!.id as string;
    for (const [meter, price] of [
      ['compute.vcpu_hours', 1],
      ['compute.memory_gb_hours', 0.5],
      ['compute.disk_gb_months', 2],
    ] as const)
      await this.sql(
        `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor, included_allowance, rounding) VALUES (gen_random_uuid(), $1, $2, 'flat', $3, 0, 'half_up')`,
        [ver, meter, price],
      );
    await this.sql(
      `UPDATE billing.price_book_versions SET status = 'published', published_by = gen_random_uuid(), published_at = now() WHERE id = $1`,
      [ver],
    );
  }

  private ropaVersions = new Map<string, number>();
  /**
   * Registers (or, with `present=false`, removes) a provider as a PROCESSOR in the ROPA — the residency service denies an unregistered processor.
   * The processor NAME must equal the provider key (`mock`, `alibaba`, ...): that is how offers, quotes and provisioning name it.
   */
  async registerProcessor(name: string, present = true) {
    const entryKey = `activity:compute-${name}`;
    const base = this.ropaVersions.get(entryKey);
    const r = await this.admin('co', 'POST', '/v1/admin/compliance/ropa', {
      entryKey,
      activity: 'Compute provisioning',
      purpose: 'Provision customer compute instances',
      dataClasses: ['customer-content'],
      processors: present
        ? [
            {
              name,
              role: 'processor',
              region: 'other',
              dataClasses: ['customer-content'],
              contractRef: 'TEST-FIXTURE',
            },
          ]
        : [],
      regions: ['SA'],
      status: 'draft',
      ...(base ? { baseVersion: base } : {}),
    });
    if (r.statusCode !== 201) throw new Error(`ROPA upsert failed: ${r.statusCode} ${r.body}`);
    this.ropaVersions.set(entryKey, r.json().version as number);
    this.app.get(ResidencyService).invalidate(); // the residency service caches policy data for a short TTL
  }

  async verifyAccount(name = 'kit-mock') {
    const providers = await this.sql(`SELECT id FROM cloud.providers WHERE key = 'mock'`);
    const a = await this.admin('pa', 'POST', '/v1/admin/provider-accounts', {
      providerId: providers[0]!.id,
      name,
      credentialRef: `vault://dev/test/${name}`,
    });
    this.accountId = a.json().id;
    await this.verify(this.accountId);
  }

  async verify(accountId = this.accountId) {
    const r = await this.admin(
      'pa',
      'POST',
      `/v1/admin/provider-accounts/${accountId}/verification`,
    );
    const job = await this.waitJob(r.json().operationId);
    if (job.state !== 'succeeded') throw new Error(`verification failed: ${JSON.stringify(job)}`);
    return job;
  }

  async waitJob(id: string) {
    for (let i = 0; i < 200; i++) {
      const j = (await this.admin('pa', 'GET', `/v1/admin/provider-jobs/${id}`)).json();
      if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job did not finish');
  }

  async imageId(region = 'mock-sa-1', ref = 'mock-ubuntu') {
    return (
      await this.sql(
        `SELECT id FROM compute.images WHERE account_id = $1 AND provider_region_id = $2 AND image_ref = $3`,
        [this.accountId, region, ref],
      )
    )[0]!.id as string;
  }

  /** Customer quote for a SA compute instance (automatic routing by default). */
  async quote(who: string, org: string, over: Record<string, unknown> = {}) {
    return this.call(who, 'POST', '/v1/quotes', org, {
      kind: 'compute',
      routing: { mode: 'automatic', country: 'SA' },
      spec: { imageId: await this.imageId(), count: 1 },
      term: { period: 'month' },
      ...over,
    });
  }

  /** quote → POST instance; returns ids. The operation is PENDING (autoKick is off): tests run it with `prov.run`. */
  async createInstance(
    who: string,
    org: string,
    quoteOver: Record<string, unknown> = {},
    name = 'web-1',
    headers: Record<string, string> = {},
  ) {
    const q = await this.quote(who, org, quoteOver);
    if (q.statusCode !== 201) throw new Error(`quote failed: ${q.statusCode} ${q.body}`);
    const quoteId = q.json().id as string;
    const r = await this.call(
      who,
      'POST',
      '/v1/compute/instances',
      org,
      { quoteId, name, sshPublicKeys: [SSH_KEY], tags: { env: 'test' } },
      headers,
    );
    if (r.statusCode !== 202 && !headers['x-allow-fail'])
      throw new Error(`create instance failed: ${r.statusCode} ${r.body}`);
    return {
      quote: q,
      quoteId,
      res: r,
      instanceId: r.json().instance?.id as string,
      operationId: r.json().operationId as string,
    };
  }

  async runOp(org: string, operationId: string) {
    await this.prov.run(org, operationId, 'test-worker');
    return (await this.sql(`SELECT * FROM platform.operations WHERE id = $1`, [operationId]))[0]!;
  }

  instanceRow = async (id: string) =>
    (
      await this.sql(
        `SELECT i.*, r.state AS rstate, r.provider_ref, r.drift_state, r.provision_token, r.id AS rid FROM compute.instances i JOIN cloud.resources r ON r.id = i.resource_id WHERE i.id = $1`,
        [id],
      )
    )[0]!;

  async close() {
    await this.h.close();
  }
}
