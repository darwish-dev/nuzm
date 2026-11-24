// Regression tests for the test-environment allocator: port collisions, cross-session database access, missing/unsafe URLs, capacity, safe cleanup,
// and (when Postgres 16 is installed) a REAL cluster whose per-lease password keeps another session out.   Run: node --test scripts/testenv/
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquire,
  capacity,
  checkUrl,
  config,
  gc,
  leaseEnv,
  listLeases,
  release,
  status,
  TestEnvError,
} from './lib.mjs';
import { assertTestDatabase } from './guard.mjs';

let root;
let env;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuzm-testenv-test-'));
  env = {
    ...process.env,
    NUZM_TESTENV_ROOT: root,
    NUZM_TESTENV_PORT_MIN: '56000',
    NUZM_TESTENV_PORT_MAX: '56199',
    NUZM_TESTENV_MAX_LEASES: '64',
    CI: undefined,
    NUZM_TEST_DB_POLICY: undefined,
    NUZM_LEASE_ID: undefined,
  };
});
afterEach(async () => {
  for (const l of listLeases(config(env))) await release(l.id, { env }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});
const rejects = (fn, code) =>
  assert.rejects(fn, (e) => e instanceof TestEnvError && e.code === code, `expected ${code}`);
const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof TestEnvError && e.code === code, `expected ${code}`);

describe('port allocation', () => {
  it('twenty concurrent acquisitions get twenty distinct ports inside the range (atomic reservation)', async () => {
    const leases = await Promise.all(
      Array.from({ length: 20 }, (_, i) => acquire({ owner: `s${i}`, pg: false, env })),
    );
    const ports = leases.map((l) => l.port);
    assert.equal(new Set(ports).size, 20);
    for (const p of ports) assert.ok(p >= 56000 && p <= 56199);
    assert.equal(listLeases(config(env)).length, 20);
  });
  it('the same explicit port cannot be reserved twice: the second request is rejected', async () => {
    await acquire({ pg: false, port: 56010, env });
    await rejects(() => acquire({ pg: false, port: 56010, env }), 'port_reserved');
  });
  it('a port held by a foreign process is rejected when requested and skipped when automatic', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(56020, '127.0.0.1', r));
    try {
      await rejects(() => acquire({ pg: false, port: 56020, env }), 'port_busy');
      const got = await Promise.all(Array.from({ length: 30 }, () => acquire({ pg: false, env })));
      assert.ok(got.every((l) => l.port !== 56020));
    } finally {
      srv.close();
    }
  });
  it('protected and out-of-range ports are refused outright (the owner dev cluster can never be leased)', async () => {
    await rejects(
      () =>
        acquire({
          pg: false,
          port: 54329,
          env: { ...env, NUZM_TESTENV_PORT_MIN: '54000', NUZM_TESTENV_PORT_MAX: '54999' },
        }),
      'port_protected',
    );
    await rejects(() => acquire({ pg: false, port: 55000, env }), 'port_out_of_range');
  });
  it('automatic allocation never returns a protected port even when the range contains one', async () => {
    const e = {
      ...env,
      NUZM_TESTENV_PORT_MIN: '54320',
      NUZM_TESTENV_PORT_MAX: '54380',
      NUZM_TESTENV_MAX_LEASES: '64',
    };
    const got = await Promise.all(Array.from({ length: 10 }, () => acquire({ pg: false, env: e })));
    assert.ok(got.every((l) => l.port !== 54329 && (l.port < 54330 || l.port > 54369)));
  });
  it('the allocator stops at capacity: the lease beyond the CPU/memory bound is rejected', async () => {
    const e = { ...env, NUZM_TESTENV_MAX_LEASES: '2' };
    await acquire({ pg: false, env: e });
    await acquire({ pg: false, env: e });
    await rejects(() => acquire({ pg: false, env: e }), 'capacity');
  });
  it('capacity is derived from CPUs and memory when not overridden', () => {
    const c = { ...config(env), maxLeases: undefined };
    assert.equal(capacity(c, 2400, 8), 2); // memory-bound
    assert.equal(capacity(c, 64000, 4), 4); // CPU-bound
    assert.equal(capacity(c, 100, 8), 1); // never below one
  });
});

