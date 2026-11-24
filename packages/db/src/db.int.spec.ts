import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase } from './checks';
import { discoverMigrations, loadManifest, type Manifest } from './migrations';
import { migrate, rollback } from './runner';

const admin =
  process.env.NUZM_TEST_ADMIN_URL ??
  (() => {
    throw new Error(
      'NUZM_TEST_ADMIN_URL is mandatory: acquire an isolated test environment first (node scripts/testenv/testenv.mjs acquire); there is no default database',
    );
  })();
const manifest = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '../migrations');
const allOrdinals = discoverMigrations(migrationsDir, manifest).map((m) => m.ordinal);
const dbName = `nuzm_test_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);

async function sql<T = unknown>(q: string, params: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, params)).rows as T[];
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
});

afterAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

describe('migration runner (real PostgreSQL)', () => {
  it('applies from empty, creates roles NOLOGIN and the platform schema', async () => {
    const done = await migrate({ url, migrationsDir, manifest });
    expect(done.map((m) => m.ordinal)).toEqual(allOrdinals);
    // Roles are cluster-wide and dev tooling may enable LOGIN on this cluster, so assert what the
    // migration controls: the roles exist and the migration never grants LOGIN or sets a password.
    const roles = await sql<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'nuzm\\_%' AND rolname <> 'nuzm_admin' ORDER BY 1`,
    );
    expect(roles.map((r) => r.rolname)).toEqual(
      expect.arrayContaining([
        'nuzm_admin_breakglass',
        'nuzm_app',
        'nuzm_readonly_reporting',
        'nuzm_worker',
      ]),
    );
    const sqlText = readFileSync(
      join(migrationsDir, 'platform/0001__platform__roles_and_schema.sql'),
      'utf8',
    )
      .split('\n')
      .filter((l) => !l.trim().startsWith('--')) // ignore comments
      .join('\n');
    expect(sqlText).toMatch(/CREATE ROLE %I NOLOGIN/);
    expect(sqlText).not.toMatch(/PASSWORD|\bLOGIN\b(?!.*NOLOGIN)/);
    expect(await sql(`SELECT 1 FROM pg_namespace WHERE nspname = 'platform'`)).toHaveLength(1);
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrate({ url, migrationsDir, manifest })).toHaveLength(0);
  });

  it('serialises concurrent migrators (advisory lock): exactly one applies', async () => {
    const fresh = `${dbName}_c`;
    const c = new Client({ connectionString: admin });
    await c.connect();
    await c.query(`CREATE DATABASE "${fresh}"`);
    await c.end();
    const u = admin.replace(/\/[^/]*$/, `/${fresh}`);
    try {
      const results = await Promise.all(
        [1, 2, 3].map(() => migrate({ url: u, migrationsDir, manifest })),
      );
      expect(results.map((r) => r.length).sort()).toEqual([0, 0, allOrdinals.length]);
    } finally {
      const d = new Client({ connectionString: admin });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
      await d.end();
    }
  });

  it('detects a tampered applied migration (immutable checksums)', async () => {
    await sql(`UPDATE public.nuzm_migrations SET checksum = 'tampered' WHERE ordinal = 1`);
    await expect(migrate({ url, migrationsDir, manifest })).rejects.toThrow(/checksum mismatch/);
    const real = discoverMigrations(migrationsDir, manifest)[0]!.checksum;
    await sql(`UPDATE public.nuzm_migrations SET checksum = $1 WHERE ordinal = 1`, [real]);
  });

  it('rolls back using the documented .down.sql and re-applies', async () => {
    const reverted = await rollback({ url, migrationsDir, manifest }, allOrdinals.length);
    expect(reverted.map((m) => m.ordinal)).toEqual([...allOrdinals].reverse());
    expect(await sql(`SELECT 1 FROM pg_namespace WHERE nspname = 'platform'`)).toHaveLength(0);
    expect((await migrate({ url, migrationsDir, manifest })).map((m) => m.ordinal)).toEqual(
      allOrdinals,
    );
  });
});

