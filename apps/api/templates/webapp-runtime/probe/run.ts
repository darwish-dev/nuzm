// PLATFORM-OWNED (Nuzm P3-S05): `npm run probe`. Runs INSIDE the qualified runtime (or any disposable environment the owner approved) and nowhere else.
//   1. starts an ephemeral PostgreSQL inside the workspace (probe/pg-sandbox.ts)
//   2. applies the app's migrations twice (forward-only and re-runnable)
//   3. starts the app exactly as production would (`node src/server.ts`) with a minimal, explicit environment: no platform variable is inherited
//   4. runs the probe suite over HTTP, prints ONE line `NUZM_PROBE_REPORT <json>` and writes probe-report.json
//   5. stops the app, stops and destroys the database, and reports that it did
// The exit code is 0 only when every required check passed.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.ts';
import { META } from '../src/meta.ts';
import { migrate } from '../src/migrate.ts';
import { createPool, PgStore } from '../src/pg-store.ts';
import { SAMPLES } from '../tests/fixtures.ts';
import { freePort, startEphemeralPg } from './pg-sandbox.ts';
import { runProbe } from './suite.ts';
import type { ProbeContext, ProbeResponse } from './suite.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'probe-' + randomBytes(12).toString('hex');
const SECRET = randomBytes(32).toString('hex');
const FORBIDDEN_ENV =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)|^(DATABASE|REDIS|VAULT|AWS|AZURE|GCP|GOOGLE|GITHUB|STRIPE|OPENAI|ANTHROPIC|NUZM)_|^PG(HOST|USER|PASSWORD|DATABASE|PORT|SERVICE)/i;

async function main(): Promise<number> {
  const t0 = Date.now();
  const log: string[] = [];
  const isolation: Record<string, unknown> = {
    inheritedEnvNames: Object.keys(process.env).filter((k) => FORBIDDEN_ENV.test(k)),
  };
  const db = await startEphemeralPg({ workDir: join(root, '.run') });
  let app: ReturnType<typeof spawn> | null = null;
  let report: unknown;
  let code: number;
  try {
    isolation['databaseHost'] = db.host;
    isolation['databaseRole'] = db.role;
    // 1. migrations: applied once, then a second run must apply nothing (re-runnable)
    const first = await migrate(db.url, { log: (l) => log.push(l) });
    const second = await migrate(db.url, { log: (l) => log.push(l) });
    isolation['migrationsApplied'] = first.length;
    isolation['migrationsReapplied'] = second.length;
    const pool = createPool(db.url);
    const probeDb = await pool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    isolation['roleSuperuser'] = probeDb.rows[0]?.rolsuper === true;
    isolation['roleBypassRls'] = probeDb.rows[0]?.rolbypassrls === true;
    const store = new PgStore(pool, META);
    const multi = META.auth?.tenancy === 'multi';
    const adminRole = Object.values(META.roles).find((r) => r.admin);
    if (!adminRole) throw new Error('the app has no administrator role');
    const provisionAdmin: ProbeContext['provisionAdmin'] = async (label) => {
      const email = 'probe.admin.' + label + '.' + randomUUID().slice(0, 8) + '@example.test';
      let tenantId: string | null = null;
      if (multi) {
        tenantId = randomUUID();
        await store.insertTenant({
          id: tenantId,
          name: 'Probe tenant ' + label,
          createdAt: new Date().toISOString(),
        });
      }
      await store.insertUser({
        id: randomUUID(),
        email,
        name: 'Probe administrator ' + label,
        role: adminRole.name,
        teamId: null,
        ...(multi ? { tenantId } : {}),
        locale: 'en',
        passwordHash: await hashPassword(PASSWORD),
        active: true,
        createdAt: new Date().toISOString(),
      });
      return { email, password: PASSWORD };
    };

    // 2. start the app as production does, with an explicit minimal environment
    const port = await freePort();
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: root,
      NODE_ENV: 'production',
      PORT: String(port),
      STORE: 'pg',
      DATABASE_URL: db.url,
      SESSION_SECRET: SECRET,
    };
    app = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'src/server.ts'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let appOut = '';
    app.stdout?.on('data', (d: Buffer) => (appOut += d.toString('utf8')));
    app.stderr?.on('data', (d: Buffer) => (appOut += d.toString('utf8')));
    let exited: number | null = null;
    app.on('exit', (c) => (exited = c ?? 1));
    const base = 'http://127.0.0.1:' + port;
    let up = false;
    for (let i = 0; i < 200 && exited === null; i++) {
      try {
        if ((await fetch(base + '/health')).status === 200) {
          up = true;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!up)
      throw new Error(
        'the app did not become healthy' +
          (exited !== null ? ' (exited with ' + exited + ')' : '') +
          ': ' +
          appOut.slice(-300),
      );

    // 3. the probe
    const transport = {
      async request(
        method: string,
        path: string,
        o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
      ): Promise<ProbeResponse> {
        const headers: Record<string, string> = { ...(o.headers ?? {}) };
        if (o.token) headers['authorization'] = 'Bearer ' + o.token;
        let body: string | undefined = o.raw;
        if (o.body !== undefined) {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(o.body);
        }
        // `host` and `origin` are forbidden request headers for fetch on some runtimes; the app reads them as given, so the cross-origin check is made over the same socket with node:http
        if (headers['origin'] !== undefined || headers['host'] !== undefined)
          return rawHttp(port, method, path, headers, body);
        const r = await fetch(base + path, { method, headers, body });
        const text = await r.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        const h: Record<string, string> = {};
        r.headers.forEach((v, k) => (h[k] = v));
        return { status: r.status, headers: h, body: parsed, text };
      },
    };
    const openapi = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));
    const result = await runProbe(transport, {
      meta: META as never,
      openapi,
      samples: SAMPLES,
      password: PASSWORD,
      provisionAdmin,
    });
    code = result.ok ? 0 : 1;
    report = result;
    await pool.end();
  } catch (e) {
    report = {
      schema: 'nuzm.app-probe/1',
      ok: false,
      fatal: e instanceof Error ? e.message.slice(0, 400) : 'error',
    };
    code = 1;
  } finally {
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (app.exitCode === null) app.kill('SIGKILL');
    }
    await db.stop();
    isolation['databaseDestroyed'] = !existsSync(db.dataDir);
  }
  const out = { report, isolation, migrationLog: log, durationMs: Date.now() - t0 };
  writeFileSync(join(root, 'probe-report.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('NUZM_PROBE_REPORT ' + JSON.stringify(out));
  return code;
}

import { request as httpRequest } from 'node:http';
function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = undefined;
          }
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h[k] = v;
          resolve({ status: res.statusCode ?? 0, headers: h, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

process.exit(await main());