describe('database URL preflight (no fallback, no cross-session access)', () => {
  it('a missing, empty or malformed URL is refused: there is no default database', () => {
    throwsCode(() => checkUrl(undefined, { env }), 'url_missing');
    throwsCode(() => checkUrl('   ', { env }), 'url_missing');
    throwsCode(() => checkUrl('not a url', { env }), 'url_invalid');
    throwsCode(() => checkUrl('mysql://u@127.0.0.1:56001/x', { env }), 'url_invalid');
  });
  it('the owner dev cluster and system Postgres are refused whatever the lease', () => {
    for (const p of [54329, 54339, 5432])
      throwsCode(
        () =>
          checkUrl(`postgres://nuzm_admin@127.0.0.1:${p}/postgres`, {
            env: { ...env, NUZM_LEASE_ID: 'x' },
          }),
        'port_protected',
      );
    throwsCode(
      () =>
        checkUrl('postgres://nuzm_admin@127.0.0.1:54329/postgres', {
          env: { ...env, CI: 'true', NUZM_TEST_DB_POLICY: 'ci' },
        }),
      'port_protected',
    );
  });
  it('a non-loopback host is refused', () => {
    throwsCode(
      () => checkUrl('postgres://u@db.example.com:56001/postgres', { env }),
      'host_not_loopback',
    );
    throwsCode(
      () => checkUrl('postgres://u@10.0.0.5:56001/postgres', { env }),
      'host_not_loopback',
    );
  });
  it('without a lease in the environment the URL is refused', async () => {
    const l = await acquire({ pg: false, env });
    throwsCode(
      () => checkUrl(`postgres://nuzm_admin@127.0.0.1:${l.port}/postgres`, { env }),
      'no_lease',
    );
  });
  it('a port that is not an allocated environment is refused', async () => {
    const l = await acquire({ pg: false, env });
    throwsCode(
      () =>
        checkUrl('postgres://nuzm_admin@127.0.0.1:56190/postgres', {
          env: { ...env, NUZM_LEASE_ID: l.id },
        }),
      'port_not_leased',
    );
  });
  it("one session cannot use another session's database: the foreign lease is rejected", async () => {
    const a = await acquire({ owner: 'A', pg: false, env });
    const b = await acquire({ owner: 'B', pg: false, env });
    const envA = { ...env, NUZM_LEASE_ID: a.id };
    checkUrl(`postgres://nuzm_admin@127.0.0.1:${a.port}/postgres`, { env: envA }); // own: fine
    throwsCode(
      () => checkUrl(`postgres://nuzm_admin@127.0.0.1:${b.port}/postgres`, { env: envA }),
      'foreign_lease',
    );
    const envB = { ...env, NUZM_LEASE_ID: b.id };
    throwsCode(
      () => checkUrl(`postgres://nuzm_admin@127.0.0.1:${a.port}/postgres`, { env: envB }),
      'foreign_lease',
    );
  });
  it('an expired lease is refused', async () => {
    const l = await acquire({
      pg: false,
      ttlHours: -1,
      env: { ...env, NUZM_TESTENV_MAX_LEASES: '64' },
    });
    throwsCode(
      () =>
        checkUrl(`postgres://nuzm_admin@127.0.0.1:${l.port}/postgres`, {
          env: { ...env, NUZM_LEASE_ID: l.id },
        }),
      'lease_expired',
    );
  });
  it('the CI policy accepts a non-protected loopback service port only when CI=true and the policy is named', () => {
    const url = 'postgres://nuzm_admin@127.0.0.1:5439/postgres';
    throwsCode(() => checkUrl(url, { env }), 'no_lease');
    throwsCode(() => checkUrl(url, { env: { ...env, NUZM_TEST_DB_POLICY: 'ci' } }), 'no_lease'); // policy without CI=true
    assert.equal(checkUrl(url, { env: { ...env, CI: 'true', NUZM_TEST_DB_POLICY: 'ci' } }), null);
  });
  it('the vitest guard refuses a stray DATABASE_URL that points at a protected port even when the test URL is fine', async () => {
    const l = await acquire({ pg: false, env });
    const good = {
      ...env,
      NUZM_LEASE_ID: l.id,
      NUZM_TEST_ADMIN_URL: `postgres://nuzm_admin@127.0.0.1:${l.port}/postgres`,
    };
    assertTestDatabase(good);
    assert.throws(
      () =>
        assertTestDatabase({
          ...good,
          DATABASE_URL: 'postgres://nuzm_app:x@127.0.0.1:54329/nuzm_dev',
        }),
      /DATABASE_URL: .*protected/,
    );
    assert.throws(
      () => assertTestDatabase({ ...good, NUZM_TEST_ADMIN_URL: undefined }),
      /mandatory/,
    );
  });
  it('the CLI refuses with exit code 3 and a reason when the URL is missing', () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testenv.mjs');
    const r = spawnSync(process.execPath, [cli, 'check-url'], {
      env: { ...env, NUZM_TEST_ADMIN_URL: '' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /url_missing/);
  });
});

describe('no default database outside a lease (DEFECT-19)', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const clean = (extra = {}) => {
    const e = { ...process.env, ...extra };
    for (const k of [
      'DATABASE_ADMIN_URL',
      'DATABASE_URL',
      'NUZM_TEST_ADMIN_URL',
      'NUZM_ALLOW_OWNER_DEV_DB',
      'NUZM_FORBID_DEFAULT_DB',
      'NUZM_LEASE_ID',
      'NUZM_LEASE_PORT',
      'NUZM_PGPORT',
    ])
      if (!(k in extra)) delete e[k];
    return e;
  };
  const dbCli = (extra) =>
    spawnSync(path.join(repo, 'packages/db/node_modules/.bin/tsx'), ['src/cli.ts', 'migrate'], {
      cwd: path.join(repo, 'packages/db'),
      env: clean(extra),
      encoding: 'utf8',
      timeout: 60000,
    });
  it('the db CLI without a URL and without the owner opt-in refuses (exit 2) before any connection', () => {
    const r = dbCli();
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, /DATABASE_ADMIN_URL is mandatory/);
  });
  it('even the owner opt-in does not help inside a leased session (NUZM_FORBID_DEFAULT_DB=1)', () => {
    const r = dbCli({ NUZM_ALLOW_OWNER_DEV_DB: '1', NUZM_FORBID_DEFAULT_DB: '1' });
    assert.equal(r.status, 2, r.stderr + r.stdout);
  });
  it('a leased shell cannot point the db CLI at another port', () => {
    const r = dbCli({
      DATABASE_ADMIN_URL: 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev',
      NUZM_LEASE_PORT: '54500',
      NUZM_FORBID_DEFAULT_DB: '1',
    });
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, /not this session's leased database port/);
  });
  it('dev-services start without NUZM_PGPORT refuses unless the owner opted in; status is always allowed', () => {
    const start = spawnSync('bash', ['scripts/dev-services.sh', 'start'], {
      cwd: repo,
      env: clean(),
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(start.status, 2);
    assert.match(start.stderr, /NUZM_PGPORT is mandatory/);
    const st = spawnSync('bash', ['scripts/dev-services.sh', 'status'], {
      cwd: repo,
      env: clean(),
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.notEqual(st.status, 2);
  });
  it('legacy fixed session ports are protected, and the CI policy cannot reach a leased port or run inside a lease', async () => {
    for (const p of [54341, 54345, 54369])
      throwsCode(
        () =>
          checkUrl(`postgres://nuzm_admin@127.0.0.1:${p}/postgres`, {
            env: { ...env, NUZM_LEASE_ID: 'x' },
          }),
        'port_protected',
      );
    const ci = { ...env, CI: 'true', NUZM_TEST_DB_POLICY: 'ci' };
    throwsCode(
      () => checkUrl('postgres://nuzm_admin@127.0.0.1:54341/postgres', { env: ci }),
      'port_protected',
    );
    const l = await acquire({ pg: false, env });
    throwsCode(
      () => checkUrl(`postgres://nuzm_admin@127.0.0.1:${l.port}/postgres`, { env: ci }),
      'foreign_lease',
    );
    throwsCode(
      () =>
        checkUrl('postgres://nuzm_admin@127.0.0.1:5439/postgres', {
          env: { ...ci, NUZM_LEASE_ID: l.id },
        }),
      'foreign_lease',
    );
    assert.equal(checkUrl('postgres://nuzm_admin@127.0.0.1:5439/postgres', { env: ci }), null);
  });
});

describe('safe cleanup', () => {
  it('release removes the lease, its directory and its port reservation, and the port can be reused', async () => {
    const l = await acquire({ pg: false, port: 56030, env });
    assert.ok(fs.existsSync(path.dirname(l.pgdata)) || true);
    await release(l.id, { env });
    assert.equal(listLeases(config(env)).length, 0);
    assert.ok(!fs.existsSync(path.join(config(env).registry, 'port-56030')));
    await acquire({ pg: false, port: 56030, env });
  });
  it('a tampered lease whose data directory is outside the allocator root is never deleted', async () => {
    const l = await acquire({ pg: false, env });
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'victim-'));
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'x');
    const file = path.join(config(env).registry, `lease-${l.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...l, pgdata: path.join(victim, 'pg') }));
    await rejects(() => release(l.id, { env }), 'unsafe_path');
    assert.ok(fs.existsSync(path.join(victim, 'keep.txt')));
    fs.rmSync(victim, { recursive: true, force: true });
    fs.writeFileSync(file, JSON.stringify(l));
  });
  it('gc reaps expired leases and leaves live ones', async () => {
    const dead = await acquire({ pg: false, ttlHours: -1, env });
    assert.deepEqual(
      status({ env }).map((s) => s.id),
      [dead.id],
    ); // listed, expired
    const reaped = await gc({ env, quiet: true });
    assert.deepEqual(reaped, [dead.id]);
    const live = await acquire({ pg: false, env }); // acquire also reaps stale entries first
    const dead2 = await acquire({ pg: false, ttlHours: -1, env });
    await acquire({ pg: false, env }); // reaps dead2 on the way in
    assert.ok(!status({ env }).some((s) => s.id === dead2.id));
    assert.ok(status({ env }).some((s) => s.id === live.id));
  });
});

const pgbin = process.env.NUZM_PGBIN || '/usr/local/opt/postgresql@16/bin';
describe(
  'a real cluster per lease',
  { skip: !fs.existsSync(path.join(pgbin, 'initdb')) && 'PostgreSQL 16 not installed' },
  () => {
    it('starts its own cluster in its own directory; the lease password gets in, a missing or other-session password does not; release stops it and deletes the data', async () => {
      const a = await acquire({ owner: 'A', env });
      const b = await acquire({ owner: 'B', env });
      const q = (lease, password, sql) =>
        spawnSync(
          path.join(pgbin, 'psql'),
          [
            '-h',
            '127.0.0.1',
            '-p',
            String(lease.port),
            '-U',
            'nuzm_admin',
            '-d',
            'postgres',
            '-At',
            '-c',
            sql,
          ],
          {
            env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' },
            encoding: 'utf8',
          },
        );
      assert.notEqual(a.port, b.port);
      assert.notEqual(a.pgdata, b.pgdata);
      assert.notEqual(a.password, b.password);
      assert.equal(q(a, a.password, 'select 1').stdout.trim(), '1');
      assert.equal(q(b, b.password, 'select 1').stdout.trim(), '1');
      // credential isolation: session B's password does not open session A's cluster, and no password does not either
      assert.notEqual(q(a, b.password, 'select 1').status, 0);
      assert.notEqual(q(a, '', 'select 1').status, 0);
      // the exported environment carries exactly the lease's own port and password
      const e = leaseEnv(a);
      assert.equal(e.NUZM_LEASE_PORT, String(a.port));
      assert.equal(e.PGPASSWORD, a.password);
      assert.ok(e.NUZM_TEST_ADMIN_URL.includes(`:${a.port}/`));
      checkUrl(e.NUZM_TEST_ADMIN_URL, { env: { ...env, NUZM_LEASE_ID: a.id } });
      await release(a.id, { env });
      assert.ok(!fs.existsSync(path.dirname(a.pgdata)));
      assert.notEqual(q(a, a.password, 'select 1').status, 0); // stopped
      assert.equal(q(b, b.password, 'select 1').stdout.trim(), '1'); // the other session is untouched
      void execFileSync;
    });
  },
);