describe('ownership + RLS checks (docs/05 rules)', () => {
  const m: Manifest = {
    ...manifest,
    schemas: {
      ...manifest.schemas,
      platform: {
        ...manifest.schemas.platform!,
        tables: [...manifest.schemas.platform!.tables, 'widgets', 'lookup'],
      },
    },
    tenant_less: manifest.tenant_less,
  };

  it('passes on a clean database', async () => {
    expect(await checkDatabase(url, manifest)).toEqual([]);
  });

  it('flags an org_id table without RLS, then without FORCE, then without a policy', async () => {
    await sql(`CREATE TABLE platform.widgets (id uuid primary key, org_id uuid not null)`);
    expect((await checkDatabase(url, m)).map((v) => v.kind)).toContain('rls_missing');
    await sql(`ALTER TABLE platform.widgets ENABLE ROW LEVEL SECURITY`);
    const noForce = (await checkDatabase(url, m)).map((v) => v.kind);
    expect(noForce).toContain('rls_not_forced');
    expect(noForce).toContain('policy_missing');
    await sql(`ALTER TABLE platform.widgets FORCE ROW LEVEL SECURITY`);
    await sql(
      `CREATE POLICY tenant ON platform.widgets USING (org_id = current_setting('app.org_id', true)::uuid)`,
    );
    expect(
      await checkDatabase(url, { ...m, tenant_less: [...m.tenant_less, 'platform.lookup'] }),
    ).toEqual([]);
  });

  it('flags tenant-less tables that are not explicitly listed', async () => {
    await sql(`CREATE TABLE platform.lookup (code text primary key)`);
    const kinds = (await checkDatabase(url, m)).map((v) => v.kind);
    expect(kinds).toContain('tenant_less_unlisted');
    expect(
      await checkDatabase(url, { ...m, tenant_less: [...m.tenant_less, 'platform.lookup'] }),
    ).toEqual([]);
  });

  it('rls_keyed tables (no org_id) must still carry forced RLS and a policy', async () => {
    await sql(`CREATE TABLE platform.keyed (id uuid primary key)`);
    const keyed = {
      ...m,
      tenant_less: [...m.tenant_less, 'platform.lookup'],
      schemas: {
        ...m.schemas,
        platform: { ...m.schemas.platform!, tables: [...m.schemas.platform!.tables, 'keyed'] },
      },
      rls_keyed: [...m.rls_keyed, 'platform.keyed'],
    };
    expect((await checkDatabase(url, keyed)).map((v) => v.kind)).toEqual(
      expect.arrayContaining(['rls_missing', 'policy_missing']),
    );
    await sql(
      `ALTER TABLE platform.keyed ENABLE ROW LEVEL SECURITY; ALTER TABLE platform.keyed FORCE ROW LEVEL SECURITY; CREATE POLICY k ON platform.keyed USING (id = nullif(current_setting('app.org_id', true), '')::uuid)`,
    );
    expect(await checkDatabase(url, keyed)).toEqual([]);
    await sql(`DROP TABLE platform.keyed`);
  });

  it('flags tables and schemas the manifest does not know', async () => {
    await sql(`CREATE TABLE platform.rogue (org_id uuid)`);
    await sql(`CREATE SCHEMA rogue_schema`);
    const v = await checkDatabase(url, {
      ...m,
      tenant_less: [...m.tenant_less, 'platform.lookup'],
    });
    expect(v.some((x) => x.kind === 'unknown_table' && x.object === 'platform.rogue')).toBe(true);
    expect(v.some((x) => x.kind === 'unknown_schema' && x.object === 'rogue_schema')).toBe(true);
  });

  it('enforces tenant isolation at the database for a role bound by RLS', async () => {
    await sql(`DROP TABLE platform.rogue; DROP SCHEMA rogue_schema;`);
    const a = '00000000-0000-7000-8000-00000000000a';
    const b = '00000000-0000-7000-8000-00000000000b';
    await sql(
      `INSERT INTO platform.widgets (id, org_id) VALUES ('${a}', '${a}'), ('${b}', '${b}')`,
    );
    await sql(`GRANT SELECT ON platform.widgets TO nuzm_app`);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE nuzm_app');
      await c.query(`SET LOCAL app.org_id = '${a}'`);
      const own = await c.query('SELECT org_id FROM platform.widgets');
      expect(own.rows.map((r) => r.org_id)).toEqual([a]); // org B's row is invisible
      await c.query(`SET LOCAL app.org_id = '${b}'`);
      expect(
        (await c.query('SELECT org_id FROM platform.widgets')).rows.map((r) => r.org_id),
      ).toEqual([b]);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
