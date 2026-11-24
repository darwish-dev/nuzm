import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase } from './checks';
import { loadManifest } from './migrations';
import { migrate } from './runner';

const admin =
  process.env.NUZM_TEST_ADMIN_URL ??
  (() => {
    throw new Error(
      'NUZM_TEST_ADMIN_URL is mandatory: acquire an isolated test environment first (node scripts/testenv/testenv.mjs acquire); there is no default database',
    );
  })();
const manifest = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '../migrations');
const dbName = `nuzm_test_plat_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);
const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const U = '00000000-0000-7000-8000-0000000000u1'.replace('u1', '01');

/** Run `fn` in a transaction as `role` with the given GUCs set LOCAL (the way the app does). */
async function as<T>(
  role: string,
  gucs: Record<string, string>,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    for (const [k, v] of Object.entries(gucs))
      await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    const r = await fn(c);
    await c.query('ROLLBACK');
    return r;
  } finally {
    await c.end();
  }
}
async function root(q: string, p: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  await migrate({ url, migrationsDir, manifest });
  await root(
    `INSERT INTO identity.users (id, issuer, subject, email) VALUES ($1,'iss','s1','a@example.test')`,
    [U],
  );
  for (const [i, org] of [A, B].entries()) {
    await root(
      `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$3,'customer','SA',$4)`,
      [org, `Org ${i}`, `org-${i}`, U],
    );
  }
  for (const [i, org] of [A, B].entries()) {
    await root(`INSERT INTO platform.operations (id, org_id, kind) VALUES ($1,$2,'test')`, [
      `00000000-0000-7000-8000-0000000001${i}0`,
      org,
    ]);
    await root(`INSERT INTO platform.outbox (id, org_id, topic, payload) VALUES ($1,$2,'t','{}')`, [
      `00000000-0000-7000-8000-0000000002${i}0`,
      org,
    ]);
    await root(
      `INSERT INTO identity.api_keys (id, org_id, created_by, name, prefix, secret_hash, scopes)
       VALUES ($1,$2,$3,'k',$4,'hash','{project:read}')`,
      [`00000000-0000-7000-8000-0000000003${i}0`, org, U, `nzk_${i}`],
    );
  }
  await root(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES
    ('00000000-0000-7000-8000-000000000401','global.flag',NULL,'true'),
    ('00000000-0000-7000-8000-000000000402','org.flag',$1,'true'),
    ('00000000-0000-7000-8000-000000000403','org.flag',$2,'false')`,
    [A, B],
  );
});

afterAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

describe('platform/identity schema', () => {
  it('passes the ownership + RLS rules', async () => {
    expect(await checkDatabase(url, manifest)).toEqual([]);
  });
});

describe.each(['nuzm_app', 'nuzm_worker'])('tenant isolation for %s', (role) => {
  it.each(['platform.operations', 'platform.outbox', 'platform.notifications'])(
    '%s: no org context → 0 rows',
    async (table) => {
      expect(
        await as(role, {}, async (c) => (await c.query(`SELECT * FROM ${table}`)).rowCount),
      ).toBe(0);
    },
  );
  it('operations: org A context sees only org A', async () => {
    const rows = await as(
      role,
      { 'app.org_id': A },
      async (c) => (await c.query('SELECT org_id FROM platform.operations')).rows,
    );
    expect(rows.map((r) => r.org_id)).toEqual([A]);
  });
  it('cannot insert a row for another org (WITH CHECK)', async () => {
    await expect(
      as(role, { 'app.org_id': A }, (c) =>
        c.query(
          `INSERT INTO platform.operations (id, org_id, kind) VALUES ('00000000-0000-7000-8000-000000000999', $1, 'x')`,
          [B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('cannot update another org row (0 rows affected)', async () => {
    const n = await as(
      role,
      { 'app.org_id': A },
      async (c) =>
        (await c.query(`UPDATE platform.operations SET kind='hacked' WHERE org_id=$1`, [B]))
          .rowCount,
    );
    expect(n).toBe(0);
  });
});

describe('worker claim scope', () => {
  it('worker with claim scope sees due operations and outbox across orgs', async () => {
    const ops = await as(
      'nuzm_worker',
      { 'app.worker_scope': 'claim' },
      async (c) => (await c.query('SELECT org_id FROM platform.operations')).rows,
    );
    expect(ops.map((r) => r.org_id).sort()).toEqual([A, B]);
    const ob = await as(
      'nuzm_worker',
      { 'app.worker_scope': 'claim' },
      async (c) => (await c.query('SELECT org_id FROM platform.outbox')).rowCount,
    );
    expect(ob).toBe(2);
  });
  it('the app role cannot use the claim scope', async () => {
    const n = await as(
      'nuzm_app',
      { 'app.worker_scope': 'claim' },
      async (c) => (await c.query('SELECT 1 FROM platform.operations')).rowCount,
    );
    expect(n).toBe(0);
  });
  it('the app role cannot read or update the outbox of other orgs; cannot update at all (grant)', async () => {
    await expect(
      as('nuzm_app', { 'app.org_id': A }, (c) =>
        c.query(`UPDATE platform.outbox SET published_at = now()`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('feature flags and api keys', () => {
  it('global flags are visible to all; org flags only to their org', async () => {
    const keys = await as(
      'nuzm_app',
      { 'app.org_id': A },
      async (c) =>
        (await c.query('SELECT key, org_id FROM platform.feature_flags ORDER BY key')).rows,
    );
    expect(keys.map((r) => `${r.key}:${r.org_id ?? 'global'}`)).toEqual([
      'global.flag:global',
      `org.flag:${A}`,
    ]);
  });
  it('runtime roles cannot write global flags; break-glass can', async () => {
    await expect(
      as('nuzm_app', { 'app.org_id': A }, (c) =>
        c.query(
          `INSERT INTO platform.feature_flags (id,key,org_id,value) VALUES ('00000000-0000-7000-8000-000000000998','g2',NULL,'1')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await as('nuzm_admin_breakglass', {}, (c) =>
      c.query(
        `INSERT INTO platform.feature_flags (id,key,org_id,value) VALUES ('00000000-0000-7000-8000-000000000998','g2',NULL,'1')`,
      ),
    );
  });
  it('api_keys: org context isolates; lookup scope reads by prefix only before the org is known', async () => {
    expect(
      await as('nuzm_app', { 'app.org_id': B }, async (c) =>
        (await c.query('SELECT org_id FROM identity.api_keys')).rows.map((r) => r.org_id),
      ),
    ).toEqual([B]);
    expect(
      await as(
        'nuzm_app',
        {},
        async (c) => (await c.query('SELECT 1 FROM identity.api_keys')).rowCount,
      ),
    ).toBe(0);
    const hit = await as(
      'nuzm_app',
      { 'app.auth_scope': 'api_key_lookup' },
      async (c) =>
        (await c.query(`SELECT org_id FROM identity.api_keys WHERE prefix = 'nzk_0'`)).rows,
    );
    expect(hit).toEqual([{ org_id: A }]);
  });
  it('idempotency key is unique per (org, key)', async () => {
    await expect(
      as('nuzm_app', { 'app.org_id': A }, async (c) => {
        await c.query(
          `INSERT INTO platform.idempotency_keys (org_id,key,request_hash) VALUES ($1,'k1','h')`,
          [A],
        );
        await c.query(
          `INSERT INTO platform.idempotency_keys (org_id,key,request_hash) VALUES ($1,'k1','h2')`,
          [A],
        );
      }),
    ).rejects.toThrow(/duplicate key/);
  });
});
