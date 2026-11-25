import { executionGateway as eg } from '@nuzm/domain';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- QA white-box test of a private development runtime that has no public export
import { LocalDevSandboxRuntime } from '../modules/appbuilder/internal/sandbox/local-dev-runtime';

/**
 * Session 07 (QA) - the CONTROL PLANE side of the local development sandbox runner (`isolation: 'none'`, dev only; never counted as isolation evidence): what happens when
 * code that ran in the sandbox leaves a symbolic link behind and the platform later reads or writes files of that sandbox on its own behalf (a confused-deputy path).
 * NOTHING IS EXECUTED: the "attacker artefact" (a symlink) is created with the file system directly in the runner's temporary directory; no child process is started.
 * DEFECT-5 (owner: Session 04) is fixed on the integration branch: the two symlink tests are ordinary tests now (the read one accepts a refusal).
 */
const OUTSIDE = mkdtempSync(join(tmpdir(), 'qa-outside-'));
const CANARY = 'QA-OUTSIDE-CANARY-3b7e91c2d4a5f608';
const SECRET_FILE = join(OUTSIDE, 'host-secret.txt');
let rt: LocalDevSandboxRuntime;
const handles: string[] = [];
const dirOf = (h: string) => (rt as unknown as { dirs: Map<string, string> }).dirs.get(h)!;

beforeAll(() => {
  process.env.SANDBOX_LOCAL_DEV = 'true';
  process.env.NUZM_LOCAL_DEV_EXEC = '1';
  writeFileSync(SECRET_FILE, CANARY);
  rt = new LocalDevSandboxRuntime();
});
afterEach(async () => {
  for (const h of handles.splice(0)) await rt.destroy(h);
});
afterAll(() => {
  rmSync(OUTSIDE, { recursive: true, force: true });
  delete process.env.SANDBOX_LOCAL_DEV;
});
const fresh = async () => {
  const h = await rt.create({ origin: eg.templateOrigin('qa-fixture') } as never);
  handles.push(h);
  return h;
};

describe('QA local-dev sandbox runner: control-plane file access', () => {
  it('is labelled not isolated and is refused without the explicit development switch', () => {
    expect(rt.isolation).toBe('none');
    const was = process.env.SANDBOX_LOCAL_DEV;
    try {
      delete process.env.SANDBOX_LOCAL_DEV;
      expect(() => new LocalDevSandboxRuntime()).toThrow(/disabled/);
      process.env.SANDBOX_LOCAL_DEV = 'true';
      const prodEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      expect(() => new LocalDevSandboxRuntime()).toThrow(/disabled/);
      process.env.NODE_ENV = prodEnv;
    } finally {
      process.env.SANDBOX_LOCAL_DEV = was;
    }
  });

  it('refuses traversal, absolute and encoded paths on write and read', async () => {
    const h = await fresh();
    for (const p of [
      '../x',
      '/etc/x',
      'a/../../x',
      'a%2e%2e/x',
      '.git/config',
      '.ssh/id',
      'node_modules/x',
    ]) {
      await expect(rt.writeFiles(h, new Map([[p, 'x']])), p).rejects.toThrow();
      await expect(rt.readFiles(h, [p]), p).rejects.toThrow();
    }
  });

  it('listing the whole sandbox never follows a symlink out of it', async () => {
    const h = await fresh();
    symlinkSync(SECRET_FILE, join(dirOf(h), 'link.txt'));
    const all = await rt.readFiles(h);
    expect([...all.values()].join('\n')).not.toContain(CANARY);
  });

  it('DEFECT-5 (fixed): reading a NAMED path never follows a symlink out of the sandbox', async () => {
    const h = await fresh();
    symlinkSync(SECRET_FILE, join(dirOf(h), 'link.txt'));
    // the fix refuses with symlink_in_path; returning nothing would be as good. What must never happen is the canary being disclosed.
    const got = await rt.readFiles(h, ['link.txt']).catch((e: Error) => {
      expect(e.message).toMatch(/symlink/);
      return new Map<string, string>();
    });
    expect([...got.values()].join('\n')).not.toContain(CANARY);
  });

  it('DEFECT-5 (fixed): writing through a symlinked directory never lands outside the sandbox', async () => {
    const h = await fresh();
    symlinkSync(OUTSIDE, join(dirOf(h), 'out'), 'dir');
    await rt
      .writeFiles(h, new Map([['out/planted.txt', 'platform-written']]))
      .catch(() => undefined);
    expect(existsSync(join(OUTSIDE, 'planted.txt'))).toBe(false);
  });

  it('control: an ordinary write and read round-trips (so the failures above are about symlinks only)', async () => {
    const h = await fresh();
    await rt.writeFiles(h, new Map([['src/a.txt', 'hello']]));
    expect(readFileSync(join(dirOf(h), 'src/a.txt'), 'utf8')).toBe('hello');
    expect((await rt.readFiles(h, ['src/a.txt'])).get('src/a.txt')).toBe('hello');
  });
});
