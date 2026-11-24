import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `@nuzm/db` is not a dependency of `@nuzm/api` (and package.json is Master-owned): load its built output by path. Needs `pnpm --filter @nuzm/db build` once.
interface Mig {
  ordinal: number;
  schema: string;
  slug: string;
  downSql: string | null;
}
interface RunOpts {
  url: string;
  migrationsDir: string;
  manifest: unknown;
}
const dbPkg = createRequire(join(process.cwd(), 'package.json'))(
  join(process.cwd(), '..', '..', 'packages', 'db', 'dist', 'index.js'),
) as {
  discoverMigrations(dir: string, manifest: unknown): Mig[];
  loadManifest(path: string): unknown;
  migrate(o: RunOpts): Promise<Mig[]>;
  rollback(o: RunOpts, steps?: number): Promise<Mig[]>;
};
const { discoverMigrations, loadManifest, migrate, rollback } = dbPkg;

/**
 * Session 07 (QA) - migration up / down / up for the AI Agent Engine range (CLAUDE.md section 4: "forward-only, documented reversal"; docs/05).
 * On a scratch database of its own (`nuzm_s07_migrt`, own cluster :54347): migrate everything, fingerprint the schema, roll back every migration with ordinal >= FROM
 * with its documented `.down.sql`, assert the AI/deploy objects are really gone, migrate again, and assert the fingerprint is IDENTICAL (tables, columns, types,
 * defaults, nullability, constraints, indexes, triggers, RLS flag and policies, functions). It runs against the migrations present in THIS worktree: when the Master
 * merges the Session 02-06 ranges (1900-1999) they are covered automatically. FROM defaults to 1800 (the first AI-engine migration); raise it with QA_MIG_FROM.
 */
const FROM = Number(process.env.QA_MIG_FROM ?? 1800);
const ADMIN = process.env.NUZM_TEST_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54347/postgres';
const DB_NAME = 'nuzm_s07_migrt';
const urlFor = (db: string) => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  return u.toString();
};
const root = join(process.cwd(), '..', '..');
const migrationsDir = join(root, 'packages', 'db', 'migrations');
const manifest = loadManifest(join(root, 'spec', 'db', 'ownership.yaml'));
const opts = { url: urlFor(DB_NAME), migrationsDir, manifest };

const q = async <R extends Record<string, unknown>>(sql: string, args: unknown[] = []) => {
  const c = new Client({ connectionString: opts.url });
  await c.connect();
  try {
    return (await c.query(sql, args)).rows as R[];
  } finally {
    await c.end();
  }
};
/** A deterministic text fingerprint of everything an application schema consists of. */
async function fingerprint(): Promise<string[]> {
  const rows = await q<{ line: string }>(`
    WITH s AS (SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema')
    SELECT line FROM (
      SELECT 'col ' || c.table_schema || '.' || c.table_name || '.' || c.column_name || ' ' || c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '') AS line
        FROM information_schema.columns c WHERE c.table_schema IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'con ' || n.nspname || '.' || cl.relname || ' ' || co.conname || ' ' || pg_get_constraintdef(co.oid)
        FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'idx ' || schemaname || '.' || tablename || ' ' || indexdef FROM pg_indexes WHERE schemaname IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'trg ' || n.nspname || '.' || cl.relname || ' ' || pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'rls ' || n.nspname || '.' || cl.relname || ' ' || cl.relrowsecurity || ' ' || cl.relforcerowsecurity
        FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE cl.relkind = 'r' AND n.nspname IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname IN (SELECT nspname FROM s)
      UNION ALL
      SELECT 'fn ' || n.nspname || '.' || p.proname || ' ' || md5(pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN (SELECT nspname FROM s) AND p.prokind = 'f'
      UNION ALL
      SELECT 'perm ' || permission || ' ' || role FROM tenancy.role_permissions
      UNION ALL
      SELECT 'permdef ' || name FROM tenancy.permissions
    ) x ORDER BY line`);
  return rows.map((r) => r.line);
}

let before: string[] = [];
let reverted: number[] = [];

beforeAll(async () => {
  const c = new Client({ connectionString: ADMIN });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await c.end();
  }
  await migrate(opts);
  before = await fingerprint();
}, 300_000);
afterAll(async () => {
  const c = new Client({ connectionString: ADMIN });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}, 60_000);

describe('QA migrations: every migration of the AI Agent Engine range is reversible', () => {
  const all = discoverMigrations(migrationsDir, manifest);
  const range = all.filter((m) => m.ordinal >= FROM);

  it('finds the range (the scanner is not blind)', () => {
    expect(range.length).toBeGreaterThanOrEqual(10);
  });
  it('each has a documented reversal (.down.sql)', () => {
    expect(range.filter((m) => !m.downSql).map((m) => `${m.ordinal}:${m.slug}`)).toEqual([]);
  });
  it('the file names of a range follow NNNN__schema__slug and the schema folder matches the file', () => {
    const bad: string[] = [];
    for (const m of range) {
      const dirs = readdirSync(migrationsDir).filter((d) =>
        readdirSync(join(migrationsDir, d)).some((f) =>
          f.startsWith(`${String(m.ordinal).padStart(4, '0')}__`),
        ),
      );
      if (dirs.length !== 1 || dirs[0] !== m.schema)
        bad.push(`${m.ordinal}:${m.slug} in ${dirs.join(',')}`);
    }
    expect(bad).toEqual([]);
  });
  it('ordinals are unique', () => {
    const seen = new Set<number>();
    const dup = all.filter((m) => (seen.has(m.ordinal) ? true : (seen.add(m.ordinal), false)));
    expect(dup.map((m) => m.ordinal)).toEqual([]);
  });

  it('DOWN: rolls back every migration from the range with its .down.sql', async () => {
    const applied = await q<{ ordinal: number }>(
      `SELECT ordinal FROM public.nuzm_migrations WHERE ordinal >= $1 ORDER BY ordinal DESC`,
      [FROM],
    );
    expect(applied.length).toBe(range.length);
    const done = await rollback(opts, applied.length);
    reverted = done.map((m) => m.ordinal);
    expect(reverted).toEqual(applied.map((a) => a.ordinal));
    const left = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.nuzm_migrations WHERE ordinal >= $1`,
      [FROM],
    );
    expect(left[0]!.n).toBe(0);
  }, 300_000);

  it('DOWN really removed the AI engine objects (the reversal is not a no-op)', async () => {
    const tables = await q<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema = 'ai' AND table_name IN ('model_capability_evidence','agent_tool_calls','agent_run_steps')`,
    );
    expect(tables).toEqual([]);
    const mid = await fingerprint();
    expect(mid.length).toBeLessThan(before.length);
  });

  it('UP again: migrates the range once more with no error', async () => {
    const done = await migrate(opts);
    expect(done.map((m) => m.ordinal)).toEqual(reverted.slice().reverse());
  }, 300_000);

  it('the schema after down + up is IDENTICAL to the schema after the first up (no drift, no leftover)', async () => {
    const after = await fingerprint();
    const missing = before.filter((l) => !after.includes(l));
    const extra = after.filter((l) => !before.includes(l));
    expect({
      missingAfterRoundTrip: missing.slice(0, 20),
      extraAfterRoundTrip: extra.slice(0, 20),
    }).toEqual({
      missingAfterRoundTrip: [],
      extraAfterRoundTrip: [],
    });
  });

  it('a second migrate is a no-op (checksums are stable)', async () => {
    expect(await migrate(opts)).toEqual([]);
  });
});
