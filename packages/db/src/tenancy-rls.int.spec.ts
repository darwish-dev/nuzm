import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase } from './checks';
import { loadManifest } from './migrations';
import { migrate } from './runner';

const admin = process.env.NUZM_TEST_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/postgres';
const manifest = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '../migrations');
const dbName = `nuzm_test_ten_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);

const U1 = '00000000-0000-7000-8000-0000000000a1';
const U2 = '00000000-0000-7000-8000-0000000000a2';
const OA = '00000000-0000-7000-8000-00000000000a';
const OB = '00000000-0000-7000-8000-00000000000b';
const WA = '00000000-0000-7000-8000-0000000000c1';
const WB = '00000000-0000-7000-8000-0000000000c2';

async function root<T = Record<string, unknown>>(q: string, p: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}
async function as<T>(role: string, gucs: Record<string, string>, fn: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    for (const [k, v] of Object.entries(gucs))
      await c.query('SELECT set_config($1,$2,true)', [k, v]);
    const r = await fn(c);
    await c.query('ROLLBACK');
    return r;
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
  for (const [id, s] of [
    [U1, 'u1'],
    [U2, 's2'],
  ] as const) {
    await root(`INSERT INTO identity.users (id, issuer, subject, email) VALUES ($1,'i',$2,$3)`, [
      id,
      s,
      `${s}@example.test`,
    ]);
  }
  for (const [id, slug] of [
    [OA, 'org-a'],
    [OB, 'org-b'],
  ] as const) {
    await root(
      `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
      [id, slug, U1],
    );
  }
  await root(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES
    ('00000000-0000-7000-8000-0000000000d1',$1,$3,'owner'), ('00000000-0000-7000-8000-0000000000d2',$2,$4,'owner')`,
    [OA, OB, U1, U2],
  );
  await root(
    `INSERT INTO tenancy.workspaces (id, org_id, name, slug, created_by) VALUES ($1,$3,'w','w',$5), ($2,$4,'w','w',$6)`,
    [WA, WB, OA, OB, U1, U2],
  );
});
afterAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

describe('tenancy schema', () => {
  it('passes ownership + RLS rules (organizations is RLS-keyed on id; reference tables are tenant-less)', async () => {
    expect(await checkDatabase(url, manifest)).toEqual([]);
  });

  it('a user sees only their own organizations and memberships, without choosing an org first', async () => {
    const orgs = await as('nuzm_app', { 'app.user_id': U1 }, async (c) =>
      (await c.query('SELECT id FROM tenancy.organizations')).rows.map((r) => r.id),
    );
    expect(orgs).toEqual([OA]);
    const mem = await as('nuzm_app', { 'app.user_id': U2 }, async (c) =>
      (await c.query('SELECT org_id FROM tenancy.memberships')).rows.map((r) => r.org_id),
    );
    expect(mem).toEqual([OB]);
    expect(
      await as(
        'nuzm_app',
        {},
        async (c) => (await c.query('SELECT 1 FROM tenancy.organizations')).rowCount,
      ),
    ).toBe(0);
  });

  it('org context isolates every tenant table; cross-org reads/writes are impossible', async () => {
    for (const t of ['memberships', 'workspaces', 'invitations', 'projects', 'environments']) {
      const n = await as(
        'nuzm_app',
        { 'app.org_id': OA },
        async (c) =>
          (await c.query(`SELECT count(*)::int n FROM tenancy.${t} WHERE org_id <> $1`, [OA]))
            .rows[0].n,
      );
      expect(n, t).toBe(0);
    }
    await expect(
      as('nuzm_app', { 'app.org_id': OA }, (c) =>
        c.query(
          `INSERT INTO tenancy.workspaces (id, org_id, name, slug, created_by) VALUES (gen_random_uuid(), $1, 'x', 'x', $2)`,
          [OB, U1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('organization creation is only possible by establishing that org as context (WITH CHECK)', async () => {
    await expect(
      as('nuzm_app', { 'app.org_id': OA }, (c) =>
        c.query(
          `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES (gen_random_uuid(),'n','n-org','customer','SA',$1)`,
          [U1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a project can never be linked to another org's workspace, even bypassing RLS (composite FK)", async () => {
    await expect(
      root(
        `INSERT INTO tenancy.projects (id, org_id, workspace_id, name, created_by) VALUES (gen_random_uuid(), $1, $2, 'p', $3)`,
        [OA, WB, U1],
      ),
    ).rejects.toThrow(/foreign key/);
    await root(
      `INSERT INTO tenancy.projects (id, org_id, workspace_id, name, created_by) VALUES ('00000000-0000-7000-8000-0000000000e1', $1, $2, 'p', $3)`,
      [OA, WA, U1],
    );
    await expect(
      root(
        `INSERT INTO tenancy.environments (id, org_id, project_id, name, kind) VALUES (gen_random_uuid(), $1, '00000000-0000-7000-8000-0000000000e1', 'e', 'dev')`,
        [OB],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('duplicate slugs and duplicate open invitations are rejected; one membership per user per org', async () => {
    await expect(
      root(
        `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES (gen_random_uuid(),'x','org-a','customer','SA',$1)`,
        [U1],
      ),
    ).rejects.toThrow(/duplicate key/);
    await root(
      `INSERT INTO tenancy.invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (gen_random_uuid(), $1, 'Dup@Example.test', 'viewer', 'h1', $2, now() + interval '7 days')`,
      [OA, U1],
    );
    await expect(
      root(
        `INSERT INTO tenancy.invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (gen_random_uuid(), $1, 'dup@example.test', 'viewer', 'h2', $2, now() + interval '7 days')`,
        [OA, U1],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      root(
        `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
        [OA, U1],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('invitations are readable by token only inside the invitation_accept scope', async () => {
    expect(
      await as(
        'nuzm_app',
        {},
        async (c) => (await c.query('SELECT 1 FROM tenancy.invitations')).rowCount,
      ),
    ).toBe(0);
    const n = await as(
      'nuzm_app',
      { 'app.auth_scope': 'invitation_accept' },
      async (c) =>
        (await c.query(`SELECT 1 FROM tenancy.invitations WHERE token_hash='h1'`)).rowCount,
    );
    expect(n).toBe(1);
  });

  it('runtime roles cannot modify RBAC reference data; the worker cannot write tenancy', async () => {
    await expect(
      as('nuzm_app', {}, (c) =>
        c.query(`UPDATE tenancy.role_permissions SET permission = permission`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as('nuzm_app', {}, (c) =>
        c.query(`INSERT INTO tenancy.roles (name, scope, description) VALUES ('evil','org','x')`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as('nuzm_worker', { 'app.org_id': OA }, (c) => c.query(`DELETE FROM tenancy.memberships`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('RBAC seed data invariants', () => {
  const perms = async (role: string) =>
    (
      await root<{ permission: string }>(
        `SELECT permission FROM tenancy.role_permissions WHERE role=$1`,
        [role],
      )
    ).map((r) => r.permission);

  it('org roles hold only org permissions; platform roles only platform permissions', async () => {
    const bad = await root(`SELECT rp.role, rp.permission FROM tenancy.role_permissions rp
      JOIN tenancy.roles r ON r.name = rp.role JOIN tenancy.permissions p ON p.name = rp.permission WHERE r.scope <> p.scope`);
    expect(bad).toEqual([]);
  });
  it('owner has every org permission; admin lacks only org:delete', async () => {
    const all = (
      await root<{ name: string }>(`SELECT name FROM tenancy.permissions WHERE scope='org'`)
    ).map((r) => r.name);
    expect((await perms('owner')).sort()).toEqual(all.sort());
    const admin = await perms('admin');
    expect(all.filter((p) => !admin.includes(p))).toEqual(['org:delete']);
  });
  it('viewer is read-only; billing_admin cannot mutate resources; developer cannot manage members or billing', async () => {
    const mutating = /:(create|update|delete|manage|invite|cancel|security)$/;
    expect((await perms('viewer')).filter((p) => mutating.test(p))).toEqual([]);
    expect(
      (await perms('billing_admin')).filter(
        (p) => /^(workspace|project|apikey|operation):/.test(p) && mutating.test(p),
      ),
    ).toEqual([]);
    const dev = await perms('developer');
    expect(
      dev.filter((p) =>
        /^(member:(manage|invite)|billing:manage|org:(update|delete|security))/.test(p),
      ),
    ).toEqual([]);
  });
  it('separation of duties: support cannot grant roles or touch billing; finance cannot impersonate', async () => {
    const support = await perms('support');
    expect(support).toContain('admin:impersonate');
    expect(support.filter((p) => /billing|flags|member/.test(p))).toEqual([]);
    expect(await perms('finance')).not.toContain('admin:impersonate');
    expect(await perms('platform_admin')).not.toContain('admin:impersonate');
  });
});
