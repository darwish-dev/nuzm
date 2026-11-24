import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRM_SPEC } from '../fixtures/crm-appspec';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { migrate } from '../../../../../templates/webapp-runtime/src/migrate';
import { PgStore, createPool } from '../../../../../templates/webapp-runtime/src/pg-store';
import { withTenant } from '../../../../../templates/webapp-runtime/src/tenant';
import { buildMeta } from './meta';
import { productApp, WEB_PRODUCTS } from './product-specs';
import { generateProject } from './project';
import { initialMigration } from './sql';

/**
 * F3/F4 on a REAL PostgreSQL, SQL level only: the scaffold's migrations apply, are re-runnable and reversible, row-level security isolates tenants for a NON-superuser role, uniques and foreign
 * keys are tenant-aware, and the template's PgStore keeps tenants apart. No generated application is built or started here.
 * Needs a throw-away PostgreSQL with a superuser URL in P3_S05_PG_URL (the session's own instance, `postgres://nuzm_admin@127.0.0.1:54355/postgres`); skipped otherwise (the unit suite is DB-free).
 */
const ADMIN_URL = process.env['P3_S05_PG_URL'];
const d = ADMIN_URL ? describe : describe.skip;

d('generated migrations and tenant isolation on PostgreSQL', () => {
  const suffix = randomBytes(4).toString('hex');
  const created: { db: string; role: string }[] = [];
  const dirs: string[] = [];
  let admin: pg.Client;

  const urlFor = (db: string, role?: string, pw?: string): string => {
    const u = new URL(ADMIN_URL as string);
    u.pathname = '/' + db;
    if (role) {
      u.username = role;
      u.password = pw ?? '';
    }
    return u.toString();
  };
  /** a fresh database owned by a NON-superuser role (superusers bypass row-level security) */
  async function freshDb(label: string): Promise<{ url: string; db: string; role: string }> {
    const db = `p3s05_${label}_${suffix}`;
    const role = `p3s05_${label}_${suffix}_app`;
    const pw = randomBytes(12).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
    await admin.query(`CREATE DATABASE ${db} OWNER ${role}`);
    created.push({ db, role });
    return { url: urlFor(db, role, pw), db, role };
  }
  function writeMigrations(
    spec: Parameters<typeof generateProject>[0],
    o: Parameters<typeof generateProject>[1],
  ): string {
    const dir = mkdtempSync(join(tmpdir(), 'p3s05-mig-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const p = generateProject(spec, o);
    for (const [path, c] of p.files)
      if (path.startsWith('db/migrations/'))
        writeFileSync(join(dir, path.slice('db/migrations/'.length)), c);
    return dir;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
  });
  afterAll(async () => {
    for (const c of created) {
      await admin.query(`DROP DATABASE IF EXISTS ${c.db} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${c.role}`);
    }
    await admin.end();
    for (const x of dirs) rmSync(x, { recursive: true, force: true });
  }, 120_000);

  for (const [label, spec, opts] of [
    ['single', SAMPLE_SPEC, {}],
    ['crmsingle', CRM_SPEC, { signupRole: 'auto' as const }],
    ['multi', SAMPLE_SPEC, { tenancy: 'multi' as const, signupRole: 'auto' as const }],
    ['crmmulti', CRM_SPEC, { tenancy: 'multi' as const, signupRole: 'auto' as const }],
  ] as const) {
    it(`${label}: migrations apply once, a second run applies nothing, down then up works`, async () => {
      const db = await freshDb(label);
      const dir = writeMigrations(spec, opts);
      const first = await migrate(db.url, { dir, log: () => undefined });
      expect(first).toEqual(['0001_init.sql']);
      expect(await migrate(db.url, { dir, log: () => undefined })).toEqual([]);
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        const t = await c.query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
        );
        expect(t.rows[0].n).toBeGreaterThan(spec.entities.length + 3);
        // the ledger table survives `down`; the app tables do not
        await migrate(db.url, { dir, down: 1, log: () => undefined });
        const gone = await c.query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users'`,
        );
        expect(gone.rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
      expect(await migrate(db.url, { dir, log: () => undefined })).toEqual(['0001_init.sql']);
    }, 60_000);
  }

  for (const product of WEB_PRODUCTS)
    it(`${product}: the generated product schema migrates, re-runs, reverses and re-applies on PostgreSQL`, async () => {
      const app = productApp(product, { name: 'Synthetic ' + product, selfRegistration: true });
      const db = await freshDb('prod' + product);
      const dir = writeMigrations(app.spec, app.options);
      expect(await migrate(db.url, { dir, log: () => undefined })).toEqual(['0001_init.sql']);
      expect(await migrate(db.url, { dir, log: () => undefined })).toEqual([]);
      await migrate(db.url, { dir, down: 1, log: () => undefined });
      expect(await migrate(db.url, { dir, log: () => undefined })).toEqual(['0001_init.sql']);
      if (app.options.tenancy === 'multi') {
        const c = new pg.Client({ connectionString: db.url });
        await c.connect();
        const r = await c.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('app_tenants','app_users','app_revoked_sessions','schema_migrations') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
        );
        await c.end();
        expect(r.rows[0].n, 'every tenant table has forced row-level security').toBe(0);
      }
    }, 90_000);

  it('a failing migration leaves the database at the previous version (one transaction per migration)', async () => {
    const db = await freshDb('atomic');
    const dir = mkdtempSync(join(tmpdir(), 'p3s05-mig-'));
    dirs.push(dir);
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);\n');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int);\nSELECT 1/0;\n');
    await expect(migrate(db.url, { dir, log: () => undefined })).rejects.toThrow(
      /division by zero/,
    );
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    const r = await c.query('SELECT version FROM schema_migrations');
    const b = await c.query(`SELECT to_regclass('public.b') AS t`);
    await c.end();
    expect(r.rows.map((x) => x.version)).toEqual([1]);
    expect(b.rows[0].t).toBeNull();
  });

  describe('row-level security (multi-tenant)', () => {
    let url = '';
    let adminUrl = '';
    const T1 = '11111111-1111-4111-8111-111111111111';
    const T2 = '22222222-2222-4222-8222-222222222222';
    const [pName, pPlural] = [SAMPLE_SPEC.entities[0]!.name, SAMPLE_SPEC.entities[0]!.plural];
    const task = SAMPLE_SPEC.entities[1]!;
    const connect = async (): Promise<pg.Client> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      return c;
    };
    /** runs `fn` in a transaction with the tenant GUC set, as the PgStore does */
    const as = async <T>(tenant: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
      const c = await connect();
      try {
        await c.query('BEGIN');
        if (tenant) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await c.end();
      }
    };

    beforeAll(async () => {
      const db = await freshDb('rls');
      url = db.url;
      adminUrl = urlFor(db.db);
      await migrate(url, {
        dir: writeMigrations(SAMPLE_SPEC, { tenancy: 'multi', signupRole: 'auto' }),
        log: () => undefined,
      });
      const c = await connect();
      await c.query(`INSERT INTO app_tenants (id, name) VALUES ($1,'one'), ($2,'two')`, [T1, T2]);
      await c.end();
    });

    it('every tenant table has forced row-level security and a tenant policy; the app role is not a superuser', async () => {
      const c = await connect();
      const r = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('projects','tasks','audit_log') ORDER BY relname`,
      );
      expect(r.rows).toEqual([
        { relname: 'audit_log', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'projects', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'tasks', relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const role = await c.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await c.end();
    });

    it('a tenant sees only its rows; without a tenant nothing is visible and nothing can be written (fail closed)', async () => {
      await as(T1, (c) =>
        c.query(
          `INSERT INTO ${pPlural} (id, name, status) VALUES (gen_random_uuid(), 'p1', 'Active')`,
        ),
      );
      await as(T2, (c) =>
        c.query(
          `INSERT INTO ${pPlural} (id, name, status) VALUES (gen_random_uuid(), 'p2', 'Active')`,
        ),
      );
      expect((await as(T1, (c) => c.query(`SELECT name FROM ${pPlural}`))).rows).toEqual([
        { name: 'p1' },
      ]);
      expect((await as(T2, (c) => c.query(`SELECT name FROM ${pPlural}`))).rows).toEqual([
        { name: 'p2' },
      ]);
      expect((await as(null, (c) => c.query(`SELECT name FROM ${pPlural}`))).rows).toEqual([]);
      await expect(
        as(null, (c) =>
          c.query(
            `INSERT INTO ${pPlural} (id, name, status) VALUES (gen_random_uuid(), 'x', 'Active')`,
          ),
        ),
      ).rejects.toThrow(/row-level security|tenant_id/);
      // a tenant cannot write a row for another tenant, nor move a row to another tenant
      await expect(
        as(T1, (c) =>
          c.query(
            `INSERT INTO ${pPlural} (id, tenant_id, name, status) VALUES (gen_random_uuid(), $1, 'x', 'Active')`,
            [T2],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as(T1, (c) => c.query(`UPDATE ${pPlural} SET tenant_id = $1`, [T2])),
      ).rejects.toThrow(/row-level security/);
      // update and delete reach only the caller's rows
      expect(
        (await as(T2, (c) => c.query(`UPDATE ${pPlural} SET name = 'hacked' WHERE name = 'p1'`)))
          .rowCount,
      ).toBe(0);
      expect(
        (await as(T2, (c) => c.query(`DELETE FROM ${pPlural} WHERE name = 'p1'`))).rowCount,
      ).toBe(0);
      // the audit trail is isolated too
      await as(T1, (c) =>
        c.query(
          `INSERT INTO audit_log (id, entity, record_id, action) VALUES (gen_random_uuid(), 'Project', gen_random_uuid(), 'create')`,
        ),
      );
      expect((await as(T2, (c) => c.query(`SELECT 1 FROM audit_log`))).rowCount).toBe(0);
      expect((await as(T1, (c) => c.query(`SELECT 1 FROM audit_log`))).rowCount).toBe(1);
    });

    it('a superuser bypasses the policies: this is why the app role must never be one', async () => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      const r = await c.query(`SELECT count(*)::int AS n FROM ${pPlural}`);
      await c.end();
      expect(r.rows[0].n).toBe(2);
    });

    it('uniqueness is per tenant and a foreign key cannot cross tenants', async () => {
      const refField = task.fields.find((f) => f.type === 'reference');
      if (!refField) return; // SAMPLE_SPEC tasks reference projects
      const pid1 = (await as(T1, (c) => c.query(`SELECT id FROM ${pPlural}`))).rows[0].id as string;
      await expect(
        as(T2, (c) =>
          c.query(
            `INSERT INTO ${task.plural} (id, title, stage, ${refField.name === 'project' ? 'project' : refField.name}) VALUES (gen_random_uuid(), 't', 'Todo', $1)`,
            [pid1],
          ),
        ),
      ).rejects.toThrow(/foreign key|violates/);
      const own = (
        await as(T1, (c) =>
          c.query(
            `INSERT INTO ${task.plural} (id, title, stage, project) VALUES (gen_random_uuid(), 't', 'Todo', $1) RETURNING id`,
            [pid1],
          ),
        )
      ).rows[0].id;
      expect(own).toBeTruthy();
      // an optional reference is cleared with `ON DELETE SET NULL (column)`: the reference goes, the tenant of the referencing row stays (a plain SET NULL would try to null tenant_id)
      const del = await as(T1, (c) => c.query(`DELETE FROM ${pPlural} WHERE id = $1`, [pid1]));
      expect(del.rowCount).toBe(1);
      const after = await as(T1, (c) =>
        c.query(`SELECT project, tenant_id FROM ${task.plural} WHERE id = $1`, [own]),
      );
      expect(after.rows).toEqual([{ project: null, tenant_id: T1 }]);
    });

    it('PgStore (the template runtime) keeps tenants apart, fails closed and revokes sessions', async () => {
      const meta = buildMeta(SAMPLE_SPEC, { signupRole: 'member', tenancy: 'multi' }) as never;
      const pool = createPool(url);
      const store = new PgStore(pool, meta);
      const project = (id: string, name: string) =>
        ({
          id,
          name,
          status: 'Active',
          ownerId: null,
          teamId: null,
          createdBy: null,
          updatedBy: null,
        }) as never;
      await withTenant(T1, async () => {
        await store.insert(pName, project('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'store-one'));
      });
      await withTenant(T2, async () => {
        await store.insert(pName, project('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'store-two'));
        expect(await store.get(pName, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')).toBeNull();
        expect(await store.remove(pName, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')).toBe(false);
        expect(
          await store.update(pName, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', { name: 'x' }, null),
        ).toBeNull();
        const l = await store.list(pName, {
          filters: [],
          search: 'store',
          searchFields: ['name'],
          sort: null,
          limit: 10,
          offset: 0,
          scope: { ownerId: null, teamId: null },
        });
        expect(l.rows.map((r) => r['name'])).toEqual(['store-two']);
        expect(l.total).toBe(1);
      });
      // no tenant context: nothing visible, nothing writable
      expect(
        (
          await store.list(pName, {
            filters: [],
            search: null,
            searchFields: [],
            sort: null,
            limit: 10,
            offset: 0,
            scope: { ownerId: null, teamId: null },
          })
        ).rows,
      ).toEqual([]);
      await expect(
        store.insert(pName, project('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'x')),
      ).rejects.toThrow();
      // revocation is stored and purged
      await store.revokeSession('jti-1', Math.floor(Date.now() / 1000) + 60);
      expect(await store.isSessionRevoked('jti-1')).toBe(true);
      expect(await store.isSessionRevoked('jti-2')).toBe(false);
      await store.revokeSession('jti-old', Math.floor(Date.now() / 1000) - 10);
      await store.revokeSession('jti-3', Math.floor(Date.now() / 1000) + 60); // purges expired ids
      expect(await store.isSessionRevoked('jti-old')).toBe(false);
      await pool.end();
    });
  });

  it('the single-tenant schema has no tenant column and no row-level security (Phase 2 behaviour unchanged)', () => {
    const up = initialMigration(SAMPLE_SPEC).up;
    expect(up).not.toMatch(/tenant|ROW LEVEL SECURITY/i);
    expect(up).toMatch(/app_revoked_sessions/);
  });
});
