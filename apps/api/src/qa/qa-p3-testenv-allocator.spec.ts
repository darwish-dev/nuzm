import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * P3-S08: INDEPENDENT black-box verification of the Master's test-environment allocator (`scripts/testenv/*`, commit edce169c on integration/ai-engine). It drives the real CLI
 * (`testenv.mjs`) and the real guard (`guard.mjs`) as child processes, in a throw-away allocator root (`NUZM_TESTENV_ROOT`), with `--no-pg` leases: no PostgreSQL cluster is started,
 * no port is bound, no real database is contacted. Until the allocator is in this tree (the Phase 3 branches get it when they merge integration/ai-engine) the suite is SKIPPED;
 * `P3_S08_TESTENV_DIR` points it at an extracted copy for a pre-merge proving run.
 *
 * Guarantees checked: (1) two leases never share a port and both lie in the allocated range; (2) asking for a taken, protected or system port is refused; (3) the preflight refuses a
 * missing URL, a bad scheme, a non-loopback host, the protected ports (owner dev cluster :54329, 54339, 5432, 5433, and the default port), a port that is no lease, ANOTHER session's
 * lease, an expired lease, and a missing lease id; (4) the guard also refuses a stray DATABASE_URL / DATABASE_ADMIN_URL that points at a foreign or protected database;
 * (5) every source that still carries the old development default (:54329) refuses it inside a lease; and DEFECT-19: the default is still reachable outside a lease (the very case of the incident that motivated the allocator).
 */
