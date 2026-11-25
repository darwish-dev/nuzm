import { describe, expect, it } from 'vitest';
import { GitError } from '../git/git.store';
import { applyHunks } from './diff';
import type { VersionStore } from './version-store.port';

/**
 * The version-store conformance suite. The SAME cases run against `GitStore` (the oracle: real git, development only), `MemoryVersionStore` and `PgVersionStore`.
 * A behaviour is part of the contract only if `GitStore` shows it; stricter behaviour of the production stores is tested in their own specs.
 */
export interface Harness {
  store: VersionStore;
  /** a new, initialised repository reference */
  newRef: () => Promise<string>;
}
const F = (o: Record<string, string>) => new Map(Object.entries(o));

/** Splits a multi-file unified patch into `path -> hunks`. */
export function hunksByPath(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of patch.split(/^diff --git /m).filter(Boolean)) {
    const path = /^a\/(.+?) b\//.exec(section)?.[1];
    const at = section.indexOf('\n@@ ');
    if (path && at >= 0) out.set(path, section.slice(at + 1));
  }
  return out;
}

export function runConformance(name: string, make: () => Promise<Harness>): void {
  describe(`version store conformance: ${name}`, () => {
    it('commits full snapshots on branches, reads them back byte for byte, lists the history, tags checkpoints, diffs', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const c1 = await store.commit(
        r,
        'main',
        F({
          'README.md': '# hi\n',
          'src/a.ts': 'export const a = 1;\n',
          'src/deep/b.ts': 'b',
          'db/migrations/0001_init.sql': 'CREATE TABLE t();\n',
        }),
        'initial',
        { at: new Date('2026-01-01T00:00:00Z') },
      );
      expect(c1.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c1.at).toBe('2026-01-01T00:00:00.000Z');
      expect(c1.parents).toEqual([]);
      const c2 = await store.commit(
        r,
        'work/ai',
        F({ 'README.md': '# hi\n', 'src/a.ts': 'export const a = 2;\n', 'src/c.ts': 'c' }),
        'ai change',
        { parentOverride: c1.sha },
      );
      expect(c2.parents).toEqual([c1.sha]);
      expect([...(await store.readTree(r, c1.sha)).keys()].sort()).toEqual([
        'README.md',
        'db/migrations/0001_init.sql',
        'src/a.ts',
        'src/deep/b.ts',
      ]);
      expect((await store.readTree(r, 'work/ai')).get('src/a.ts')).toBe('export const a = 2;\n');
      expect((await store.readTree(r, 'main')).get('src/deep/b.ts')).toBe('b');
      expect((await store.log(r, 'work/ai')).map((c) => c.message)).toEqual([
        'ai change',
        'initial',
      ]);
      expect((await store.log(r, 'work/ai', 1)).length).toBe(1);
      expect((await store.log(r, c1.sha))[0]).toMatchObject({ sha: c1.sha, parents: [] });
      expect((await store.branches(r)).map((b) => b.name)).toEqual(['main', 'work/ai']);
      expect(await store.tipOf(r, 'refs/heads/main')).toBe(c1.sha);
      expect(await store.tipOf(r, 'refs/heads/work/ai')).toBe(c2.sha);
      expect(await store.tipOf(r, 'refs/heads/nope')).toBeNull();
      await store.tag(r, 'cp-after-ai', c2.sha);
      expect(await store.checkpoints(r)).toEqual([{ name: 'cp-after-ai', sha: c2.sha }]);
      await expect(store.tag(r, 'cp-after-ai', c2.sha)).rejects.toMatchObject({
        code: 'stale_ref',
      });
      const d = await store.diff(r, 'main', 'work/ai');
      expect(d).toMatchObject({
        added: ['src/c.ts'],
        modified: ['src/a.ts'],
        deleted: ['db/migrations/0001_init.sql', 'src/deep/b.ts'],
      });
      expect(d.patch).toMatch(/-export const a = 1;/);
      expect(d.patch).toMatch(/\+export const a = 2;/);
      // the patch really transforms the old file into the new one
      const h = hunksByPath(d.patch);
      expect(applyHunks('export const a = 1;\n', h.get('src/a.ts')!)).toBe('export const a = 2;\n');
      expect(applyHunks('', h.get('src/c.ts')!)).toBe('c');
      expect(applyHunks('CREATE TABLE t();\n', h.get('db/migrations/0001_init.sql')!)).toBe('');
    });

    it('is deterministic: the same snapshot, message and date give the same commit id in two repositories', async () => {
      const { store, newRef } = await make();
      const [a, b] = [await newRef(), await newRef()];
      const at = new Date('2026-02-02T00:00:00Z');
      const files = F({ 'x.txt': 'same', 'd/y.txt': 'y\n' });
      expect((await store.commit(a, 'main', files, 'm', { at })).sha).toBe(
        (await store.commit(b, 'main', files, 'm', { at })).sha,
      );
    });

    it('compare-and-swap: a branch that moved cannot be overwritten with a stale tip; the first commit may expect null', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const c0 = await store.commit(r, 'main', F({ a: 'w' }), '0', { expectedTip: null });
      expect(c0.sha).toBe(await store.tipOf(r, 'refs/heads/main'));
      await expect(
        store.commit(r, 'main', F({ a: 'v' }), '0b', { expectedTip: null }),
      ).rejects.toMatchObject({ code: 'stale_ref' });
      const c1 = await store.commit(r, 'main', F({ a: 'x' }), '1');
      await store.commit(r, 'main', F({ a: 'y' }), '2');
      await expect(
        store.commit(r, 'main', F({ a: 'z' }), '3', { expectedTip: c1.sha }),
      ).rejects.toMatchObject({ code: 'stale_ref' });
      expect((await store.readTree(r, 'main')).get('a')).toBe('y');
    });

    it('refuses traversal paths, file/dir name clashes and bad refs, and writes nothing when it refuses', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      for (const p of ['../x', '/etc/passwd', '.git/config', 'a/../../b'])
        await expect(store.commit(r, 'main', F({ [p]: 'x' }), 'm')).rejects.toBeInstanceOf(
          GitError,
        );
      await expect(store.commit(r, 'main', F({ a: 'x', 'a/b': 'y' }), 'm')).rejects.toMatchObject({
        code: 'bad_ref',
      });
      await expect(store.commit(r, 'Bad Branch', F({ a: 'x' }), 'm')).rejects.toMatchObject({
        code: 'bad_ref',
      });
      await expect(store.commit(r, '--upload-pack=x', F({ a: 'x' }), 'm')).rejects.toMatchObject({
        code: 'bad_ref',
      });
      await expect(store.log(r, '$(id)')).rejects.toMatchObject({ code: 'bad_ref' });
      await expect(store.tag(r, 'Not-A-Checkpoint', 'a'.repeat(40))).rejects.toMatchObject({
        code: 'bad_ref',
      });
      await expect(store.tag(r, 'cp-x', 'nothex')).rejects.toMatchObject({ code: 'bad_ref' });
      expect(await store.tipOf(r, 'refs/heads/main')).toBeNull();
      expect(await store.branches(r)).toEqual([]);
    });

    it('rejects an invalid repository reference everywhere', async () => {
      const { store } = await make();
      await expect(store.init('../../etc')).rejects.toBeInstanceOf(GitError);
      await expect(store.commit('x', 'main', F({ a: 'x' }), 'm')).rejects.toBeInstanceOf(GitError);
      expect(await store.tipOf('x', 'refs/heads/main')).toBeNull();
    });

    it('init is idempotent and an empty repository answers empty', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      await store.init(r);
      expect(await store.branches(r)).toEqual([]);
      expect(await store.checkpoints(r)).toEqual([]);
      expect(await store.log(r, 'main')).toEqual([]);
      await expect(store.readTree(r, 'main')).rejects.toBeInstanceOf(GitError);
    });

    it('keeps odd but legal content exactly: empty files, no trailing newline, CRLF, unicode names and text, NUL-free binary-looking text', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const files = F({
        'empty.txt': '',
        'no-eol.txt': 'last line',
        'crlf.txt': 'a\r\nb\r\n',
        'ملف/نص.md': 'مرحبا بالعالم\n',
        'emoji-😀.txt': 'ok 😀\n',
        'a.b': 'dot',
        'a/b.txt': 'dir named a',
        'a-b': 'dash',
        'Z/upper.txt': 'u',
      });
      const c = await store.commit(r, 'main', files, 'odd');
      const back = await store.readTree(r, c.sha);
      expect(back.size).toBe(files.size);
      for (const [p, v] of files) expect(back.get(p)).toBe(v);
    });

    it('commits an empty snapshot', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const c = await store.commit(r, 'main', new Map(), 'empty');
      expect((await store.readTree(r, c.sha)).size).toBe(0);
    });

    it('diff of equal revisions is empty and of unknown revisions is an error', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const c = await store.commit(r, 'main', F({ a: 'x' }), 'm');
      expect(await store.diff(r, c.sha, c.sha)).toMatchObject({
        added: [],
        modified: [],
        deleted: [],
        patch: '',
      });
      await expect(store.diff(r, 'main', 'nope')).rejects.toBeInstanceOf(GitError);
    });

    it('a text diff of several edits applies cleanly (context, separate hunks, missing trailing newline)', async () => {
      const { store, newRef } = await make();
      const r = await newRef();
      const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
      const edited = [...lines];
      edited[3] = 'changed 3';
      edited.splice(30, 0, 'inserted A', 'inserted B');
      edited.splice(50, 2);
      const a = lines.join('\n') + '\n';
      const b = edited.join('\n'); // also drops the final newline
      const c1 = await store.commit(r, 'main', F({ 'f.txt': a }), 'a');
      const c2 = await store.commit(r, 'main', F({ 'f.txt': b }), 'b');
      const d = await store.diff(r, c1.sha, c2.sha);
      expect(d.modified).toEqual(['f.txt']);
      expect(applyHunks(a, hunksByPath(d.patch).get('f.txt')!)).toBe(b);
    });
  });
}
