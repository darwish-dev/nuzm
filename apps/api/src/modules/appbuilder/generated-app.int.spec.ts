import 'reflect-metadata';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SAMPLE_SPEC } from './internal/fixtures/sample-spec';
import { generateProject } from './internal/gen/project';
import { materialize } from './internal/testing/materialize';

const ADMIN =
  process.env.NUZM_TEST_ADMIN_URL ??
  (() => {
    throw new Error(
      'NUZM_TEST_ADMIN_URL is mandatory: acquire an isolated test environment first (node scripts/testenv/testenv.mjs acquire); there is no default database',
    );
  })();
const TSC = join(__dirname, '../../../../../node_modules/typescript/bin/tsc');
let dir = '';
let cleanup = () => undefined as void;
let dbName = '';
let dbUrl = '';

beforeAll(async () => {
  const m = materialize(generateProject(SAMPLE_SPEC).files);
  dir = m.dir;
  cleanup = m.cleanup;
  dbName = `nuzm_gen_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  dbUrl = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
}, 60_000);
afterAll(async () => {
  cleanup();
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

const node = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    timeout: 240_000,
  });

describe('the generated web app is a real, working project (S43/S44)', () => {
  it('type-checks under strict TypeScript with erasable syntax only (so Node can run it without a build)', () => {
    const r = node([TSC, '--noEmit', '-p', 'tsconfig.json']);
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 240_000);

  it('its OpenAPI document passes the same Spectral ruleset as the Nuzm API (fail on warnings)', () => {
    const repo = join(__dirname, '../../../../..');
    const r = spawnSync(
      join(repo, 'node_modules/.bin/spectral'),
      [
        'lint',
        join(dir, 'openapi.json'),
        '--ruleset',
        join(repo, 'spec/openapi/.spectral.yaml'),
        '--fail-severity=warn',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(r.stdout + r.stderr).not.toMatch(/error|warning/i);
    expect(r.status).toBe(0);
  }, 120_000);

  it('builds to JavaScript with the compiler (tsconfig.build.json)', () => {
    const r = node([TSC, '-p', 'tsconfig.build.json', '--outDir', 'dist']);
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 240_000);

  it('its own tests pass on the in-memory store', () => {
    const r = node([
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=1',
      'tests/*.test.ts',
    ]);
    expect(
      r.stderr.replace(
        /\(node:\d+\) ExperimentalWarning[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g,
        '',
      ),
    ).toBe('');
    expect(r.stdout).toMatch(/# fail 0/);
    expect(Number(/# pass (\d+)/.exec(r.stdout)?.[1])).toBeGreaterThan(15);
  }, 240_000);

  it('the migration applies, reverses and re-applies on PostgreSQL; down leaves no table behind', async () => {
    const c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
    const fs = await import('node:fs');
    const up = fs.readFileSync(join(dir, 'db/migrations/0001_init.sql'), 'utf8');
    const down = fs.readFileSync(join(dir, 'db/migrations/0001_init.down.sql'), 'utf8');
    const tables = async () =>
      (
        await c.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
        )
      ).rows.map((r) => r.table_name as string);
    await c.query(up);
    expect(await tables()).toEqual(['app_users', 'audit_log', 'projects', 'tasks']);
    await c.query(down);
    expect(await tables()).toEqual([]);
    await c.query(up);
    // append-only audit trail
    await c.query(
      `INSERT INTO audit_log (id, entity, record_id, action) VALUES (gen_random_uuid(), 'Task', gen_random_uuid(), 'create')`,
    );
    await expect(c.query(`UPDATE audit_log SET action = 'delete'`)).rejects.toThrow(/append-only/);
    await c.end();
  }, 60_000);

  it('the same tests pass on the PostgreSQL store (parity of the two stores: scope, search, sort, unique, references, audit)', () => {
    const r = node(
      ['--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/*.test.ts'],
      { TEST_DATABASE_URL: dbUrl },
    );
    expect(r.stdout).toMatch(/# fail 0/);
    expect(Number(/# pass (\d+)/.exec(r.stdout)?.[1])).toBeGreaterThan(15);
  }, 240_000);

  it('migrate.ts applies the migrations once and `down` reverts them', () => {
    const c = execFileSync(
      process.execPath,
      [
        '-e',
        `const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await c.end()})()`,
      ],
      {
        cwd: join(__dirname, '../../..'),
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: dbUrl },
      },
    );
    void c;
    const a = node(['--experimental-strip-types', 'src/migrate.ts'], { DATABASE_URL: dbUrl });
    expect(a.stdout).toMatch(/applied 0001_init.sql/);
    const b = node(['--experimental-strip-types', 'src/migrate.ts'], { DATABASE_URL: dbUrl });
    expect(b.stdout).not.toMatch(/applied/);
    const d = node(['--experimental-strip-types', 'src/migrate.ts', 'down', '1'], {
      DATABASE_URL: dbUrl,
    });
    expect(d.stdout).toMatch(/reverted 0001_init.sql/);
  }, 120_000);
});