// P3_S08_TESTENV_TREE: a directory laid out like the repository (pre-merge proving run); P3_S08_TESTENV_DIR overrides only the allocator folder
const TREE = process.env.P3_S08_TESTENV_TREE ?? join(process.cwd(), '../..');
const DIR = process.env.P3_S08_TESTENV_DIR ?? join(TREE, 'scripts/testenv');
const available = existsSync(join(DIR, 'testenv.mjs'));
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'p3s08-testenv-'));
  roots.push(r);
  return r;
};
const baseEnv = (root: string, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NUZM_TESTENV_ROOT: root,
  NUZM_TESTENV_MAX_LEASES: '8',
  ...extra,
});
const cli = (root: string, args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync('node', [join(DIR, 'testenv.mjs'), ...args], {
    env: baseEnv(root, extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
interface Lease {
  id: string;
  port: number;
  owner: string;
  envFile: string;
}
const acquire = (root: string, owner: string, extra: string[] = []): Lease => {
  const r = cli(root, ['acquire', '--no-pg', '--owner', owner, ...extra]);
  expect(r.code, r.out).toBe(0);
  const file = readdirSync(join(root, 'registry')).filter((f) => f.startsWith('lease-'));
  const all = file.map((f) => JSON.parse(readFileSync(join(root, 'registry', f), 'utf8')) as Lease);
  return all.find((l) => l.owner === owner)!;
};
/** A port inside the allocator range (default 54400-54999) that no lease in `root` holds: leases get random ports from that range, so a fixed "free" port collides now and then. */
const unleasedPort = (root: string): number => {
  const dir = join(root, 'registry');
  const taken = new Set(
    (existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.startsWith('lease-'))
      .map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as Lease).port),
  );
  for (let p = 54777; p <= 54999; p++) if (!taken.has(p)) return p;
  throw new Error('no unleased port left in the allocator range');
};
const url = (port: number, host = '127.0.0.1') => `postgres://nuzm_admin@${host}:${port}/nuzm_test`;
const guard = (root: string, env: Record<string, string>) => {
  const code = `import('${join(DIR, 'guard.mjs').replace(/\\/g, '/')}').then((m)=>{try{m.assertTestDatabase();console.log('OK')}catch(e){console.log('REFUSED '+(e.code||'')+' '+e.message)}})`;
  const r = spawnSync('node', ['--input-type=commonjs', '-e', code], {
    env: baseEnv(root, env),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${r.stdout}${r.stderr}`;
};

describe.skipIf(!available)(
  'test-environment allocator: independent verification (skipped until the allocator is in the tree)',
  () => {
    const root = newRoot();
    // the describe body runs at collection time even when the suite is skipped: lease only when the allocator exists
    const a = available ? acquire(root, 'session-a') : (undefined as unknown as Lease);
    const b = available ? acquire(root, 'session-b') : (undefined as unknown as Lease);
    const envA = { NUZM_LEASE_ID: a?.id ?? '' };

    it('leases get distinct ports inside the allocated range and an env file that names the lease, the URL and the isolation flag', () => {
      expect(a.port).not.toBe(b.port);
      for (const l of [a, b]) {
        expect(l.port).toBeGreaterThanOrEqual(54400);
        expect(l.port).toBeLessThanOrEqual(54999);
        const env = readFileSync(l.envFile, 'utf8');
        expect(env).toContain(`NUZM_LEASE_ID='${l.id}'`);
        expect(env).toContain(`${l.port}`);
        expect(env).toMatch(/NUZM_TEST_ADMIN_URL=/);
        expect(env).toMatch(/NUZM_FORBID_DEFAULT_DB='1'/);
      }
    });
    it('twenty parallel acquisitions never collide on a port', async () => {
      const r2 = newRoot();
      const procs = Array.from(
        { length: 12 },
        (_, i) =>
          new Promise<string>((res) => {
            const p = spawnSync(
              'node',
              [join(DIR, 'testenv.mjs'), 'acquire', '--no-pg', '--owner', `p${i}`],
              { env: baseEnv(r2, { NUZM_TESTENV_MAX_LEASES: '40' }), encoding: 'utf8' },
            );
            res(`${p.status}`);
          }),
      );
      await Promise.all(procs);
      const ports = readdirSync(join(r2, 'registry'))
        .filter((f) => f.startsWith('lease-'))
        .map((f) => (JSON.parse(readFileSync(join(r2, 'registry', f), 'utf8')) as Lease).port);
      expect(new Set(ports).size).toBe(ports.length);
      expect(ports.length).toBeGreaterThan(0);
    });
    it('asking for a taken port, a protected port or a system port is refused (exit 3, a named code)', () => {
      expect(cli(root, ['acquire', '--no-pg', '--owner', 'x', '--port', String(a.port)]).code).toBe(
        3,
      );
      for (const p of ['54329', '54339', '5432', '5433']) {
        const r = cli(root, ['acquire', '--no-pg', '--owner', 'x', '--port', p]);
        expect(r.code, `${p}: ${r.out}`).toBe(3);
        expect(r.out).toMatch(/REFUSED \((port_protected|port_out_of_range|port_range)/);
      }
    });
    it('capacity is enforced: with a cap of 2 a third lease is refused', () => {
      const r3 = newRoot();
      expect(
        cli(r3, ['acquire', '--no-pg', '--owner', 'one'], { NUZM_TESTENV_MAX_LEASES: '2' }).code,
      ).toBe(0);
      expect(
        cli(r3, ['acquire', '--no-pg', '--owner', 'two'], { NUZM_TESTENV_MAX_LEASES: '2' }).code,
      ).toBe(0);
      const third = cli(r3, ['acquire', '--no-pg', '--owner', 'three'], {
        NUZM_TESTENV_MAX_LEASES: '2',
      });
      expect(third.code).toBe(3);
      expect(third.out).toContain('capacity');
    });
    it("preflight accepts exactly this session's own lease URL", () => {
      const r = cli(root, ['check-url', url(a.port)], envA);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`lease ${a.id}`);
      expect(cli(root, ['check-url', url(a.port, 'localhost')], envA).code).toBe(0);
    });
    it("preflight refuses ANOTHER session's lease (foreign_lease), whoever tries", () => {
      const r = cli(root, ['check-url', url(b.port)], envA);
      expect(r.code).toBe(3);
      expect(r.out).toContain('foreign_lease');
      expect(cli(root, ['check-url', url(a.port)], { NUZM_LEASE_ID: b.id }).out).toContain(
        'foreign_lease',
      );
    });
    it('preflight refuses every non-lease target: missing URL, bad scheme, non-loopback, protected ports, default port, an unleased port, no lease id', () => {
      const cases: [string | undefined, string, Record<string, string>][] = [
        [undefined, 'url_missing', envA],
        ['', 'url_missing', envA],
        ['mysql://127.0.0.1:54400/x', 'url_invalid', envA],
        ['not a url', 'url_invalid', envA],
        [url(a.port, '10.0.0.5'), 'host_not_loopback', envA],
        [url(a.port, '0.0.0.0'), 'host_not_loopback', envA],
        [url(a.port, 'db.example.test'), 'host_not_loopback', envA],
        [url(54329), 'port_protected', envA],
        [url(54339), 'port_protected', envA],
        [url(5433), 'port_protected', envA],
        ['postgres://nuzm_admin@127.0.0.1/nuzm_test', 'port_protected', envA], // the default port 5432
        ['postgres://nuzm_admin@127.0.0.1:054329/nuzm_test', 'port_protected', envA], // leading zero
        [url(unleasedPort(root)), 'port_not_leased', envA],
        [url(54341), 'port_protected', envA], // the Master's own dev database port (legacy session range 54330-54369, protected since the DEFECT-19 fix)
        [url(54330), 'port_protected', envA],
        [url(54369), 'port_protected', envA],
        [url(54370), 'port_not_leased', envA], // just outside the legacy range: refused only because it is no lease
        [url(a.port), 'no_lease', {}],
      ];
      for (const [u, code, env] of cases) {
        const r = cli(root, ['check-url', ...(u === undefined ? [] : [u])], env);
        expect(r.code, `${u}: ${r.out}`).toBe(3);
        expect(r.out, `${u}`).toContain(code);
      }
    });
    it('an expired lease is refused', () => {
      const r4 = newRoot();
      const l = acquire(r4, 'old');
      const f = join(r4, 'registry', `lease-${l.id}.json`);
      const j = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      j.expiresAt = Date.now() - 60_000;
      writeFileSync(f, JSON.stringify(j));
      const r = cli(r4, ['check-url', url(l.port)], { NUZM_LEASE_ID: l.id });
      expect(r.code).toBe(3);
      expect(r.out).toContain('lease_expired');
    });
    it('the guard (vitest global setup) refuses a missing URL and a stray DATABASE_URL / DATABASE_ADMIN_URL on a protected or foreign database, and accepts the clean case', () => {
      expect(guard(root, envA)).toContain('REFUSED url_missing');
      const ok = { ...envA, NUZM_TEST_ADMIN_URL: url(a.port) };
      expect(guard(root, ok)).toContain('OK');
      expect(guard(root, { ...ok, DATABASE_URL: url(54329) })).toMatch(
        /REFUSED port_protected.*DATABASE_URL/,
      );
      expect(guard(root, { ...ok, DATABASE_ADMIN_URL: url(b.port) })).toMatch(
        /REFUSED foreign_lease.*DATABASE_ADMIN_URL/,
      );
      expect(guard(root, { ...ok, WORKER_DATABASE_URL: url(54329) })).toMatch(
        /REFUSED port_protected/,
      );
      expect(guard(root, { NUZM_LEASE_ID: a.id, NUZM_TEST_ADMIN_URL: url(54329) })).toMatch(
        /REFUSED port_protected/,
      );
    });
    it('release deletes only this lease and refuses a path-like id', () => {
      const r5 = newRoot();
      const x = acquire(r5, 'x');
      const y = acquire(r5, 'y');
      for (const bad of ['../..', '..', '/', x.id + '/../' + y.id, '']) {
        const r = cli(r5, ['release', bad]);
        expect(r.code, `${JSON.stringify(bad)}: ${r.out}`).toBe(3);
      }
      expect(existsSync(join(r5, 'leases', y.id))).toBe(true);
      expect(cli(r5, ['release', x.id]).code).toBe(0);
      expect(existsSync(join(r5, 'leases', x.id))).toBe(false);
      expect(existsSync(join(r5, 'leases', y.id))).toBe(true);
    });
    // O-18 (fixed by the Master with the DEFECT-19 fix): the explicit CI policy (CI=true + NUZM_TEST_DB_POLICY=ci, for a service container without a lease) must not reach any registered
    // lease, nor the legacy session ports, nor apply inside a leased shell; it still accepts an ordinary unleased loopback port.
    it('O-18 (fixed): the CI policy refuses a registered lease, the legacy session ports and protected ports, does not apply inside a leased shell, and accepts only an unleased port', () => {
      const ci = { CI: 'true', NUZM_TEST_DB_POLICY: 'ci' };
      expect(cli(root, ['check-url', url(b.port)], ci).out).toContain('foreign_lease'); // another session's registered lease
      expect(cli(root, ['check-url', url(a.port)], ci).code).toBe(3);
      expect(cli(root, ['check-url', url(54341)], ci).out).toContain('port_protected');
      expect(cli(root, ['check-url', url(54329)], ci).code).toBe(3);
      const unleased = unleasedPort(root);
      expect(cli(root, ['check-url', url(unleased)], { ...ci, ...envA }).code).toBe(3); // inside a leased shell the CI policy does not apply
      const free = cli(root, ['check-url', url(unleased)], ci);
      expect(free.code, free.out).toBe(0);
      expect(free.out).toContain('CI policy');
      expect(cli(root, ['check-url', url(unleased)], { CI: 'true' }).code).toBe(3); // CI alone is not the policy
    });
    // ---- (5) no default database: static review of the sources that name the owner's development cluster
    const FALLBACK_FILES = [
      'packages/db/src/cli.ts',
      'apps/api/src/dev/dev-stack.ts',
      'apps/api/src/dev/grant-ai-credits.ts',
      'apps/api/src/dev/set-password.ts',
    ];
    const text = (f: string) => readFileSync(join(TREE, f), 'utf8');
    it('inside a lease (NUZM_FORBID_DEFAULT_DB=1) every source that names :54329 as a default refuses to use it', () => {
      for (const f of FALLBACK_FILES) {
        const t = text(f);
        expect(t, f).toContain('54329');
        expect(t, `${f} must refuse the default inside a lease`).toContain(
          "NUZM_FORBID_DEFAULT_DB === '1'",
        );
      }
    });
    it('the test infrastructure itself has no default database: the platform harness and the E2E preparation script name no :54329', () => {
      expect(text('packages/platform/src/testing/harness.ts')).not.toContain('54329');
      expect(text('e2e/prepare-db.mjs')).not.toContain('54329');
    });
    // DEFECT-19 (FIXED on integration/ai-engine after edce169c: the default needs the owner's explicit NUZM_ALLOW_OWNER_DEV_DB=1): the protection above exists ONLY after `source scripts/session-env.sh` has exported NUZM_FORBID_DEFAULT_DB=1. A session shell that never sourced it (the incident
    // that motivated the allocator: `pnpm db:migrate` with the default URL) still falls back to the owner's :54329. The secure expectation: the default needs an explicit opt-in
    // (set in the owner's own profile) or is refused in a session worktree; it must not be the behaviour of a shell that merely forgot to source a file.
    it('DEFECT-19 (fixed by the Master): the default :54329 fallback is not reachable by a session shell that has not sourced session-env.sh', () => {
      for (const f of FALLBACK_FILES) {
        const guardedWithoutLease =
          /NUZM_ALLOW_OWNER_DEV_DB|\.claude\/worktrees|NUZM_SESSION\b/.test(text(f));
        expect(guardedWithoutLease, `${f}: the default is reachable without a lease`).toBe(true);
      }
    });
  },
);
