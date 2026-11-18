import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Applies db/migrations/NNNN_name.sql in order, once each, recording them in schema_migrations. `down <version>` runs the matching .down.sql. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL must be set');
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
);
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql'))
  .sort();
if (process.argv[2] === 'down') {
  const v = Number(process.argv[3]);
  const f = files.find((x) => Number(x.slice(0, 4)) === v);
  if (!f) throw new Error('no migration ' + v);
  await client.query('BEGIN');
  await client.query(readFileSync(join(dir, f.replace(/\.sql$/, '.down.sql')), 'utf8'));
  await client.query('DELETE FROM schema_migrations WHERE version = $1', [v]);
  await client.query('COMMIT');
  console.log('reverted ' + f);
} else {
  const done = new Set(
    (await client.query('SELECT version FROM schema_migrations')).rows.map(
      (r: { version: number }) => r.version,
    ),
  );
  for (const f of files) {
    const v = Number(f.slice(0, 4));
    if (done.has(v)) continue;
    await client.query('BEGIN');
    await client.query(readFileSync(join(dir, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
      v,
      f.slice(5, -4),
    ]);
    await client.query('COMMIT');
    console.log('applied ' + f);
  }
}
await client.end();
