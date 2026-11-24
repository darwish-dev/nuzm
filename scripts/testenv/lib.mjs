// Central test-environment allocator (Master-owned). Dependency-free ESM so it runs under plain `node` (scripts, vitest global setup, node:test).
//
// WHY: parallel sessions on one workstation collided on database ports and one session ran `db:*` against the owner's dev cluster (:54329) through a silent
// default. This module makes that structurally impossible:
//   * every session ACQUIRES a lease: an atomically reserved port, its own PostgreSQL cluster in its own data directory under the allocator root, a random
//     per-lease password (scram-sha-256 on TCP and socket; clients pick it up from PGPASSWORD, which node-pg and psql honour), and a time-limited registry entry;
//   * every test run PREFLIGHTS its database URL (`checkUrl`): the URL is mandatory, must be loopback, must not be a protected port (the owner's dev cluster),
//     and must target the port of a live lease that belongs to THIS session (NUZM_LEASE_ID); there is no fallback;
//   * release / gc stop only clusters whose postmaster.pid matches the lease and delete only directories inside the allocator root;
//   * the number of concurrent leases is capped by CPU count and available memory.
// CI exception (explicit): CI=true plus NUZM_TEST_DB_POLICY=ci accepts a non-protected loopback port without a lease (service containers).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PROTECTED_PORTS = [54329, 54339, 5432, 5433]; // owner dev cluster, other dev clusters, system Postgres
export class TestEnvError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function config(env = process.env) {
  const root = path.resolve(
    env.NUZM_TESTENV_ROOT ||
      (process.platform === 'darwin'
        ? '/private/tmp/nuzm-testenv'
        : path.join(os.tmpdir(), 'nuzm-testenv')),
  );
  return {
    root,
    registry: path.join(root, 'registry'),
    leases: path.join(root, 'leases'),
    sockets: path.join(root, 's'),
    portMin: Number(env.NUZM_TESTENV_PORT_MIN || 54400),
    portMax: Number(env.NUZM_TESTENV_PORT_MAX || 54999),
    pgbin: env.NUZM_PGBIN || '/usr/local/opt/postgresql@16/bin',
    ttlHours: Number(env.NUZM_TESTENV_TTL_HOURS || 12),
    maxLeases: env.NUZM_TESTENV_MAX_LEASES ? Number(env.NUZM_TESTENV_MAX_LEASES) : undefined,
    protectedPorts: [
      ...PROTECTED_PORTS,
      ...String(env.NUZM_PROTECTED_PORTS || '')
        .split(',')
        .filter(Boolean)
        .map(Number),
    ],
  };
}

const now = () => Date.now();
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function inside(root, p) {
  const r = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
  const rr = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  return r === rr || r.startsWith(rr + path.sep);
}
function ensureDirs(c) {
  for (const d of [c.root, c.registry, c.leases, c.sockets])
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** Free memory in MB that a new Postgres/test process could use (macOS: free+inactive+speculative pages; Linux: MemAvailable). */
export function availableMemoryMb() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8' });
      const ps = Number(/page size of (\d+) bytes/.exec(out)?.[1] || 4096);
      const sum = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] || 0);
      return Math.floor(
        ((sum('Pages free') + sum('Pages inactive') + sum('Pages speculative')) * ps) / 1048576,
      );
    }
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    /* fall through */
  }
  return Math.floor(os.freemem() / 1048576);
}
/** Concurrent leases allowed: one per CPU, and one per ~1.2 GB of available memory, at least 1; NUZM_TESTENV_MAX_LEASES overrides. */
export function capacity(c = config(), memMb = availableMemoryMb(), cpus = os.cpus().length) {
  if (c.maxLeases !== undefined) return c.maxLeases;
  return Math.max(1, Math.min(cpus, Math.floor(memMb / 1200)));
}

