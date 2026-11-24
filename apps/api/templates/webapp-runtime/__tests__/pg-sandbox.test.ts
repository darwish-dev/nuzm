import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findPgBin, freePort } from '../probe/pg-sandbox.ts';

test('findPgBin: an explicit directory with the three server binaries wins; an incomplete one is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'pgbin-'));
  try {
    const good = join(root, 'good');
    const bad = join(root, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    for (const b of ['initdb', 'pg_ctl', 'postgres']) writeFileSync(join(good, b), '');
    writeFileSync(join(bad, 'initdb'), '');
    assert.equal(findPgBin(good, ''), good);
    assert.notEqual(findPgBin(bad, ''), bad);
    assert.equal(findPgBin(undefined, bad + ':' + good), good);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('freePort returns a usable loopback port', async () => {
  const p = await freePort();
  assert.ok(Number.isInteger(p) && p > 1023 && p < 65536);
});

// Opt-in (needs PostgreSQL server binaries): P3_S05_PG_BIN=/path/to/postgresql@16/bin. This tests the platform-owned bootstrap itself (no generated code): a real throw-away cluster is created,
// the app role is NOT a superuser and does not bypass row-level security, the admin password file is gone, the database is reachable only on loopback, and stop() removes everything.
const bin = process.env['P3_S05_PG_BIN'];
test(
  'startEphemeralPg creates an isolated cluster and destroys it',
  { skip: bin ? false : 'set P3_S05_PG_BIN to run against a real PostgreSQL', timeout: 120_000 },
  async () => {
    const { startEphemeralPg } = await import('../probe/pg-sandbox.ts');
    const pg = (await import('pg')).default;
    const work = mkdtempSync(join(tmpdir(), 'p3s05-eph-'));
    const db = await startEphemeralPg({ workDir: work, binDir: bin as string });
    try {
      assert.equal(db.host, '127.0.0.1');
      assert.equal(db.role, 'app_owner');
      assert.ok(existsSync(db.dataDir));
      assert.ok(
        !existsSync(join(db.dataDir, '..', 'admin.pw')),
        'the admin password file must not outlive the setup',
      );
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      const r = await c.query(
        'SELECT current_user AS u, current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass',
      );
      assert.deepEqual(r.rows[0], { u: 'app_owner', d: 'app', su: false, bypass: false });
      await c.query('CREATE TABLE t (id int)'); // the role owns its database
      await c.end();
      // the admin role cannot be used with the app password, and the app role cannot reach other databases
      const u = new URL(db.url);
      const other = new pg.Client({
        host: u.hostname,
        port: Number(u.port),
        user: 'app_owner',
        password: decodeURIComponent(u.password),
        database: 'postgres',
      });
      other.on('error', () => undefined);
      await assert.rejects(async () => {
        await other.connect();
      }, /permission denied|not allowed|CONNECT/i);
      await other.end().catch(() => undefined);
      assert.ok(!db.url.includes('nuzm_admin'));
    } finally {
      await db.stop();
    }
    assert.ok(!existsSync(db.dataDir), 'the data directory must be gone after stop()');
    rmSync(work, { recursive: true, force: true });
  },
);
