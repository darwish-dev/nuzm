import {
  MockCacheAdapter,
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  ManualClock,
} from '@nuzm/adapter-data';
import { Harness, cookieHeader, type App } from '../../identity/testing/app-harness';
import { DataAdapterRegistry } from '../index';
import { DataJobs } from '../internal/jobs';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests

/** Environment of the data integration tests: dev-reference adapters on, no background kicks (the tests drive every operation), no waits. */
export function applyDataTestEnv() {
  process.env.DATA_LOCAL_REFERENCE = 'true';
  process.env.DATA_KICK = 'off';
  process.env.DATA_TRANSIENT_RETRY_DELAY_MS = '0';
  process.env.DATA_PROVISION_POLL_DELAY_MS = '0';
  process.env.DATA_PROVISION_POLL_ATTEMPTS = '3';
  process.env.DSR_KICK = 'off';
}

/** A published, non-placeholder SAR price book with the M08 meters (test fixture: HG-02-01 still owns the real price list). */
export async function seedDataPrices(h: Harness) {
  const items: [string, 'flat', string][] = [
    ['database.instance_hours', 'flat', '1.00000000'],
    ['cache.instance_hours', 'flat', '0.50000000'],
    ['database.storage_gb_months', 'flat', '10.00000000'],
    ['database.backup_gb_months', 'flat', '5.00000000'],
    ['storage.object_gb_months', 'flat', '8.00000000'],
    ['email.transactional_messages', 'flat', '0.10000000'],
    ['email.mailbox_months', 'flat', '500.00000000'],
    ['email.mailbox_storage_gb_months', 'flat', '1.00000000'],
  ];
  await h.env.sql(
    `INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES ('00000000-0000-7000-8000-0000000000b1','m08-test','SAR',false)`,
  );
  await h.env.sql(
    `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from) VALUES ('00000000-0000-7000-8000-0000000000b2','00000000-0000-7000-8000-0000000000b1',1,'draft','2026-01-01T00:00:00Z')`,
  );
  for (const [meter, model, price] of items)
    await h.env.sql(
      `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor) VALUES (gen_random_uuid(),'00000000-0000-7000-8000-0000000000b2',$1,$2,$3)`,
      [meter, model, price],
    );
  await h.env.sql(
    `UPDATE billing.price_book_versions SET status='published', published_by='00000000-0000-0000-0000-000000000000', published_at=now() WHERE id='00000000-0000-7000-8000-0000000000b2'`,
  );
}

/** A database adapter whose catalog lists a European region (for the residency-denial tests). */
export class EuDatabaseAdapter extends MockDatabaseAdapter {
  override async catalog(ctx: Parameters<MockDatabaseAdapter['catalog']>[0]) {
    const c = await super.catalog(ctx);
    return {
      ...c,
      regions: [{ ...c.regions[0]!, providerRegionId: 'de-frankfurt', countryCode: 'DE' }],
      plans: c.plans.map((p) => ({ ...p, providerRegionId: 'de-frankfurt' })),
    };
  }
}

/** An object-storage adapter whose catalog lists a European region (for the residency-denial tests). */
export class EuObjectStorageAdapter extends MockObjectStorageAdapter {
  override async catalog(ctx: Parameters<MockObjectStorageAdapter['catalog']>[0]) {
    const c = await super.catalog(ctx);
    return {
      ...c,
      regions: [{ ...c.regions[0]!, providerRegionId: 'de-frankfurt', countryCode: 'DE' }],
      plans: c.plans.map((p) => ({ ...p, providerRegionId: 'de-frankfurt' })),
    };
  }
}

export interface Session {
  h: Harness;
  app: App;
  jars: Record<string, Record<string, string>>;
  ids: Record<string, string>;
  org: Record<string, string>;
  call(
    who: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
    org?: string,
    extra?: Record<string, string>,
  ): ReturnType<App['inject']>;
  admin(who: string, method: 'GET' | 'POST', url: string, body?: object): ReturnType<App['inject']>;
}

export function makeSession(h: Harness, app: App): Session {
  const s: Session = {
    h,
    app,
    jars: {},
    ids: {},
    org: {},
    call: (who, method, url, body, org, extra = {}) =>
      app.inject({
        method,
        url,
        headers: {
          cookie: cookieHeader(s.jars[who]!),
          'x-csrf-token': s.jars[who]!.nuzm_csrf ?? '',
          'x-nuzm-org': org ?? s.org.A!,
          'idempotency-key': `k-${Math.random()}`,
          ...extra,
        },
        ...(body ? { payload: body } : {}),
      }),
    admin: (who, method, url, body) =>
      app.inject({
        method,
        url,
        headers: {
          cookie: cookieHeader(s.jars[who]!),
          'x-csrf-token': s.jars[who]!.nuzm_admin_csrf ?? '',
          'idempotency-key': `k-${Math.random()}`,
        },
        ...(body ? { payload: body } : {}),
      }),
  };
  return s;
}