export function listLeases(c = config()) {
  if (!isDir(c.registry)) return [];
  const out = [];
  for (const f of fs.readdirSync(c.registry)) {
    if (!f.startsWith('lease-') || !f.endsWith('.json')) continue;
    try {
      out.push(readJson(path.join(c.registry, f)));
    } catch {
      /* a half-written entry is ignored by readers and reaped by gc */
    }
  }
  return out;
}
export const isExpired = (lease, t = now()) => !lease.expiresAt || lease.expiresAt < t;

/** True when something accepts connections on 127.0.0.1:port. */
export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
}
/** True when the port can be bound on loopback (nothing listens, even on another interface family). */
export function portBindable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function reservePortDir(c, port) {
  try {
    fs.mkdirSync(path.join(c.registry, `port-${port}`), { mode: 0o700 }); // mkdir is atomic: exactly one caller wins
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
function releasePortDir(c, port) {
  try {
    fs.rmdirSync(path.join(c.registry, `port-${port}`));
  } catch {
    /* already gone */
  }
}

async function pickPort(c, requested) {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < c.portMin || requested > c.portMax)
      throw new TestEnvError(
        'port_out_of_range',
        `port ${requested} is outside the allocator range ${c.portMin}-${c.portMax}`,
      );
    if (c.protectedPorts.includes(requested))
      throw new TestEnvError('port_protected', `port ${requested} is protected`);
    if (!reservePortDir(c, requested))
      throw new TestEnvError(
        'port_reserved',
        `port ${requested} is already reserved by another lease`,
      );
    if (!(await portBindable(requested)) || (await portInUse(requested))) {
      releasePortDir(c, requested);
      throw new TestEnvError('port_busy', `port ${requested} is in use by another process`);
    }
    return requested;
  }
  const span = c.portMax - c.portMin + 1;
  const start = randomBytes(2).readUInt16BE() % span;
  for (let i = 0; i < span; i++) {
    const port = c.portMin + ((start + i) % span);
    if (c.protectedPorts.includes(port)) continue;
    if (!reservePortDir(c, port)) continue;
    if ((await portBindable(port)) && !(await portInUse(port))) return port;
    releasePortDir(c, port);
  }
  throw new TestEnvError('no_free_port', `no free port in ${c.portMin}-${c.portMax}`);
}

function pgEnv(c, lease) {
  return {
    ...process.env,
    LC_ALL: process.env.NUZM_LC_ALL || 'en_US.UTF-8',
    PGPASSWORD: lease.password,
  };
}
function postmasterInfo(pgdata) {
  try {
    const lines = fs.readFileSync(path.join(pgdata, 'postmaster.pid'), 'utf8').split('\n');
    return { pid: Number(lines[0]), dir: lines[1], port: Number(lines[3]) };
  } catch {
    return null;
  }
}
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** True only when the cluster running on lease.port really is the lease's own data directory (postmaster.pid agrees). */
export function ownsCluster(lease) {
  const pm = postmasterInfo(lease.pgdata);
  return (
    !!pm &&
    alive(pm.pid) &&
    pm.port === lease.port &&
    fs.existsSync(lease.pgdata) &&
    path.resolve(pm.dir) === path.resolve(lease.pgdata)
  );
}

export function leaseEnv(lease) {
  const base = `postgres://nuzm_admin@127.0.0.1:${lease.port}`;
  return {
    NUZM_LEASE_ID: lease.id,
    NUZM_LEASE_PORT: String(lease.port),
    NUZM_PGPORT: String(lease.port),
    E2E_PG_PORT: String(lease.port),
    PGPASSWORD: lease.password,
    DATABASE_ADMIN_URL: `${base}/nuzm_dev`,
    NUZM_TEST_ADMIN_URL: `${base}/postgres`,
    NUZM_FORBID_DEFAULT_DB: '1',
  };
}

