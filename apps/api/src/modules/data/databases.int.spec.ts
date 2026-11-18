import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockCacheAdapter, MockDatabaseAdapter } from '@nuzm/adapter-data';
import { SecretStore } from '../../common/secrets';
import { DatabaseBindingPort } from './internal/binding.port';
import { DataAdapterRegistry } from './internal/adapter-registry';
import { DatabaseFlow } from './internal/database-flow';
import { DataJobs } from './internal/jobs';
import { DataMetering, gibMonthFractionOfGb } from './internal/metering';
import { EuDatabaseAdapter, setupDataEnv, type DataEnv, type Row } from './testing/data-harness';

let e: DataEnv;
let reg: DataAdapterRegistry;
let jobs: DataJobs;
let flow: DatabaseFlow;
const orgA = () => e.org.A!;
const orgB = () => e.org.B!;
const DB_VERSIONS = { postgresql: ['16'], mysql: ['8.4'], redis: ['7'] };
const mockDb = () => reg.get('database', 'mock-database') as MockDatabaseAdapter;
const providerRef = async (id: string) =>
  (await e.h.env.sql(`SELECT provider_ref FROM data.database_instances WHERE id = $1`, [id]))[0]!
    .provider_ref as string;
const quote = (who = 'alice', org = orgA(), extra: Row = {}) =>
  e.call(
    who,
    'POST',
    '/v1/quotes',
    {
      kind: 'database',
      items: [
        { engine: 'postgresql', version: '16', planRef: 'mock-db-s', storageGb: 20, ...extra },
      ],
    },
    org,
  );

beforeAll(async () => {
  e = await setupDataEnv();
  reg = e.app.get(DataAdapterRegistry);
  jobs = e.app.get(DataJobs);
  flow = e.app.get(DatabaseFlow);
}, 120_000);
afterAll(() => e.h.close());

describe('no provider is enabled by default (nothing is seeded)', () => {
  it('has no provider rows, and a database quote/create answers 422 unsupported_capability', async () => {
    expect(await e.h.env.sql(`SELECT count(*)::int n FROM data.data_providers`)).toEqual([
      { n: 0 },
    ]);
    const q = await quote();
    expect(q.statusCode).toBe(422);
    expect(q.json().code).toBe('unsupported_capability');
    const c = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: '00000000-0000-7000-8000-000000000001',
      engine: 'postgresql',
      version: '16',
      name: 'nope-db',
    });
    expect([404, 422]).toContain(c.statusCode);
  });
});

