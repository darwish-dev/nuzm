import { Client } from 'pg';
import type { Manifest } from './migrations';

export interface Violation {
  kind:
    | 'unknown_schema'
    | 'unknown_table'
    | 'rls_missing'
    | 'rls_not_forced'
    | 'policy_missing'
    | 'tenant_less_unlisted';
  object: string;
  detail: string;
}

const SYSTEM = new Set(['pg_catalog', 'information_schema', 'public']);

/**
 * docs/05 rules: (1) every table lives in a manifest schema and is listed there; (2) every table
 * with an org_id column has RLS enabled AND forced plus at least one policy; (3) every table
 * without org_id is explicitly listed in tenant_less.
 */
export async function checkDatabase(url: string, manifest: Manifest): Promise<Violation[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const out: Violation[] = [];
    const tables = await c.query<{
      schema: string;
      table: string;
      rls: boolean;
      forced: boolean;
      has_org: boolean;
      policies: string;
    }>(`
      SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS has_org,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND NOT c.relispartition -- partitions are governed by their parent table
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      ORDER BY 1, 2`);
    const schemasWithObjects = await c.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
    );
    for (const s of schemasWithObjects.rows) {
      if (!SYSTEM.has(s.nspname) && !manifest.schemas[s.nspname]) {
        out.push({
          kind: 'unknown_schema',
          object: s.nspname,
          detail: 'schema not in ownership manifest',
        });
      }
    }
    for (const t of tables.rows) {
      const fq = `${t.schema}.${t.table}`;
      if (t.schema === 'public') {
        if (t.table !== 'nuzm_migrations')
          out.push({
            kind: 'unknown_table',
            object: fq,
            detail: 'application tables must not live in public',
          });
        continue;
      }
      const owner = manifest.schemas[t.schema];
      if (!owner) continue; // already reported as unknown_schema
      if (!owner.tables.includes(t.table)) {
        out.push({
          kind: 'unknown_table',
          object: fq,
          detail: 'table not listed in ownership manifest',
        });
      }
      if (t.has_org || manifest.rls_keyed.includes(fq)) {
        if (!t.rls)
          out.push({
            kind: 'rls_missing',
            object: fq,
            detail: 'org_id table without ROW LEVEL SECURITY',
          });
        else if (!t.forced)
          out.push({ kind: 'rls_not_forced', object: fq, detail: 'RLS enabled but not FORCED' });
        if (Number(t.policies) === 0)
          out.push({
            kind: 'policy_missing',
            object: fq,
            detail: 'tenant-scoped table without any policy',
          });
      } else if (!manifest.tenant_less.includes(fq)) {
        out.push({
          kind: 'tenant_less_unlisted',
          object: fq,
          detail: 'no org_id and not listed in tenant_less',
        });
      }
    }
    return out;
  } finally {
    await c.end();
  }
}