export const registry = (app: App) => app.get(DataAdapterRegistry);
export { MockCacheAdapter, MockDatabaseAdapter, ManualClock };

export interface DataEnv extends Session {
  sink: { events: { action: string; [k: string]: any }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  padmin: string;
  padmin2: string;
  /** Configure, probe, request-enable and enable a LOCAL dev-reference provider through the admin API (the same path an operator uses). */
  enableLocal(service: string, code: string, config: Record<string, unknown>): Promise<Row>;
  /** Quote + create + run the create operation; returns the database. */
  provision(who: string, org: string, body?: Partial<Row>): Promise<Row>;
}

export async function setupDataEnv(): Promise<DataEnv> {
  applyDataTestEnv();
  const h = new Harness();
  await h.init();
  const { app, sink } = await h.buildApp({}, undefined, [], {});
  const s = makeSession(h, app);
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    s.ids[n] = await h.createUser(n);
    s.jars[n] = await h.sessionFor(app, s.ids[n]!);
  }
  for (const n of ['alice', 'bob', 'carol', 'dave']) await h.elevate(s.jars[n]!);
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(s.jars[who]!), 'x-csrf-token': s.jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  s.org.A = await mk('alice', 'Data A');
  s.org.B = await mk('bob', 'Data B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'developer'],
    ['erin', 'admin'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [s.org.A, s.ids[u], role],
    );
  const p1 = await h.platformUser(app, 'padmin', ['platform_admin']);
  const p2 = await h.platformUser(app, 'padmin2', ['platform_admin']);
  s.jars.padmin = p1.jar;
  s.jars.padmin2 = p2.jar;
  await seedDataPrices(h);
  const env: DataEnv = {
    ...s,
    sink: sink as DataEnv['sink'],
    padmin: p1.id,
    padmin2: p2.id,
    async enableLocal(service, code, config) {
      const family = `self-operated-${code.replace(/^mock-/, '')}`;
      const c = await s.admin('padmin', 'POST', '/v1/admin/data-providers', {
        action: 'configure',
        service,
        family,
        providerCode: code,
        environment: 'local',
        config: { credentialRef: 'vault://mock/acct', ...config },
      });
      if (c.statusCode !== 200) throw new Error(`configure ${code}: ${c.statusCode} ${c.body}`);
      const id = c.json().id as string;
      for (const body of [
        { action: 'probe', id },
        {
          action: 'request_enable',
          id,
          evidenceRef: 'LOCAL-REFERENCE-NOT-VERIFIED',
          verifiedAt: new Date().toISOString(),
        },
        { action: 'enable', id },
      ]) {
        const r = await s.admin('padmin', 'POST', '/v1/admin/data-providers', body);
        if (r.statusCode !== 200)
          throw new Error(`${body.action} ${code}: ${r.statusCode} ${r.body}`);
      }
      return (await s.admin('padmin', 'GET', `/v1/admin/data-providers?service=${service}`))
        .json()
        .items.find((x: Row) => x.id === id);
    },
    async provision(who, org, body = {}) {
      const eng = (body.engine as string) ?? 'postgresql';
      const version =
        (body.version as string) ?? (eng === 'mysql' ? '8.4' : eng === 'redis' ? '7' : '16');
      const planRef = eng === 'redis' ? 'mock-cache-s' : 'mock-db-s';
      const q = await s.call(
        who,
        'POST',
        '/v1/quotes',
        { kind: 'database', items: [{ engine: eng, version, planRef, storageGb: 20 }] },
        org,
      );
      if (q.statusCode !== 201) throw new Error(`quote: ${q.statusCode} ${q.body}`);
      const r = await s.call(
        who,
        'POST',
        '/v1/databases',
        {
          quoteId: q.json().id,
          engine: eng,
          version,
          name: `db-${Math.random().toString(36).slice(2, 8)}`,
          ...body,
        },
        org,
      );
      if (r.statusCode !== 202) throw new Error(`create: ${r.statusCode} ${r.body}`);
      const d = r.json();
      await app.get(DataJobs).runOne(org, d.operationId);
      return (await s.call(who, 'GET', `/v1/databases/${d.id}`, undefined, org)).json();
    },
  };
  return env;
}