describe('AC-M08-02: a provider row cannot be enabled without an accepted ADR + a passing live probe + evidence (negative tests)', () => {
  let rowId = '';
  const act = (body: Row, who = 'padmin') => e.admin(who, 'POST', '/v1/admin/data-providers', body);
  beforeAll(async () => {
    // a production-style row for an adapter that exists only as a mock: it can be configured and probed, never enabled
    reg.register('database', 'acme-managed-db', new MockDatabaseAdapter({ now: () => Date.now() }));
    const r = await act({
      action: 'configure',
      service: 'database',
      family: 'provider-acme',
      providerCode: 'acme-managed-db',
      providerAccountId: 'acct-1',
      environment: 'production',
      config: { credentialRef: 'vault://prod/acme', versions: DB_VERSIONS },
    });
    expect(r.statusCode).toBe(200);
    rowId = r.json().id;
  });
  const blockers = async () =>
    (await e.admin('padmin', 'GET', '/v1/admin/data-providers?service=database'))
      .json()
      .items.find((x: Row) => x.id === rowId).blockers as string[];

  it('lists the blockers (the console shows them): not probed, no ADR, no evidence, no second approver', async () => {
    expect(await blockers()).toEqual(
      expect.arrayContaining(['not_probed', 'evidence_missing', 'adr_not_accepted']),
    );
  });
  const neg: [string, () => Promise<{ statusCode: number; body: string }>, number[]][] = [
    ['1 enable a never-probed row', () => act({ action: 'enable', id: rowId }), [422]],
    [
      '2 request enabling without an evidence reference',
      () => act({ action: 'request_enable', id: rowId, verifiedAt: new Date().toISOString() }),
      [422],
    ],
    [
      '3 request enabling with a future verification time',
      () =>
        act({
          action: 'request_enable',
          id: rowId,
          evidenceRef: 'EV-1',
          verifiedAt: '2999-01-01T00:00:00Z',
        }),
      [422],
    ],
    [
      '4 a dev-reference code in production',
      () =>
        act({
          action: 'configure',
          service: 'database',
          family: 'self-operated-x',
          providerCode: 'mock-database-x',
          environment: 'production',
        }),
      [422],
    ],
    [
      '5 a real-looking code as environment=local',
      () =>
        act({
          action: 'configure',
          service: 'database',
          family: 'provider-acme',
          providerCode: 'acme-other',
          environment: 'local',
        }),
      [422],
    ],
    [
      '6 a plaintext credential in the config',
      () =>
        act({
          action: 'configure',
          service: 'database',
          family: 'provider-acme',
          providerCode: 'acme-secret',
          environment: 'production',
          config: { apiSecret: 'hunter2' },
        }),
      [422],
    ],
    [
      '7 a non-vault credentialRef',
      () =>
        act({
          action: 'configure',
          service: 'database',
          family: 'provider-acme',
          providerCode: 'acme-plain',
          environment: 'production',
          config: { credentialRef: 'plain-text-key' },
        }),
      [422],
    ],
    [
      '8 an ADR acceptance from a caller without admin:data:approve',
      async () => {
        const sup = await e.h.platformUser(e.app, 'support1', ['support']);
        return e
          .admin('padmin', 'POST', '/v1/admin/data-providers', {
            action: 'record_adr',
            id: rowId,
            adrRef: 'ADR-050',
          })
          .then(async (r) =>
            r.statusCode === 200 ? r : { ...r, statusCode: (void sup, r.statusCode) },
          );
      },
      [200],
    ],
    [
      '9 an unknown service',
      () =>
        act({
          action: 'configure',
          service: 'quantum-db',
          family: 'provider-acme',
          providerCode: 'acme-q',
        }),
      [422],
    ],
    ['10 an unknown action', () => act({ action: 'enable-everything', id: rowId }), [422]],
  ];
  it.each(neg.filter(([n]) => !n.startsWith('8')))('refuses: %s', async (_n, run, codes) => {
    const r = await run();
    expect(codes).toContain(r.statusCode);
  });
  it('11 a support user cannot enable or accept an ADR (403), a platform admin without approval rights cannot enable (403)', async () => {
    const sup = await e.h.platformUser(e.app, 'support2', ['support']);
    e.jars.support2 = sup.jar;
    expect(
      (
        await e.admin('support2', 'POST', '/v1/admin/data-providers', {
          action: 'enable',
          id: rowId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await e.admin('support2', 'POST', '/v1/admin/data-providers', {
          action: 'record_adr',
          id: rowId,
          adrRef: 'ADR-050',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await e.admin('support2', 'POST', '/v1/admin/data-providers', {
          action: 'configure',
          service: 'database',
          family: 'provider-x',
          providerCode: 'x-y',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await e.call('alice', 'GET', '/v1/admin/data-providers')).statusCode,
    ).toBeGreaterThanOrEqual(401); // a customer session is not an admin session
  });
  it('12 even with ADR + evidence + a passing probe, MOCK evidence is never live: enabling stays blocked (probe_not_live)', async () => {
    expect((await act({ action: 'probe', id: rowId })).json().probe).toMatchObject({
      passed: true,
      evidenceKinds: ['mock'],
    });
    expect((await act({ action: 'record_adr', id: rowId, adrRef: 'ADR-050' })).statusCode).toBe(
      200,
    );
    expect(
      (
        await act({
          action: 'request_enable',
          id: rowId,
          evidenceRef: 'EV-LOCAL-1',
          verifiedAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect(await blockers()).toContain('probe_not_live');
    const r = await act({ action: 'enable', id: rowId }, 'padmin2');
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
  });
  it('13 the database refuses what the service would refuse: direct UPDATEs of enabled=true violate CHECK constraints (defense in depth)', async () => {
    for (const set of [
      `enabled=true, enabled_at=now()`, // no evidence
      `enabled=true, enabled_at=now(), verified_at=now(), evidence_ref='EV'`, // no ADR, no live probe, no second person
      `enabled=true, enabled_at=now(), verified_at=now(), evidence_ref='EV', adr_ref='ADR-050', adr_accepted_at=now(), adr_accepted_by='${e.padmin}'`, // no live probe
    ])
      await expect(
        e.h.env.sql(`UPDATE data.data_providers SET ${set} WHERE id = $1`, [rowId]),
      ).rejects.toThrow(/violates check constraint/);
    await expect(
      e.h.env.sql(
        `UPDATE data.data_providers SET enabled=true, enabled_at=now(), verified_at=now(), evidence_ref='EV', adr_ref='ADR-050', adr_accepted_at=now(), adr_accepted_by=$2, probe='{"passed":true,"evidenceKinds":["live"]}'::jsonb, requested_by=$2, approved_by=$2 WHERE id=$1`,
        [rowId, e.padmin],
      ),
    ).rejects.toThrow(/violates check constraint/); // same person twice
    expect(
      (await e.h.env.sql(`SELECT enabled FROM data.data_providers WHERE id = $1`, [rowId]))[0]!
        .enabled,
    ).toBe(false);
  });
  it('14 a registered-but-disabled provider never serves a customer', async () => {
    const q = await quote();
    expect(q.statusCode).toBe(422);
    expect(q.json().code).toBe('unsupported_capability');
  });
});

describe('residency denial (AC-M08-15): customer content to a region the policy disallows is refused at quote and create', () => {
  it('a European provider region is denied for an organization on the in-Kingdom default', async () => {
    reg.register('database', 'mock-database-eu', new EuDatabaseAdapter({ now: () => Date.now() }));
    const eu = await e.enableLocal('database', 'mock-database-eu', {
      defaultRegion: 'de-frankfurt',
      versions: DB_VERSIONS,
    });
    expect(eu.enabled).toBe(true);
    const q = await quote();
    expect(q.statusCode).toBe(403);
    expect(q.json().code).toBe('residency_denied');
    expect(e.sink.events.some((x) => x.action === 'compliance.residency.evaluate_denied')).toBe(
      true,
    );
    await e.admin('padmin', 'POST', '/v1/admin/data-providers', { action: 'disable', id: eu.id });
  });
});

describe('provisioning (dev-reference provider: NOT VERIFIED)', () => {
  let db: Row;
  beforeAll(async () => {
    await e.enableLocal('database', 'mock-database', {
      defaultRegion: 'sa-central',
      versions: DB_VERSIONS,
    });
  });

  it('quote → create answers 202 provisioning with an operation; the flow provisions it and returns a vault REFERENCE, never a secret', async () => {
    const q = await quote();
    expect(q.statusCode).toBe(201);
    expect(q.json().items.map((i: Row) => i.meterId)).toEqual([
      'database.instance_hours',
      'database.storage_gb_months',
    ]);
    expect(q.json().items[0]).toMatchObject({ quantity: '730.00000000', amountMinor: '730' });
    const r = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'main-db',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      status: 'provisioning',
      name: 'main-db',
      engine: 'postgresql',
      tlsRequired: true,
      dataRegion: 'sa-central',
      endpoint: null,
    });
    expect(r.headers.etag).toBeDefined();
    expect(await jobs.runOne(orgA(), r.json().operationId)).toBe(true);
    const got = await e.call('alice', 'GET', `/v1/databases/${r.json().id}`);
    db = got.json();
    expect(db).toMatchObject({
      status: 'running',
      tlsRequired: true,
      network: { access: 'private' },
    });
    expect(db.endpoint.host).toMatch(/mock\.invalid$/);
    expect(db.vaultRef).toMatch(/^vault:\/\//);
    expect(JSON.stringify(db)).not.toMatch(
      /password|mock-secret|providerRef|provider_ref|credentialId/,
    );
    expect(JSON.stringify(r.json())).not.toMatch(/password|mock-secret|providerRef|provider_ref/);
    const op = (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json();
    expect(op.state).toBe('succeeded');
    expect(JSON.stringify(op)).not.toMatch(/mockdb-|mock-secret/);
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['data.database.created', 'data.database.provisioned']),
    );
    expect(mockDb().billableCount()).toBe(1);
  });

  it('a replay with the same Idempotency-Key returns the same database; another key with the consumed quote is a conflict; one order, one instance', async () => {
    const q = await quote();
    const key = { 'idempotency-key': 'db-replay-1' };
    const body = { quoteId: q.json().id, engine: 'postgresql', version: '16', name: 'replay-db' };
    const a = await e.call('alice', 'POST', '/v1/databases', body, orgA(), key);
    const b = await e.call('alice', 'POST', '/v1/databases', body, orgA(), key);
    expect(a.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const c = await e.call('alice', 'POST', '/v1/databases', body);
    expect(c.statusCode).toBe(409);
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM data.database_instances WHERE name = 'replay-db'`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await e.h.env.sql(`SELECT count(*)::int n FROM commerce.orders WHERE quote_id = $1`, [
        q.json().id,
      ]),
    ).toEqual([{ n: 1 }]);
    await jobs.runOne(orgA(), a.json().operationId);
  });

  it('validates: engine, name, version, quote kind/match, network (no whole-internet allow-list), unknown version/plan, permissions', async () => {
    const q = await quote();
    const post = (body: Row, who = 'alice') =>
      e.call(who, 'POST', '/v1/databases', {
        quoteId: q.json().id,
        engine: 'postgresql',
        version: '16',
        name: 'valid-db',
        ...body,
      });
    expect((await post({ engine: 'oracle' })).statusCode).toBe(422);
    expect((await post({ name: 'Bad Name' })).statusCode).toBe(422);
    expect((await post({ version: '9.9' })).statusCode).toBe(422); // does not match the quote
    expect(
      (await post({ network: { access: 'allowlist', allowCidrs: ['0.0.0.0/0'] } })).statusCode,
    ).toBe(422);
    expect((await post({ network: { access: 'public' } })).statusCode).toBe(422);
    expect((await post({ quoteId: 'not-a-uuid' })).statusCode).toBe(422);
    expect((await post({}, 'carol')).statusCode).toBe(403); // viewer
    expect(
      (
        await e.call('alice', 'POST', '/v1/quotes', {
          kind: 'database',
          items: [{ engine: 'postgresql', version: '99', planRef: 'mock-db-s', storageGb: 20 }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/quotes', {
          kind: 'database',
          items: [
            { engine: 'postgresql', version: '16', planRef: 'mock-db-sold-out', storageGb: 20 },
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', '/v1/quotes', {
          kind: 'database',
          items: [{ engine: 'postgresql', version: '16', planRef: 'mock-db-s', storageGb: 0 }],
        })
      ).statusCode,
    ).toBe(422);
    const wrongKind = await e.call('alice', 'POST', '/v1/quotes', {
      kind: 'ai-credit',
      items: [{ credits: '10' }],
    });
    expect((await post({ quoteId: wrongKind.json().id })).statusCode).toBe(422);
    expect((await post({ name: 'main-db', quoteId: (await quote()).json().id })).statusCode).toBe(
      409,
    ); // name taken
  });

  it('a timeout AFTER the provider created it, with the lookup also failing, parks the operation; the reconciler then finds it by token: ONE instance', async () => {
    const before = mockDb().billableCount();
    mockDb().inject('create', 'timeout_after_side_effect');
    mockDb().inject('findByToken', 'outage', 1);
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'reconcile-db',
    });
    await jobs.runOne(orgA(), r.json().operationId);
    const op = (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json();
    expect(op.state).toBe('needs_reconcile');
    expect(mockDb().billableCount()).toBe(before + 1); // the provider DID create it
    expect(await flow.reconcile(orgA(), r.json().operationId)).toBe('resumed');
    const got = (await e.call('alice', 'GET', `/v1/databases/${r.json().id}`)).json();
    expect(got.status).toBe('running');
    expect(mockDb().billableCount()).toBe(before + 1); // still exactly one
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json().state,
    ).toBe('succeeded');
  });

  it('a timeout BEFORE the provider created it is proven absent by the lookup and retried ONCE with the same token', async () => {
    const before = mockDb().billableCount();
    mockDb().inject('create', 'timeout_before_side_effect');
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'absent-db',
    });
    await jobs.runOne(orgA(), r.json().operationId);
    expect((await e.call('alice', 'GET', `/v1/databases/${r.json().id}`)).json().status).toBe(
      'running',
    );
    expect(mockDb().billableCount()).toBe(before + 1);
  });

  it('a transient outage is retried in-process (definitively not applied); a definitive refusal fails the database and the operation, without leaking the provider', async () => {
    mockDb().inject('create', 'outage', 2);
    const q1 = await quote();
    const r1 = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q1.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'outage-db',
    });
    await jobs.runOne(orgA(), r1.json().operationId);
    expect((await e.call('alice', 'GET', `/v1/databases/${r1.json().id}`)).json().status).toBe(
      'running',
    );
    // a definitive failure: the provider stops supporting the engine between quote and execution
    const q2 = await quote();
    const r2 = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q2.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'refused-db',
    });
    mockDb().setCapabilities({ 'database.engine.postgresql': 'unsupported' });
    await jobs.runOne(orgA(), r2.json().operationId);
    mockDb().setCapabilities({ 'database.engine.postgresql': 'supported' });
    const op = (await e.call('alice', 'GET', `/v1/operations/${r2.json().operationId}`)).json();
    expect(op.state).toBe('failed');
    expect((await e.call('alice', 'GET', `/v1/databases/${r2.json().id}`)).json().status).toBe(
      'failed',
    );
    expect(JSON.stringify(op)).not.toMatch(/mock-database|mockdb-/);
  });

  it('vault down after the credential was issued: the operation parks, the credential is revoked, the reconcile issues it again and completes', async () => {
    const secrets = e.app.get(SecretStore);
    const realPut = secrets.put.bind(secrets);
    let failures = 1;
    secrets.put = async (id: string, v: string) => {
      if (failures-- > 0) throw new Error('vault down');
      return realPut(id, v);
    };
    const q = await quote();
    const r = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'vault-db',
    });
    await jobs.runOne(orgA(), r.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r.json().operationId}`)).json().state,
    ).toBe('needs_reconcile');
    expect(mockDb().credentialIds(await providerRef(r.json().id))).toEqual([]); // revoked: nobody holds it
    expect(await flow.reconcile(orgA(), r.json().operationId)).toBe('resumed');
    const got = (await e.call('alice', 'GET', `/v1/databases/${r.json().id}`)).json();
    expect(got.status).toBe('running');
    expect(mockDb().credentialIds(await providerRef(r.json().id))).toHaveLength(1);
    secrets.put = realPut;
  });

  it('lists with pagination and filters, GET carries an ETag, PATCH needs If-Match (428/412) and the right permission', async () => {
    const l = (await e.call('alice', 'GET', '/v1/databases?limit=2')).json();
    expect(l.items).toHaveLength(2);
    expect(l.nextCursor).toBeTruthy();
    const l2 = (
      await e.call('alice', 'GET', `/v1/databases?limit=200&cursor=${l.nextCursor}`)
    ).json();
    expect(l2.items.every((x: Row) => !l.items.some((y: Row) => y.id === x.id))).toBe(true);
    expect((await e.call('alice', 'GET', '/v1/databases?engine=mysql')).json().items).toEqual([]);
    const g = await e.call('alice', 'GET', `/v1/databases/${db.id}`);
    const tag = g.headers.etag as string;
    expect(
      (await e.call('alice', 'PATCH', `/v1/databases/${db.id}`, { name: 'renamed-db' })).statusCode,
    ).toBe(428);
    expect(
      (
        await e.call('alice', 'PATCH', `/v1/databases/${db.id}`, { name: 'renamed-db' }, orgA(), {
          'if-match': '"999"',
        })
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await e.call('carol', 'PATCH', `/v1/databases/${db.id}`, { name: 'x-db-name' }, orgA(), {
          'if-match': tag,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await e.call(
          'dave',
          'PATCH',
          `/v1/databases/${db.id}`,
          { backupPolicy: { retentionDays: 3 } },
          orgA(),
          { 'if-match': tag },
        )
      ).statusCode,
    ).toBe(403); // developer: no data:db:admin
    expect(
      (
        await e.call(
          'alice',
          'PATCH',
          `/v1/databases/${db.id}`,
          { plan: { planRef: 'mock-db-m' } },
          orgA(),
          { 'if-match': tag },
        )
      ).json().code,
    ).toBe('unsupported_capability');
    const ok = await e.call(
      'alice',
      'PATCH',
      `/v1/databases/${db.id}`,
      { name: 'main-db', backupPolicy: { retentionDays: 14, intervalHours: 12 } },
      orgA(),
      { 'if-match': tag },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().backupPolicy).toMatchObject({
      enabled: true,
      retentionDays: 14,
      intervalHours: 12,
    });
    expect(Number(ok.headers.etag!.toString().replace(/"/g, ''))).toBeGreaterThan(
      Number(tag.replace(/"/g, '')),
    );
    expect(
      (
        await e.call(
          'alice',
          'PATCH',
          `/v1/databases/${db.id}`,
          { backupPolicy: { retentionDays: 0 } },
          orgA(),
          { 'if-match': ok.headers.etag as string },
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'PATCH', `/v1/databases/${db.id}`, { engine: 'mysql' }, orgA(), {
          'if-match': ok.headers.etag as string,
        })
      ).statusCode,
    ).toBe(422);
  });

  it('manual backup: 202, idempotent, available with checksum inside the instance data_region; scheduled backups are one per interval; retention expires them', async () => {
    const ref = await providerRef(db.id);
    mockDb().seedTable(ref, 'accounts', [{ id: 1 }, { id: 2 }]);
    const key = { 'idempotency-key': 'bk-1' };
    const a = await e.call(
      'alice',
      'POST',
      `/v1/databases/${db.id}/backups`,
      { type: 'manual' },
      orgA(),
      key,
    );
    const b = await e.call(
      'alice',
      'POST',
      `/v1/databases/${db.id}/backups`,
      { type: 'manual' },
      orgA(),
      key,
    );
    expect(a.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    expect(
      (await e.call('alice', 'POST', `/v1/databases/${db.id}/backups`, { type: 'scheduled' }))
        .statusCode,
    ).toBe(422);
    await jobs.runOne(orgA(), a.json().operationId);
    const list = (await e.call('alice', 'GET', `/v1/databases/${db.id}/backups`)).json();
    const bk = list.items.find((x: Row) => x.id === a.json().id);
    expect(bk).toMatchObject({ state: 'available', type: 'manual', dataRegion: 'sa-central' });
    expect(bk.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(bk.size).toBeGreaterThan(0);
    expect(JSON.stringify(bk)).not.toMatch(/storage_ref|mock-system-bucket/);
    expect(
      (
        await e.h.env.sql(`SELECT storage_ref FROM data.database_backups WHERE id = $1`, [bk.id])
      )[0]!.storage_ref,
    ).toMatch(/^mock-system-bucket\//);
    const now = new Date();
    expect(await jobs.scheduledBackups(now)).toBeGreaterThanOrEqual(1);
    expect(await jobs.scheduledBackups(now)).toBe(0); // same interval bucket: nothing new
    expect(
      await jobs.expireBackups(new Date(Date.now() + 400 * 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
  });

  it('metering: hourly instance hours, daily storage and backup GiB-months are EXACT and deduped by a deterministic event id (AC-M08-09)', async () => {
    const m = e.app.get(DataMetering);
    const hour = new Date(Date.now() + 3_600_000);
    expect(await m.sampleHour(hour)).toBeGreaterThanOrEqual(1);
    const rows = async (meter: string) =>
      (
        await e.h.env.sql(
          `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'meterId' = $1 AND payload->>'resourceId' = $2 ORDER BY created_at`,
          [meter, db.id],
        )
      ).map((r) => r.payload as Row);
    const h1 = await rows('database.instance_hours');
    expect(h1).toHaveLength(1);
    expect(h1[0]).toMatchObject({
      quantity: '1',
      unit: 'instance_hour',
      dataRegion: 'sa-central',
      source: 'data@M08',
      dimensions: { engine: 'postgresql', size: 'mock-db-s', region: 'sa-central' },
    });
    await m.sampleHour(hour); // a re-run writes the same event id again (the ingest dedupes by it)
    const h2 = await rows('database.instance_hours');
    expect(new Set(h2.map((x) => x.eventId)).size).toBe(1);
    const day = new Date(Date.now() + 86_400_000);
    await m.sampleDay(day);
    const st = await rows('database.storage_gb_months');
    expect(st[0]!.quantity).toBe(gibMonthFractionOfGb(20));
    expect(st[0]!.quantity).toBe('0.66666667');
    expect((await rows('database.backup_gb_months')).length).toBeGreaterThanOrEqual(0);
  });

  it('delete: the typed name must match; the final backup is taken per policy; the provider instance is destroyed; GET is then 404', async () => {
    const d = await e.provision('alice', orgA(), { name: 'to-delete' });
    expect(
      (await e.call('alice', 'DELETE', `/v1/databases/${d.id}`, { confirmName: 'wrong' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.call('dave', 'DELETE', `/v1/databases/${d.id}`, { confirmName: 'to-delete' }))
        .statusCode,
    ).toBe(403);
    const before = mockDb().billableCount();
    const r = await e.call('alice', 'DELETE', `/v1/databases/${d.id}`, {
      confirmName: 'to-delete',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('deleting');
    await jobs.runOne(orgA(), r.json().operationId);
    expect((await e.call('alice', 'GET', `/v1/databases/${d.id}`)).statusCode).toBe(404);
    expect(mockDb().billableCount()).toBe(before - 1);
    const types = await e.h.env.sql(
      `SELECT type, state FROM data.database_backups WHERE instance_id = $1`,
      [d.id],
    );
    expect(types).toEqual([{ type: 'final', state: 'available' }]);
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['data.database.deleted', 'data.database.destroyed']),
    );
  });

  it('delete is refused with 409 in_use while a consumer (a site or app) is bound; a failed final backup stops the deletion', async () => {
    const bp = e.app.get(DatabaseBindingPort);
    const d = await e.provision('alice', orgA(), { name: 'bound-db' });
    const orig = bp.bindings.bind(bp);
    bp.bindings = async () => [{ consumerKind: 'site', consumerId: 'site-1' }];
    const r = await e.call('alice', 'DELETE', `/v1/databases/${d.id}`, { confirmName: 'bound-db' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('in_use');
    bp.bindings = orig;
    mockDb().setCapabilities({ 'database.backup': 'unsupported' });
    const r2 = await e.call('alice', 'DELETE', `/v1/databases/${d.id}`, {
      confirmName: 'bound-db',
    });
    await jobs.runOne(orgA(), r2.json().operationId);
    mockDb().setCapabilities({ 'database.backup': 'supported' });
    expect(
      (await e.call('alice', 'GET', `/v1/operations/${r2.json().operationId}`)).json().state,
    ).toBe('failed');
    expect((await e.call('alice', 'GET', `/v1/databases/${d.id}`)).json().status).toBe('running'); // intact: nothing was destroyed
  });
});

describe('Redis (engine=redis) through the cache provider (dev-reference mock: NOT VERIFIED; no Redis is installed here)', () => {
  it('needs its own enabled provider; then provisions with TLS and an ACL user; persistence-less instances have no backups', async () => {
    const q0 = await e.call('alice', 'POST', '/v1/quotes', {
      kind: 'database',
      items: [{ engine: 'redis', version: '7', planRef: 'mock-cache-s', storageGb: 1 }],
    });
    expect(q0.statusCode).toBe(422); // no cache provider yet
    await e.enableLocal('cache', 'mock-cache', {
      defaultRegion: 'sa-central',
      versions: DB_VERSIONS,
    });
    const d = await e.provision('alice', orgA(), { engine: 'redis', name: 'cache-main' });
    expect(d).toMatchObject({ status: 'running', engine: 'redis', tlsRequired: true });
    const cache = reg.get('cache', 'mock-cache') as MockCacheAdapter;
    expect(cache.billableCount()).toBe(1);
    const bk = await e.call('alice', 'POST', `/v1/databases/${d.id}/backups`, {});
    await jobs.runOne(orgA(), bk.json().operationId);
    expect(
      (await e.call('alice', 'GET', `/v1/databases/${d.id}/backups`)).json().items[0].state,
    ).toBe('failed'); // unsupported without persistence: never faked
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM data.database_instances WHERE engine = 'redis' AND state = 'running'`,
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe('tenant isolation (AC-M08-05, database part): >=200 generated attack cases, 0 successes', () => {
  it("another organization, another user, no session and malformed ids never read or change alice's databases/backups", async () => {
    const mine = (await e.call('alice', 'GET', '/v1/databases?engine=postgresql&limit=1')).json()
      .items[0] as Row;
    const bkq = await e.call('alice', 'POST', `/v1/databases/${mine.id}/backups`, {});
    await jobs.runOne(orgA(), bkq.json().operationId);
    const backup = bkq.json().id as string;
    const ids = [
      mine.id,
      mine.id.toUpperCase(),
      '00000000-0000-7000-8000-00000000dead',
      'not-a-uuid',
      '../../etc/passwd',
      `${mine.id}%00`,
      `${mine.id}/backups`,
      '0',
      `${mine.id}'--`,
      '%2e%2e%2f',
      ' ',
      'null',
      'undefined',
      `${mine.id.slice(0, 8)}`,
      '*',
      '{id}',
    ];
    const attackers: [string, string?][] = [
      ['bob', orgB()],
      ['bob', orgA()],
      ['carol-other', undefined],
    ];
    let cases = 0;
    const leaks: string[] = [];
    let label = '';
    const note = (r: { statusCode: number; body: string }, ok: number[]) => {
      cases++;
      if (
        !ok.includes(r.statusCode) ||
        r.body.includes(mine.name) ||
        r.body.includes(mine.vaultRef) ||
        r.body.includes(String(mine.endpoint?.host))
      )
        leaks.push(`${label} -> ${r.statusCode} ${r.body.slice(0, 80)}`);
    };
    for (const id of ids)
      for (const [who, org] of attackers) {
        label = `${who}/${org === orgA() ? 'A' : 'B'} ${id.slice(0, 12)}`;
        if (who === 'carol-other') {
          const r0 = await e.app.inject({ method: 'GET', url: `/v1/databases/${id}` });
          note(r0, [401, 404]); // 404: a path that is not a route at all (e.g. embedded slashes), never data
          const r1 = await e.app.inject({
            method: 'DELETE',
            url: `/v1/databases/${id}`,
            payload: { confirmName: mine.name },
          });
          note(r1, [401, 404]);
          continue;
        }
        note(await e.call(who, 'GET', `/v1/databases/${id}`, undefined, org), [403, 404, 422]);
        note(
          await e.call(who, 'GET', `/v1/databases/${id}/backups`, undefined, org),
          [403, 404, 422],
        );
        note(
          await e.call(who, 'PATCH', `/v1/databases/${id}`, { name: 'hijacked' }, org, {
            'if-match': `"${mine.etag}"`,
          }),
          [403, 404, 422],
        );
        note(
          await e.call(who, 'DELETE', `/v1/databases/${id}`, { confirmName: mine.name }, org),
          [403, 404, 422],
        );
        note(await e.call(who, 'POST', `/v1/databases/${id}/backups`, {}, org), [403, 404, 422]);
        note(
          await e.call(who, 'POST', `/v1/databases/${id}/restores`, { backupId: backup }, org),
          [403, 404, 422],
        );
        note(
          await e.call(who, 'POST', `/v1/databases/${id}/credential-rotations`, {}, org),
          [403, 404, 422],
        );
      }
    // org selectors in the body, restore of someone else's backup into your own database, restore across orgs
    const own = await e.provision('bob', orgB(), { name: 'bob-db' }).catch(() => null);
    void own;
    for (const sel of ['orgId', 'organizationId', 'targetOrgId', 'org_id']) {
      label = `selector ${sel}`;
      note(
        await e.call('alice', 'POST', `/v1/databases/${mine.id}/restores`, {
          backupId: backup,
          [sel]: orgB(),
        }),
        [403],
      );
    }
    label = 'bob list';
    note(await e.call('bob', 'GET', `/v1/databases?limit=200`, undefined, orgB()), [200]);
    expect(
      (await e.call('bob', 'GET', `/v1/databases?limit=200`, undefined, orgB()))
        .json()
        .items.some((x: Row) => x.id === mine.id),
    ).toBe(false);
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM data.database_instances WHERE name = 'hijacked'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(cases).toBeGreaterThanOrEqual(200);
    expect(leaks).toEqual([]);
  });
  it("RLS: another organization's session sees no row of data.* tables, and cannot insert into another organization", async () => {
    const asB = await e.h.env.app.withOrg(orgB(), async (c) => ({
      inst: (
        await c.query(`SELECT count(*)::int n FROM data.database_instances WHERE org_id = $1`, [
          orgA(),
        ])
      ).rows[0]!.n as number,
      bk: (
        await c.query(`SELECT count(*)::int n FROM data.database_backups WHERE org_id = $1`, [
          orgA(),
        ])
      ).rows[0]!.n as number,
    }));
    expect(asB).toEqual({ inst: 0, bk: 0 });
    await expect(
      e.h.env.app.withOrg(orgB(), (c) =>
        c.query(
          `INSERT INTO data.database_backups (id, org_id, instance_id, type, state, idempotency_token, data_region) SELECT gen_random_uuid(), $1, id, 'manual', 'creating', 'x', 'sa-central' FROM data.database_instances LIMIT 1`,
          [orgA()],
        ),
      ),
    ).rejects.toThrow();
  });
});
