import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GitError, GitStore } from './git.store';

const { store, cleanup } = GitStore.temp();
afterAll(cleanup);
const ref = () => `${randomUUID()}/${randomUUID()}.git`;
const F = (o: Record<string, string>) => new Map(Object.entries(o));

describe('git store (plumbing only)', () => {
  it('commits full snapshots on branches, reads them back byte for byte, lists the history, tags checkpoints', async () => {
    const r = ref();
    await store.init(r);
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
    const c2 = await store.commit(
      r,
      'work/ai',
      F({ 'README.md': '# hi\n', 'src/a.ts': 'export const a = 2;\n', 'src/c.ts': 'c' }),
      'ai change',
      { parentOverride: c1.sha },
    );
    expect([...(await store.readTree(r, c1.sha)).keys()].sort()).toEqual([
      'README.md',
      'db/migrations/0001_init.sql',
      'src/a.ts',
      'src/deep/b.ts',
    ]);
    expect((await store.readTree(r, 'work/ai')).get('src/a.ts')).toBe('export const a = 2;\n');
    expect((await store.log(r, 'work/ai')).map((c) => c.message)).toEqual(['ai change', 'initial']);
    expect((await store.branches(r)).map((b) => b.name).sort()).toEqual(['main', 'work/ai']);
    await store.tag(r, 'cp-after-ai', c2.sha);
    expect((await store.checkpoints(r))[0]).toEqual({ name: 'cp-after-ai', sha: c2.sha });
    await expect(store.tag(r, 'cp-after-ai', c2.sha)).rejects.toMatchObject({ code: 'stale_ref' });
    const d = await store.diff(r, 'main', 'work/ai');
    expect(d).toMatchObject({
      added: ['src/c.ts'],
      modified: ['src/a.ts'],
      deleted: ['db/migrations/0001_init.sql', 'src/deep/b.ts'],
    });
    expect(d.patch).toMatch(/-export const a = 1;/);
    expect(d.patch).toMatch(/\+export const a = 2;/);
  });
  it('is deterministic: the same snapshot and date give the same commit id', async () => {
    const a = ref();
    const b = ref();
    await store.init(a);
    await store.init(b);
    const at = new Date('2026-02-02T00:00:00Z');
    const files = F({ 'x.txt': 'same' });
    expect((await store.commit(a, 'main', files, 'm', { at })).sha).toBe(
      (await store.commit(b, 'main', files, 'm', { at })).sha,
    );
  });
  it('compare-and-swap: a branch that moved cannot be overwritten with a stale tip', async () => {
    const r = ref();
    await store.init(r);
    const c1 = await store.commit(r, 'main', F({ a: 'x' }), '1');
    await store.commit(r, 'main', F({ a: 'y' }), '2');
    await expect(
      store.commit(r, 'main', F({ a: 'z' }), '3', { expectedTip: c1.sha }),
    ).rejects.toMatchObject({ code: 'stale_ref' });
  });
  it('refuses traversal paths, file/dir name clashes and bad refs: nothing is ever written outside the repository', async () => {
    const r = ref();
    await store.init(r);
    for (const p of ['../x', '/etc/passwd', '.git/config', 'a/../../b'])
      await expect(store.commit(r, 'main', F({ [p]: 'x' }), 'm')).rejects.toBeInstanceOf(GitError);
    await expect(store.commit(r, 'main', F({ a: 'x', 'a/b': 'y' }), 'm')).rejects.toMatchObject({
      code: 'bad_ref',
    });
    await expect(store.commit(r, 'Bad Branch', F({ a: 'x' }), 'm')).rejects.toMatchObject({
      code: 'bad_ref',
    });
    await expect(store.commit(r, '--upload-pack=x', F({ a: 'x' }), 'm')).rejects.toMatchObject({
      code: 'bad_ref',
    });
    expect(() => store.gitDir('../../etc')).toThrow(GitError);
    await expect(store.log(r, '$(id)')).rejects.toMatchObject({ code: 'bad_ref' });
    expect(readdirSync(store.root).every((d) => /^[0-9a-f-]{36}$/.test(d))).toBe(true);
    expect(existsSync(`${store.root}/../x`)).toBe(false);
  });
  it('a hook in the repository never runs (core.hooksPath is /dev/null)', async () => {
    const r = ref();
    await store.init(r);
    const { writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(`${store.gitDir(r)}/hooks`, { recursive: true });
    writeFileSync(
      `${store.gitDir(r)}/hooks/reference-transaction`,
      '#!/bin/sh\ntouch /tmp/nuzm-hook-ran-test\n',
    );
    chmodSync(`${store.gitDir(r)}/hooks/reference-transaction`, 0o755);
    await store.commit(r, 'main', F({ a: 'x' }), 'm');
    expect(existsSync('/tmp/nuzm-hook-ran-test')).toBe(false);
  });
});
