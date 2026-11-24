import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Runs the webapp-runtime template's OWN unit tests (`templates/webapp-runtime/__tests__`) with the Node test runner. These test the template code (engine, auth, stores, probe suite) against a
 * hand-written fixture with the in-memory store: no generated application is built or executed, and no database or network is used.
 */
const dir = join(__dirname, '../../../../../templates/webapp-runtime');
describe('webapp-runtime template unit tests', () => {
  it('pass under node --test (type stripping)', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--test',
        '--test-concurrency=1',
        '__tests__/engine.test.ts',
        '__tests__/probe.test.ts',
        '__tests__/pg-sandbox.test.ts',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        timeout: 280_000,
      },
    );
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    expect(out, out.slice(-2500)).toMatch(/# fail 0/);
    expect(out).toMatch(/# pass [1-9]\d*/);
    expect(r.status).toBe(0);
  }, 300_000);
});