/** Acquire a lease. `pg: false` reserves the port and registry entry without starting Postgres (unit tests, dry runs). */
export async function acquire({
  owner = 'session',
  pg = true,
  ttlHours,
  port,
  env = process.env,
} = {}) {
  const c = config(env);
  ensureDirs(c);
  await gc({ env, quiet: true });
  const active = listLeases(c).filter((l) => !isExpired(l));
  const cap = capacity(c);
  if (active.length >= cap)
    throw new TestEnvError(
      'capacity',
      `capacity reached: ${active.length}/${cap} leases (CPU/memory bound); release one with 'testenv release <id>' or wait`,
    );
  const chosen = await pickPort(c, port);
  const id = randomBytes(6).toString('hex');
  const dir = path.join(c.leases, id);
  const lease = {
    id,
    owner: String(owner).slice(0, 60),
    port: chosen,
    pgdata: path.join(dir, 'pg'),
    socketDir: path.join(c.sockets, id.slice(0, 8)),
    password: randomBytes(18).toString('base64url'),
    createdAt: now(),
    expiresAt: now() + (ttlHours ?? c.ttlHours) * 3600e3,
    pg,
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(lease.socketDir, { recursive: true, mode: 0o700 });
    if (pg) startCluster(c, lease);
    const envFile = path.join(dir, 'env.sh');
    fs.writeFileSync(
      envFile,
      Object.entries(leaseEnv(lease))
        .map(([k, v]) => `export ${k}='${v}'`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    lease.envFile = envFile;
    fs.writeFileSync(path.join(c.registry, `lease-${id}.json`), JSON.stringify(lease), {
      mode: 0o600,
    });
  } catch (e) {
    await destroy(c, lease, { force: true }).catch(() => {});
    throw e;
  }
  return lease;
}

function startCluster(c, lease) {
  const initdb = path.join(c.pgbin, 'initdb');
  const pgctl = path.join(c.pgbin, 'pg_ctl');
  if (!fs.existsSync(initdb))
    throw new TestEnvError('no_postgres', `no initdb in ${c.pgbin} (set NUZM_PGBIN)`);
  const pwfile = path.join(path.dirname(lease.pgdata), '.pw');
  fs.writeFileSync(pwfile, lease.password + '\n', { mode: 0o600 });
  try {
    execFileSync(
      initdb,
      [
        '-D',
        lease.pgdata,
        '-U',
        'nuzm_admin',
        '--pwfile',
        pwfile,
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '-E',
        'UTF8',
        '--locale=C',
      ],
      { env: pgEnv(c, lease), stdio: 'ignore' },
    );
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
  execFileSync(
    pgctl,
    [
      '-D',
      lease.pgdata,
      '-l',
      path.join(path.dirname(lease.pgdata), 'pg.log'),
      '-w',
      '-o',
      `-p ${lease.port} -k ${lease.socketDir} -c listen_addresses=127.0.0.1`,
      'start',
    ],
    { env: pgEnv(c, lease), stdio: 'ignore' },
  );
}

async function destroy(c, lease, { force = false } = {}) {
  const dir = path.dirname(lease.pgdata);
  if (!inside(c.leases, dir))
    throw new TestEnvError('unsafe_path', `refusing to delete ${dir}: outside the allocator root`);
  if (ownsCluster(lease)) {
    spawnSync(path.join(c.pgbin, 'pg_ctl'), ['-D', lease.pgdata, '-m', 'fast', '-w', 'stop'], {
      env: pgEnv(c, lease),
      stdio: 'ignore',
    });
  } else if (!force && postmasterInfo(lease.pgdata) && alive(postmasterInfo(lease.pgdata).pid)) {
    throw new TestEnvError(
      'not_owner',
      `a postmaster is running in ${lease.pgdata} but does not match the lease: not stopping it`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (lease.socketDir && inside(c.sockets, lease.socketDir))
    fs.rmSync(lease.socketDir, { recursive: true, force: true });
  releasePortDir(c, lease.port);
  fs.rmSync(path.join(c.registry, `lease-${lease.id}.json`), { force: true });
}

export async function release(id, { env = process.env } = {}) {
  const c = config(env);
  const lease = listLeases(c).find((l) => l.id === id || String(l.port) === String(id));
  if (!lease) throw new TestEnvError('no_such_lease', `no lease ${id}`);
  await destroy(c, lease);
  return lease;
}

/** Reap expired leases (never one that still has a running cluster with open client sessions unless forced). Also drops orphan port reservations. */
export async function gc({ env = process.env, quiet = false } = {}) {
  const c = config(env);
  if (!isDir(c.registry)) return [];
  const reaped = [];
  const leases = listLeases(c);
  for (const l of leases) {
    if (!isExpired(l)) continue;
    try {
      await destroy(c, l);
      reaped.push(l.id);
    } catch (e) {
      if (!quiet) console.error(`gc: ${l.id}: ${e.message}`);
    }
  }
  const live = new Set(listLeases(c).map((l) => l.port));
  for (const f of fs.readdirSync(c.registry)) {
    const m = /^port-(\d+)$/.exec(f);
    if (
      m &&
      !live.has(Number(m[1])) &&
      now() - fs.statSync(path.join(c.registry, f)).mtimeMs > 120e3
    )
      releasePortDir(c, Number(m[1]));
  }
  return reaped;
}

export function renew(id, hours, { env = process.env } = {}) {
  const c = config(env);
  const lease = listLeases(c).find((l) => l.id === id);
  if (!lease) throw new TestEnvError('no_such_lease', `no lease ${id}`);
  lease.expiresAt = now() + (hours ?? c.ttlHours) * 3600e3;
  fs.writeFileSync(path.join(c.registry, `lease-${id}.json`), JSON.stringify(lease), {
    mode: 0o600,
  });
  return lease;
}

export function status({ env = process.env } = {}) {
  const c = config(env);
  return listLeases(c).map((l) => ({
    id: l.id,
    owner: l.owner,
    port: l.port,
    expired: isExpired(l),
    clusterOwned: l.pg ? ownsCluster(l) : null,
    expiresInMin: Math.round((l.expiresAt - now()) / 60000),
  }));
}

/**
 * Preflight for a database URL used by an integration or E2E run. Returns the parsed lease (or null in the CI policy). Throws TestEnvError with a precise reason.
 * Rules: URL mandatory; loopback host; port not protected; the port must belong to a live, unexpired lease whose id equals NUZM_LEASE_ID.
 */
export function checkUrl(url, { env = process.env } = {}) {
  if (!url || !String(url).trim())
    throw new TestEnvError(
      'url_missing',
      'a database URL is mandatory: set NUZM_TEST_ADMIN_URL (there is no default database)',
    );
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TestEnvError('url_invalid', 'the database URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(u.protocol))
    throw new TestEnvError('url_invalid', 'the database URL must use the postgres:// scheme');
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname))
    throw new TestEnvError(
      'host_not_loopback',
      `host ${u.hostname} is not loopback: test databases are local`,
    );
  const port = Number(u.port || 5432);
  const c = config(env);
  if (c.protectedPorts.includes(port))
    throw new TestEnvError(
      'port_protected',
      `port ${port} is a protected development/system database: refused`,
    );
  if (env.CI === 'true' && env.NUZM_TEST_DB_POLICY === 'ci') return null;
  const leaseId = env.NUZM_LEASE_ID;
  if (!leaseId)
    throw new TestEnvError(
      'no_lease',
      'no test environment lease: run `node scripts/testenv/testenv.mjs acquire` and `source` its env file',
    );
  const lease = listLeases(c).find((l) => l.port === port);
  if (!lease)
    throw new TestEnvError('port_not_leased', `port ${port} is not an allocated test environment`);
  if (lease.id !== leaseId)
    throw new TestEnvError(
      'foreign_lease',
      `port ${port} belongs to lease ${lease.id} (${lease.owner}), not to this session's lease ${leaseId}`,
    );
  if (isExpired(lease)) throw new TestEnvError('lease_expired', `lease ${lease.id} has expired`);
  if (lease.pg && !ownsCluster(lease))
    throw new TestEnvError(
      'cluster_not_running',
      `the cluster of lease ${lease.id} is not running (postmaster.pid does not match)`,
    );
  return lease;
}
