import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Applies db/migrations/NNNN_name.sql in order, once each, recording them in schema_migrations. Forward-only in normal use and RE-RUNNABLE: a second run applies nothing.
 * Each migration runs in its own transaction together with its ledger row, so a failure leaves the database at the previous version. `down <version>` runs the matching `.down.sql`
 * (development and staging only; production is fixed forward).
 */
const defaultDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export async function migrate(
  url: string,
  opts: { dir?: string; down?: number; log?: (line: string) => void } = {},
): Promise<string[]> {
  const dir = opts.dir ?? defaultDir;
  const log = opts.log ?? ((l: string) => console.log(l));
  const applied: string[] = [];
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql'))
      .sort();
    if (opts.down !== undefined) {
      const f = files.find((x) => Number(x.slice(0, 4)) === opts.down);
      if (!f) throw new Error('no migration ' + opts.down);
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, f.replace(/\.sql$/, '.down.sql')), 'utf8'));
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [opts.down]);
      await client.query('COMMIT');
      log('reverted ' + f);
      applied.push('down:' + f);
    } else {
      const done = new Set(
        (await client.query('SELECT version FROM schema_migrations')).rows.map(
          (r: { version: number }) => r.version,
        ),
      );
      for (const f of files) {
        const v = Number(f.slice(0, 4));
        if (done.has(v)) continue;
        try {
          await client.query('BEGIN');
          await client.query(readFileSync(join(dir, f), 'utf8'));
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
            v,
            f.slice(5, -4),
          ]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
        log('applied ' + f);
        applied.push(f);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// command line: `node src/migrate.ts` (up) or `node src/migrate.ts down <version>`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL must be set');
  await migrate(url, process.argv[2] === 'down' ? { down: Number(process.argv[3]) } : {});
}
