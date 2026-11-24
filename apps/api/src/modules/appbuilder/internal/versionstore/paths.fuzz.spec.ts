import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkPath } from '../sandbox/paths';
import { MemoryVersionStore } from './memory-backend';
import { SHA, VersionStoreError } from './version-store.port';

/** Fuzz of the path and reference rules: whatever the input, an accepted snapshot only contains plain safe relative paths, and a refused one writes nothing. */
const NASTY = [
  '..',
  '.',
  '.git',
  '.GIT',
  '.Git',
  'a',
  'b',
  'node_modules',
  '%2e%2e',
  '~',
  'C:',
  ' ',
  'a.',
  'a ',
  '',
  '\\',
  '\0',
  '‮',
  'é',
  'con:',
  'x*y',
  '.ssh',
  '.aws',
  '....',
  '/',
];
const seg = fc.oneof(fc.constantFrom(...NASTY), fc.string({ unit: 'binary', maxLength: 5 }));
const pathArb = fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));

describe('path rules (fuzz)', () => {
  it('every path the store accepts passes checkPath, has no traversal/.git/absolute/backslash/NUL, and round-trips', async () => {
    const store = new MemoryVersionStore();
    await fc.assert(
      fc.asyncProperty(fc.array(pathArb, { minLength: 1, maxLength: 5 }), async (paths) => {
        const ref = `${randomUUID()}/${randomUUID()}.git`;
        await store.init(ref);
        const files = new Map(paths.map((p) => [p, 'x'] as const));
        let accepted = false;
        try {
          await store.commit(ref, 'main', files, 'm');
          accepted = true;
        } catch (e) {
          expect(e).toBeInstanceOf(VersionStoreError);
        }
        if (!accepted) {
          expect(await store.branches(ref)).toEqual([]); // nothing written
          return;
        }
        for (const p of (await store.readTree(ref, 'main')).keys()) {
          expect(checkPath(p)).toBeNull();
          expect(
            p.split('/').some((s) => s === '..' || s === '.' || s.toLowerCase() === '.git'),
          ).toBe(false);
          expect(
            p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.includes('//'),
          ).toBe(false);
          expect(files.has(p)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });
  it('branch, checkpoint and revision names never reach storage unless they match the strict patterns', async () => {
    const store = new MemoryVersionStore();
    const ref = `${randomUUID()}/${randomUUID()}.git`;
    await store.init(ref);
    const base = await store.commit(ref, 'main', new Map([['a', 'x']]), 'm');
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 30 }), async (name) => {
        const okBranch =
          /^[a-z][a-z0-9/_-]{0,60}$/.test(name) && !name.includes('//') && !name.endsWith('/');
        const r = await store
          .commit(ref, name, new Map([['a', 'x']]), 'm', { parentOverride: base.sha })
          .then(
            () => 'ok',
            (e: unknown) => (e instanceof VersionStoreError ? e.reason : 'crash'),
          );
        expect(r === 'crash').toBe(false);
        if (!okBranch) expect(r).toBe('bad_ref');
        const t = await store.tag(ref, name, base.sha).then(
          () => 'ok',
          (e: unknown) => (e instanceof VersionStoreError ? e.reason : 'crash'),
        );
        if (!/^cp-[0-9a-z][0-9a-z-]{0,60}$/.test(name)) expect(t).toBe('bad_ref');
        expect(await store.tipOf(ref, name)).toSatisfy(
          (x: string | null) => x === null || SHA.test(x),
        );
      }),
      { numRuns: 300 },
    );
    for (const b of await store.branches(ref))
      expect(/^[a-z][a-z0-9/_-]{0,60}$/.test(b.name)).toBe(true);
  });
  it('a reference of another shape than <uuid>/<uuid>.git is refused, including traversal', async () => {
    const store = new MemoryVersionStore();
    for (const bad of [
      '../../etc/passwd',
      `${randomUUID()}/../x.git`,
      `${randomUUID()}/${randomUUID()}`,
      '',
      '/',
      `${randomUUID()}/${randomUUID()}.git/../..`,
    ])
      await expect(store.init(bad)).rejects.toBeInstanceOf(VersionStoreError);
  });
});
