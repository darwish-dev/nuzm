import { executionGateway as eg } from '@nuzm/domain';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfinementError, confinedPath } from './confine';
import { LocalDevSandboxRuntime } from './local-dev-runtime';
import { RuntimeQuotaError } from './runtime';

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nuzm-confine-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'host-secret.txt'), 'NZCANARY-host-secret');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const refuses = (fn: () => unknown, reason: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfinementError);
    expect((e as ConfinementError).reason).toBe(reason);
    return;
  }
  throw new Error('expected a ConfinementError');
};

describe('confinedPath', () => {
  it('allows ordinary files, nested not-yet-existing paths and directories', () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'x');
    expect(confinedPath(root, 'src/a.ts', 'read')).toBe(join(root, 'src/a.ts'));
    expect(confinedPath(root, 'src/new/deep/b.ts', 'write')).toBe(join(root, 'src/new/deep/b.ts'));
    expect(confinedPath(root, 'src', 'dir')).toBe(join(root, 'src'));
  });
  it('refuses a symlink leaf (SYM-READ) and a symlinked directory (SYM-WRITE)', () => {
    symlinkSync(join(outside, 'host-secret.txt'), join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'out'));
    refuses(() => confinedPath(root, 'link.txt', 'read'), 'symlink_in_path');
    refuses(() => confinedPath(root, 'out/planted.txt', 'write'), 'symlink_in_path');
    refuses(() => confinedPath(root, 'out', 'dir'), 'symlink_in_path');
  });
  it('refuses a dangling symlink and a symlink to a parent', () => {
    symlinkSync(join(outside, 'nope'), join(root, 'dangling'));
    symlinkSync('..', join(root, 'up'));
    refuses(() => confinedPath(root, 'dangling', 'write'), 'symlink_in_path');
    refuses(() => confinedPath(root, 'up/outside/x', 'write'), 'symlink_in_path');
  });
  it('refuses a hard link to an outside file for reads and writes (SYM-HARDLINK)', () => {
    linkSync(join(outside, 'host-secret.txt'), join(root, 'hard.txt'));
    refuses(() => confinedPath(root, 'hard.txt', 'read'), 'not_a_single_link_regular_file');
    refuses(() => confinedPath(root, 'hard.txt', 'write'), 'hard_link_target');
  });
  it('refuses reading a directory and writing onto a directory', () => {
    mkdirSync(join(root, 'd'));
    refuses(() => confinedPath(root, 'd', 'read'), 'not_a_single_link_regular_file');
    refuses(() => confinedPath(root, 'd', 'write'), 'target_is_a_directory');
  });
});

describe('LocalDevSandboxRuntime uses the confinement (DEFECT-5)', () => {
  const prev = process.env.SANDBOX_LOCAL_DEV;
  beforeEach(() => {
    process.env.SANDBOX_LOCAL_DEV = 'true';
    process.env.NUZM_LOCAL_DEV_EXEC = '1';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_LOCAL_DEV;
    else process.env.SANDBOX_LOCAL_DEV = prev;
  });
  const spec = {
    sandboxId: 's',
    orgId: 'o',
    projectId: 'p',
    quota: { vcpu: 1, memoryMb: 512, diskGb: 1, pids: 32, buildTimeoutMinutes: 1 },
    egressProfile: 'none',
    origin: eg.templateOrigin('confine-test-fixture'),
  };
  it('a named read through a symlink and a write through a symlinked directory are refused; an ordinary round trip works', async () => {
    const rt = new LocalDevSandboxRuntime();
    const h = await rt.create(spec);
    try {
      const dir = (rt as unknown as { dir(h: string): string }).dir(h);
      symlinkSync(join(outside, 'host-secret.txt'), join(dir, 'link.txt'));
      symlinkSync(outside, join(dir, 'out'));
      await expect(rt.readFiles(h, ['link.txt'])).rejects.toBeInstanceOf(RuntimeQuotaError);
      await expect(rt.writeFiles(h, new Map([['out/planted.txt', 'x']]))).rejects.toBeInstanceOf(
        RuntimeQuotaError,
      );
      expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
      await rt.writeFiles(h, new Map([['src/a.ts', 'ok']]));
      expect((await rt.readFiles(h, ['src/a.ts'])).get('src/a.ts')).toBe('ok');
      expect(readFileSync(join(outside, 'host-secret.txt'), 'utf8')).toBe('NZCANARY-host-secret');
    } finally {
      await rt.destroy(h);
    }
  });
});
