import { Client } from 'pg';
import { discoverMigrations, type Manifest, type MigrationFile } from './migrations';

const LOCK_KEY = 727274; // arbitrary constant: serialises concurrent migrators

export interface RunOptions {
  url: string;
  migrationsDir: string;
  manifest: Manifest;
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureTable(c: Client) {
  await c.query(`CREATE TABLE IF NOT EXISTS public.nuzm_migrations (
    ordinal int PRIMARY KEY, schema_name text NOT NULL, slug text NOT NULL,
    checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

/** Apply pending migrations in ordinal order, each in its own transaction. Forward-only. */
export async function migrate(opts: RunOptions): Promise<MigrationFile[]> {
  const all = discoverMigrations(opts.migrationsDir, opts.manifest);
  return withClient(opts.url, async (c) => {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await ensureTable(c);
      const { rows } = await c.query<{ ordinal: number; checksum: string }>(
        'SELECT ordinal, checksum FROM public.nuzm_migrations ORDER BY ordinal',
      );
      const applied = new Map(rows.map((r) => [r.ordinal, r.checksum]));
      const maxApplied = rows.length ? Math.max(...rows.map((r) => r.ordinal)) : 0;
      const done: MigrationFile[] = [];
      for (const m of all) {
        const have = applied.get(m.ordinal);
        if (have !== undefined) {
          if (have !== m.checksum)
            throw new Error(
              `checksum mismatch for applied migration ${m.ordinal} (${m.slug}): applied migrations are immutable`,
            );
          continue;
        }
        if (m.ordinal < maxApplied)
          throw new Error(
            `migration ${m.ordinal} (${m.slug}) is older than an applied migration (forward-only)`,
          );
        await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query(
            'INSERT INTO public.nuzm_migrations (ordinal, schema_name, slug, checksum) VALUES ($1,$2,$3,$4)',
            [m.ordinal, m.schema, m.slug, m.checksum],
          );
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw new Error(`migration ${m.ordinal} (${m.slug}) failed: ${(e as Error).message}`, {
            cause: e,
          });
        }
        done.push(m);
      }
      return done;
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  });
}

/** Dev/staging only: revert the most recent `steps` migrations using their documented .down.sql. */
export async function rollback(opts: RunOptions, steps = 1): Promise<MigrationFile[]> {
  const all = new Map(
    discoverMigrations(opts.migrationsDir, opts.manifest).map((m) => [m.ordinal, m]),
  );
  return withClient(opts.url, async (c) => {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await ensureTable(c);
      const { rows } = await c.query<{ ordinal: number }>(
        'SELECT ordinal FROM public.nuzm_migrations ORDER BY ordinal DESC LIMIT $1',
        [steps],
      );
      const reverted: MigrationFile[] = [];
      for (const r of rows) {
        const m = all.get(r.ordinal);
        if (!m?.downSql) throw new Error(`no reversal available for ordinal ${r.ordinal}`);
        await c.query('BEGIN');
        try {
          await c.query(m.downSql);
          await c.query('DELETE FROM public.nuzm_migrations WHERE ordinal = $1', [r.ordinal]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw new Error(`rollback of ${m.ordinal} failed: ${(e as Error).message}`, { cause: e });
        }
        reverted.push(m);
      }
      return reverted;
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  });
}
