// PLATFORM-OWNED (Nuzm P3-S05): an EPHEMERAL PostgreSQL that lives entirely inside the workspace of one run.
//  - the data directory, the socket directory and the password file are created under the workspace and are destroyed with it (and by `stop()`);
//  - the cluster listens on 127.0.0.1 only, on a free port chosen at run time (the runtime profile has no other network anyway);
//  - the credentials are random and generated here: they never come from the platform, are never written to the environment of the app and never leave the workspace;
//  - the application connects as a NON-superuser that owns its database, so the row-level-security policies apply (superusers bypass them);
//  - nothing here talks to any other database.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface EphemeralPg {
  /** connection string of the application's role; valid only inside this run */
  url: string;
  host: string;
  port: number;
  database: string;
  role: string;
  dataDir: string;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function exec(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.on('error', (e) => resolve({ code: 127, out: String(e.message) }));
    p.on('close', (code) => resolve({ code: code ?? 1, out: out.slice(-2000) }));
  });
}

const BIN_CANDIDATES = [
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/local/bin',
  '/usr/bin',
];
/** Finds a directory that holds `initdb`, `pg_ctl` and `postgres`: an explicit `binDir`, then the PATH, then the well-known package locations. */
export function findPgBin(binDir?: string, path = process.env['PATH'] ?? ''): string | null {
  const dirs = [...(binDir ? [binDir] : []), ...path.split(':').filter(Boolean), ...BIN_CANDIDATES];
  for (const d of dirs)
    if (
      existsSync(join(d, 'initdb')) &&
      existsSync(join(d, 'pg_ctl')) &&
      existsSync(join(d, 'postgres'))
    )
      return d;
  return null;
}

export async function startEphemeralPg(o: {
  workDir: string;
  binDir?: string;
  database?: string;
}): Promise<EphemeralPg> {
  const bin = findPgBin(o.binDir);
  if (!bin)
    throw new Error(
      'PostgreSQL server binaries (initdb, pg_ctl, postgres) are not available in this environment',
    );
  mkdirSync(o.workDir, { recursive: true });
  const root = mkdtempSync(join(o.workDir, 'pg-'));
  const dataDir = join(root, 'data');
  const sockDir = join(root, 'sock');
  mkdirSync(sockDir, { mode: 0o700 });
  const database = o.database ?? 'app';
  const adminRole = 'nuzm_admin';
  const appRole = 'app_owner';
  const adminPassword = randomBytes(24).toString('hex');
  const appPassword = randomBytes(24).toString('hex');
  const pwfile = join(root, 'admin.pw');
  writeFileSync(pwfile, adminPassword, { mode: 0o600 });
  const env = { PATH: bin + ':/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  const port = await freePort();
  let started = false;
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const init = await exec(
      join(bin, 'initdb'),
      [
        '-D',
        dataDir,
        '-U',
        adminRole,
        '--pwfile=' + pwfile,
        '--auth=scram-sha-256',
        '-E',
        'UTF8',
        '--no-locale',
        '--no-sync',
      ],
      env,
    );
    if (init.code !== 0) throw new Error('initdb failed: ' + init.out.slice(-300));
    rmSync(pwfile, { force: true }); // the admin password only has to exist while the cluster is created and the two roles are set up
    const opts = [
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'port=' + port,
      '-c',
      'unix_socket_directories=' + sockDir,
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'max_connections=30',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'log_min_messages=warning',
    ].join(' ');
    const start = await exec(
      join(bin, 'pg_ctl'),
      ['-D', dataDir, '-o', opts, '-l', join(root, 'pg.log'), '-w', '-t', '60', 'start'],
      env,
    );
    if (start.code !== 0) throw new Error('pg_ctl start failed: ' + start.out.slice(-300));
    started = true;
    // role setup runs over the unix socket as the cluster's own admin (trust is not configured: scram with the password that only this function knows)
    const pg = (await import('pg')).default;
    const admin = new pg.Client({
      host: '127.0.0.1',
      port,
      user: adminRole,
      password: adminPassword,
      database: 'postgres',
    });
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${appPassword}'`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${appRole}`);
      await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      // the app role may connect to its own database only (not to the maintenance databases, where it could list the cluster)
      await admin.query('REVOKE ALL ON DATABASE postgres FROM PUBLIC');
      await admin.query('REVOKE ALL ON DATABASE template1 FROM PUBLIC');
    } finally {
      await admin.end();
    }
    // assembled with the URL class: no connection string with a credential is ever written as a literal
    const conn = new URL('postgres://127.0.0.1');
    conn.username = appRole;
    conn.password = appPassword;
    conn.port = String(port);
    conn.pathname = '/' + database;
    return {
      url: conn.toString(),
      host: '127.0.0.1',
      port,
      database,
      role: appRole,
      dataDir,
      async stop() {
        if (started) {
          await exec(
            join(bin, 'pg_ctl'),
            ['-D', dataDir, '-m', 'immediate', '-w', '-t', '30', 'stop'],
            env,
          );
          started = false;
        }
        cleanup();
      },
    };
  } catch (e) {
    if (started)
      await exec(
        join(bin, 'pg_ctl'),
        ['-D', dataDir, '-m', 'immediate', '-w', '-t', '30', 'stop'],
        env,
      );
    cleanup();
    throw e;
  }
}
