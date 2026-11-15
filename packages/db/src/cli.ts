import { join } from 'node:path';
import { Client } from 'pg';
import { checkDatabase } from './checks';
import { loadManifest } from './migrations';
import { migrate, rollback } from './runner';

const root = join(__dirname, '..', '..', '..');
const manifest = loadManifest(join(root, 'spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '..', 'migrations');
const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev';

async function ensureDatabase(target: string) {
  const u = new URL(target);
  const name = u.pathname.slice(1);
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return; // never auto-create on remote hosts
  u.pathname = '/postgres';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await c.end();
  }
}

async function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'migrate') {
    await ensureDatabase(url);
    const done = await migrate({ url, migrationsDir, manifest });
    console.log(
      done.length
        ? `applied: ${done.map((m) => `${m.ordinal}:${m.slug}`).join(', ')}`
        : 'no pending migrations',
    );
  } else if (cmd === 'rollback') {
    const done = await rollback({ url, migrationsDir, manifest });
    console.log(`reverted: ${done.map((m) => `${m.ordinal}:${m.slug}`).join(', ') || 'nothing'}`);
  } else if (cmd === 'dev-logins') {
    // DEV ONLY: give the runtime roles LOGIN + a throwaway password on the project-local cluster.
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname))
      throw new Error('dev-logins only runs against a local database');
    const pw = (process.env.NUZM_DEV_ROLE_PASSWORD ?? 'nuzm_dev_only').replace(/'/g, '');
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      for (const r of ['nuzm_app', 'nuzm_worker'])
        await c.query(`ALTER ROLE ${r} LOGIN PASSWORD '${pw}'`);
    } finally {
      await c.end();
    }
    console.log('dev logins enabled for nuzm_app, nuzm_worker (dev password)');
  } else if (cmd === 'check') {
    const v = await checkDatabase(url, manifest);
    if (v.length) {
      console.error(
        'DB CHECK FAILED:\n' + v.map((x) => ` - [${x.kind}] ${x.object}: ${x.detail}`).join('\n'),
      );
      process.exit(1);
    }
    console.log('db check OK: ownership + RLS rules hold');
  } else {
    console.error('usage: cli.ts migrate|rollback|dev-logins|check');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
