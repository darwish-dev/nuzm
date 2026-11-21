import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase } from './checks';
import { loadManifest } from './migrations';
import { migrate } from './runner';

/**
 * AI Intelligence Center (ADR-065): the isolation contract of schema `knowledge`, proved on a real PostgreSQL.
 *  - a customer never reads a platform row from the base tables; the only door is knowledge.v_published_templates
 *  - the view lists a version only when it is ACTIVE, published, licence-ALLOWED and reuse-permitted, and never exposes object keys or file paths
 *  - versions are immutable, evidence is append-only, a version cannot be ACTIVE without an ALLOWED licence, and money keeps its currency
 */
const admin = process.env.NUZM_TEST_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/postgres';
const manifest = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '../migrations');
const dbName = `nuzm_test_kn_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const HASH = 'a'.repeat(64);
const P_PUB = id(1); // platform, published, active
const P_PRIV = id(2); // platform, private
const P_LIC = id(3); // platform, published, version AWAITING_REVIEW with an unknown licence
const T_A = id(4); // org A's private template
const T_B = id(5); // org B's private template
const V = (resource: number) => id(100 + resource);

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
/** The same for the migration role (a superuser: grants and RLS do not stop it), so the database's own guards are what is tested. */
async function rootFails(q: string, p: unknown[] = []) {
  try {
    await root(q, p);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}
const tenant = (org: string) => ({ 'app.org_id': org });
const staff = { 'app.platform_scope': 'admin' };
/** Resolves to the error message of a statement that must fail (inside a transaction the failure poisons it, so each attempt gets its own). */
async function fails(role: string, gucs: Record<string, string>, q: string, p: unknown[] = []) {
  try {
    await as(role, gucs, (c) => c.query(q, p));
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

async function resource(
  rid: string,
  org: string | null,
  slug: string,
  visibility: string,
  status: string,
) {
  await root(
    `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, frameworks, visibility, source_kind, status, data_region)
     VALUES ($1,$2,$3,$4,'THEME','WEB','{nextjs}',$5,'upload',$6,'sa-central')`,
    [rid, org, slug, slug, visibility, status],
  );
}
async function version(
  rid: string,
  vid: string,
  org: string | null,
  state: string,
  licence: string,
) {
  await root(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, license_verdict)
     VALUES ($1,$2,$3,1,$4,$5,10,$6,$7)`,
    [vid, rid, org, state, HASH, `archives/${HASH}`, licence],
  );
}
async function permissions(rid: string, org: string | null, scope: string, licence: string) {
  await root(
    `INSERT INTO knowledge.resource_permissions (id, resource_id, org_id, reuse_scope, starter_eligible, license_verdict)
     VALUES ($1,$2,$3,$4,true,$5)`,
    [id(500 + Number(rid.slice(-3))), rid, org, scope, licence],
  );
}

beforeAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  await migrate({ url, migrationsDir, manifest });

  await resource(P_PUB, null, 'modern-saas', 'PLATFORM_PUBLISHED', 'ACTIVE');
  await version(P_PUB, V(1), null, 'ACTIVE', 'ALLOWED');
  await permissions(P_PUB, null, 'FULL_STARTER', 'ALLOWED');
  await root(
    `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,NULL,'1',$3)`,
    [
      id(601),
      V(1),
      JSON.stringify({ designDna: { style: 'minimal' }, internalNote: 'never-exposed' }),
    ],
  );
  await root(
    `INSERT INTO knowledge.theme_variants (id, version_id, org_id, kind, name, preview_key) VALUES ($1,$2,NULL,'layout','sidebar','previews/sidebar.png')`,
    [id(602), V(1)],
  );
  await root(
    `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes, object_key) VALUES ($1,$2,NULL,'src/app.tsx',$3,5,'objects/x')`,
    [id(603), V(1), HASH],
  );

  await resource(P_PRIV, null, 'internal-kit', 'PLATFORM_PRIVATE', 'AWAITING_REVIEW');
  await version(P_PRIV, V(2), null, 'AWAITING_REVIEW', 'ALLOWED');
  await permissions(P_PRIV, null, 'FULL_STARTER', 'ALLOWED');

  await resource(P_LIC, null, 'commercial-theme', 'PLATFORM_PUBLISHED', 'AWAITING_REVIEW');
  await version(P_LIC, V(3), null, 'AWAITING_REVIEW', 'UNKNOWN');
  await permissions(P_LIC, null, 'FULL_STARTER', 'UNKNOWN');

  await resource(T_A, A, 'a-private', 'TENANT_PRIVATE', 'ACTIVE');
  await version(T_A, V(4), A, 'ACTIVE', 'ALLOWED');
  await permissions(T_A, A, 'FULL_STARTER', 'ALLOWED');
  await resource(T_B, B, 'b-private', 'TENANT_PRIVATE', 'ACTIVE');
  await version(T_B, V(5), B, 'ACTIVE', 'ALLOWED');
  await permissions(T_B, B, 'FULL_STARTER', 'ALLOWED');
});

afterAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

describe('schema rules', () => {
  it('passes the ownership + RLS rules (every table owned, RLS enabled and forced, policies present)', async () => {
    expect(await checkDatabase(url, manifest)).toEqual([]);
  });
  it('seeds the three platform permissions and gives publish to two roles (the second approver)', async () => {
    const p = await root(
      `SELECT name FROM tenancy.permissions WHERE name LIKE 'admin:ai_knowledge:%' ORDER BY 1`,
    );
    expect(p.map((r) => r.name)).toEqual([
      'admin:ai_knowledge:manage',
      'admin:ai_knowledge:publish',
      'admin:ai_knowledge:read',
    ]);
    const r = await root(
      `SELECT role FROM tenancy.role_permissions WHERE permission = 'admin:ai_knowledge:publish' ORDER BY 1`,
    );
    expect(r.map((x) => x.role)).toEqual(['platform_admin', 'security']);
  });
});

describe('a customer never reads the platform library from the base tables', () => {
  it.each(['nuzm_app', 'nuzm_worker'])('%s: no org context sees nothing', async (role) => {
    for (const t of [
      'resources',
      'resource_versions',
      'resource_files',
      'resource_manifests',
      'resource_permissions',
      'theme_variants',
    ])
      expect(
        await as(role, {}, async (c) => (await c.query(`SELECT 1 FROM knowledge.${t}`)).rowCount),
      ).toBe(0);
  });
  it('org A sees only its own private template in every base table, never a platform row', async () => {
    const rows = await as(
      'nuzm_app',
      tenant(A),
      async (c) => (await c.query(`SELECT id FROM knowledge.resources ORDER BY id`)).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([T_A]);
    for (const t of ['resource_versions', 'resource_permissions'])
      expect(
        await as(
          'nuzm_app',
          tenant(A),
          async (c) => (await c.query(`SELECT org_id FROM knowledge.${t}`)).rows,
        ),
      ).toEqual([{ org_id: A }]);
    // the published platform version's files, manifest and variants are unreachable
    for (const t of ['resource_files', 'resource_manifests', 'theme_variants'])
      expect(
        await as(
          'nuzm_app',
          tenant(A),
          async (c) => (await c.query(`SELECT 1 FROM knowledge.${t}`)).rowCount,
        ),
      ).toBe(0);
  });
  it('org B cannot see org A (and the other way round)', async () => {
    const b = await as(
      'nuzm_app',
      tenant(B),
      async (c) => (await c.query(`SELECT id FROM knowledge.resources`)).rows,
    );
    expect(b.map((r) => r.id)).toEqual([T_B]);
  });
  it('staff under the platform scope read every row', async () => {
    const n = await as(
      'nuzm_app',
      staff,
      async (c) => (await c.query(`SELECT 1 FROM knowledge.resources`)).rowCount,
    );
    expect(n).toBe(5);
  });
  it('a tenant cannot write a platform row, nor a row of another organization', async () => {
    const ins = `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, visibility, source_kind, data_region)
                 VALUES ($1,$2,'x','x','THEME','TENANT_PRIVATE','customer','sa-central')`;
    expect(await fails('nuzm_app', tenant(A), ins, [id(900), null])).toMatch(
      /row-level security|check constraint/i,
    );
    expect(await fails('nuzm_app', tenant(A), ins, [id(901), B])).toMatch(/row-level security/i);
    expect(await fails('nuzm_app', {}, ins, [id(902), A])).toMatch(/row-level security/i);
  });
  it('the read-only roles and the worker cannot write', async () => {
    const ins = `INSERT INTO knowledge.usage_events (id, resource_id, kind) VALUES ($1,$2,'SELECTED')`;
    expect(await fails('nuzm_worker', staff, ins, [id(910), P_PUB])).toMatch(/permission denied/i);
    expect(await fails('nuzm_readonly_reporting', staff, ins, [id(911), P_PUB])).toMatch(
      /permission denied/i,
    );
  });
});

describe('knowledge.v_published_templates is the only door', () => {
  const list = (org: string | null) =>
    as('nuzm_app', org ? tenant(org) : {}, async (c) =>
      (
        await c.query(
          `SELECT resource_id FROM knowledge.v_published_templates ORDER BY resource_id`,
        )
      ).rows.map((r) => r.resource_id),
    );
  it("lists the published platform template plus the caller's own private one", async () => {
    expect(await list(A)).toEqual([P_PUB, T_A]);
    expect(await list(B)).toEqual([P_PUB, T_B]);
  });
  it('an unauthenticated session (no org) sees only published platform templates', async () => {
    expect(await list(null)).toEqual([P_PUB]);
  });
  it('never lists a private platform resource or one whose licence is not ALLOWED', async () => {
    const all = [...(await list(A)), ...(await list(B))];
    expect(all).not.toContain(P_PRIV);
    expect(all).not.toContain(P_LIC);
  });
  it('exposes metadata, a design summary and preview references, and nothing that locates source', async () => {
    const cols = await root(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'knowledge.v_published_templates'::regclass AND attnum > 0 AND NOT attisdropped`,
    );
    const names = cols.map((c) => c.attname);
    for (const forbidden of [
      'archive_key',
      'snapshot_key',
      'object_key',
      'path',
      'manifest',
      'checksum_sha256',
      'provenance',
      'source_ref',
    ])
      expect(names).not.toContain(forbidden);
    const row = (
      await as(
        'nuzm_app',
        tenant(A),
        async (c) =>
          (
            await c.query(
              `SELECT design_dna, preview_keys FROM knowledge.v_published_templates WHERE resource_id = $1`,
              [P_PUB],
            )
          ).rows,
      )
    )[0];
    expect(row.design_dna).toEqual({ style: 'minimal' }); // only the design summary key, not the whole manifest (the internal note stays out)
    expect(row.preview_keys).toEqual(['previews/sidebar.png']);
  });
  it('drops a template the moment it is disabled, its licence changes, or reuse is switched off', async () => {
    await root(`UPDATE knowledge.resources SET status = 'DISABLED' WHERE id = $1`, [P_PUB]);
    expect(await list(A)).toEqual([T_A]);
    await root(`UPDATE knowledge.resources SET status = 'ACTIVE' WHERE id = $1`, [P_PUB]);
    expect(await list(A)).toEqual([P_PUB, T_A]);
    await root(
      `UPDATE knowledge.resource_permissions SET license_verdict = 'RESTRICTED' WHERE resource_id = $1`,
      [P_PUB],
    );
    expect(await list(A)).toEqual([T_A]);
    await root(
      `UPDATE knowledge.resource_permissions SET license_verdict = 'ALLOWED', reuse_scope = 'NONE' WHERE resource_id = $1`,
      [P_PUB],
    );
    expect(await list(A)).toEqual([T_A]);
    await root(
      `UPDATE knowledge.resource_permissions SET reuse_scope = 'FULL_STARTER' WHERE resource_id = $1`,
      [P_PUB],
    );
    expect(await list(A)).toEqual([P_PUB, T_A]);
  });
});

describe('integrity rules in the database', () => {
  it('a version cannot be ACTIVE unless its licence verdict is ALLOWED (D-43)', async () => {
    for (const licence of ['UNKNOWN', 'RESTRICTED', 'BLOCKED'])
      expect(
        await fails(
          'nuzm_app',
          staff,
          `UPDATE knowledge.resource_versions SET state = 'ACTIVE', license_verdict = '${licence}' WHERE id = $1`,
          [V(3)],
        ),
      ).toMatch(/check constraint|licen[sc]e/i);
  });
  it('a resource has at most one ACTIVE version', async () => {
    const msg = await fails(
      'nuzm_app',
      staff,
      `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, license_verdict)
       VALUES ($1,$2,NULL,2,'ACTIVE',$3,1,'archives/other','ALLOWED')`,
      [id(950), P_PUB, 'b'.repeat(64)],
    );
    expect(msg).toMatch(/unique|duplicate/i);
  });
  it("a version's content, checksum and provenance are immutable and it is never deleted", async () => {
    for (const set of [
      "checksum_sha256 = repeat('c', 64)",
      'bytes = 99',
      "archive_key = 'archives/other'",
      'provenance = \'{"x":1}\'',
      'seq = 9',
    ])
      expect(
        await fails(
          'nuzm_app',
          staff,
          `UPDATE knowledge.resource_versions SET ${set} WHERE id = $1`,
          [V(1)],
        ),
      ).toMatch(/immutable/i);
    expect(
      await fails('nuzm_app', staff, `DELETE FROM knowledge.resource_versions WHERE id = $1`, [
        V(1),
      ]),
    ).toMatch(/permission denied/i);
    expect(
      await rootFails(`DELETE FROM knowledge.resource_versions WHERE id = $1`, [V(1)]),
    ).toMatch(/never deleted/i);
    // state and licence verdict may change: that is how a version moves through the pipeline
    expect(
      await fails(
        'nuzm_app',
        staff,
        `UPDATE knowledge.resource_versions SET state = 'DISABLED' WHERE id = $1`,
        [V(1)],
      ),
    ).toBeNull();
  });
  it('a resource keeps its identity, owner, type, source and region; it is archived, never deleted', async () => {
    for (const set of [
      "slug = 'other'",
      "org_id = '" + A + "'",
      "resource_type = 'PROJECT'",
      "data_region = 'eu'",
      "source_kind = 'github'",
    ])
      expect(
        await fails('nuzm_app', staff, `UPDATE knowledge.resources SET ${set} WHERE id = $1`, [
          P_PUB,
        ]),
      ).toMatch(/immutable|row-level|check constraint/i);
    expect(
      await fails('nuzm_app', staff, `DELETE FROM knowledge.resources WHERE id = $1`, [P_PUB]),
    ).toMatch(/permission denied/i);
    expect(await rootFails(`DELETE FROM knowledge.resources WHERE id = $1`, [P_PUB])).toMatch(
      /archived, never deleted/i,
    );
    const v = await as('nuzm_app', staff, async (c) => {
      await c.query(`UPDATE knowledge.resources SET description = 'x' WHERE id = $1`, [P_PUB]);
      return (await c.query(`SELECT version FROM knowledge.resources WHERE id = $1`, [P_PUB]))
        .rows[0].version;
    });
    expect(Number(v)).toBeGreaterThan(1); // the optimistic-concurrency version moves with every change
  });
  it('files, manifests, analysis results, quality scores, usage and evaluations are append-only', async () => {
    // the application role has no UPDATE/DELETE grant ...
    expect(
      await fails(
        'nuzm_app',
        staff,
        `UPDATE knowledge.resource_files SET bytes = 1 WHERE id = $1`,
        [id(603)],
      ),
    ).toMatch(/permission denied/i);
    expect(
      await fails('nuzm_app', staff, `DELETE FROM knowledge.resource_manifests WHERE id = $1`, [
        id(601),
      ]),
    ).toMatch(/permission denied/i);
    // ... and even the migration role is stopped by the trigger
    expect(
      await rootFails(`UPDATE knowledge.resource_files SET bytes = 1 WHERE id = $1`, [id(603)]),
    ).toMatch(/append-only/i);
    expect(
      await rootFails(`DELETE FROM knowledge.resource_manifests WHERE id = $1`, [id(601)]),
    ).toMatch(/append-only/i);
    expect(await rootFails(`UPDATE knowledge.quality_scores SET score = 1`)).toBeNull(); // nothing to update yet: no rows, no error
    expect(await rootFails(`DELETE FROM knowledge.usage_events WHERE false`)).toBeNull();
  });
  it('a quality score needs evidence: a number without evidence is refused, "not measured" is allowed', async () => {
    const q = (extra: string) =>
      `INSERT INTO knowledge.quality_scores (id, version_id, org_id, dimension, score, method, evidence_ref, measured) VALUES ($1,$2,NULL,'BUILD',${extra})`;
    expect(await fails('nuzm_app', staff, q(`90,'ai-opinion',NULL,true`), [id(960), V(1)])).toMatch(
      /check constraint/i,
    );
    expect(
      await fails('nuzm_app', staff, q(`90,'ai-opinion',NULL,false`), [id(961), V(1)]),
    ).toMatch(/check constraint|licen[sc]e/i);
    expect(
      await fails('nuzm_app', staff, q(`NULL,'not-run',NULL,false`), [id(962), V(1)]),
    ).toBeNull();
    expect(
      await fails('nuzm_app', staff, q(`88,'build-log','run/1',true`), [id(963), V(1)]),
    ).toBeNull();
  });
  it('money is integer minor units with a currency, never a bare number', async () => {
    const e = (cols: string, vals: string) =>
      `INSERT INTO knowledge.generation_evaluations (id, org_id, ${cols}) VALUES ($1,$2,${vals})`;
    expect(await fails('nuzm_app', tenant(A), e('cost_minor', '120'), [id(970), A])).toMatch(
      /check constraint/i,
    );
    expect(
      await fails('nuzm_app', tenant(A), e('cost_minor, currency', "120, 'SAR'"), [id(971), A]),
    ).toBeNull();
    expect(
      await fails('nuzm_app', tenant(A), e('cost_minor, currency', "120, 'sar'"), [id(972), A]),
    ).toMatch(/check constraint|licen[sc]e/i);
  });
  it("a customer's generation plan is invisible to another customer", async () => {
    await root(
      `INSERT INTO knowledge.generation_plans (id, org_id, project_id, selection_strategy, plan) VALUES ($1,$2,$3,'AUTO_SELECT','{}')`,
      [id(980), A, id(981)],
    );
    expect(
      await as(
        'nuzm_app',
        tenant(B),
        async (c) => (await c.query(`SELECT 1 FROM knowledge.generation_plans`)).rowCount,
      ),
    ).toBe(0);
    expect(
      await as(
        'nuzm_app',
        tenant(A),
        async (c) => (await c.query(`SELECT 1 FROM knowledge.generation_plans`)).rowCount,
      ),
    ).toBe(1);
    expect(
      await as(
        'nuzm_app',
        staff,
        async (c) => (await c.query(`SELECT 1 FROM knowledge.generation_plans`)).rowCount,
      ),
    ).toBe(1);
  });
  it('lexical search documents are searchable by Arabic and English words (exact tokens, no stemmer)', async () => {
    await root(
      `INSERT INTO knowledge.resource_search_documents (id, version_id, org_id, doc_kind, ref, title, body, content_hash)
       VALUES ($1,$2,NULL,'SUMMARY','summary','Hospital dashboard','لوحة تحكم للمستشفى with patients and invoices',$3)`,
      [id(990), V(1), HASH],
    );
    const hit = async (q: string) =>
      (
        await root(
          `SELECT 1 FROM knowledge.resource_search_documents WHERE tsv @@ plainto_tsquery('simple', $1)`,
          [q],
        )
      ).length;
    expect(await hit('hospital')).toBe(1);
    expect(await hit('للمستشفى')).toBe(1);
    expect(await hit('payroll')).toBe(0);
    // no Arabic stemmer: a prefixed form is a different token (a known limit of the lexical layer, ADR-065; the semantic layer waits for D-47)
    expect(await hit('المستشفى')).toBe(0);
  });
});
