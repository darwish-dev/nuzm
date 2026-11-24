import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { GitStore } from './git.store';

/**
 * R5 (Master decision): git.store is a host PROCESS (git plumbing) but never runs project code. This spec plants every mechanism by which a repository can make git execute a program
 * (hooks, a repository config with hooksPath/fsmonitor/filter/textconv/external diff, attributes) and proves none runs while the store writes, reads and diffs; and that the store
 * refuses in production and without the explicit opt-in. Only the `git` binary runs, on synthetic data in a temp directory.
 */
let cleanup: () => void;
let store: GitStore;
let marker: string;
const saved = process.env.NUZM_LOCAL_DEV_EXEC;
beforeEach(() => {
  process.env.NUZM_LOCAL_DEV_EXEC = '1';
  ({ store, cleanup } = GitStore.temp());
  marker = join(mkdtempSync(join(tmpdir(), 'nuzm-marker-')), 'EXECUTED');
});
afterEach(() => {
  cleanup();
  rmSync(join(marker, '..'), { recursive: true, force: true });
  if (saved === undefined) delete process.env.NUZM_LOCAL_DEV_EXEC;
  else process.env.NUZM_LOCAL_DEV_EXEC = saved;
});

describe('git.store never executes anything a repository could plant', () => {
  it('hooks, repository config drivers and attributes do not run', async () => {
    const ref = `${randomUUID()}/${randomUUID()}.git`;
    await store.init(ref);
    const dir = store.gitDir(ref);
    const evil = join(dir, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(evil, 0o755);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    for (const h of ['pre-commit', 'post-commit', 'reference-transaction', 'update', 'post-update', 'pre-receive', 'post-receive', 'commit-msg']) {
      writeFileSync(join(dir, 'hooks', h), `#!/bin/sh\necho ran > '${marker}'\n`);
      chmodSync(join(dir, 'hooks', h), 0o755);
    }
    appendFileSync(join(dir, 'config'), `[core]\n\thooksPath = ${join(dir, 'hooks')}\n\tfsmonitor = ${evil}\n\tpager = ${evil}\n\teditor = ${evil}\n[filter "evil"]\n\tclean = ${evil}\n\tsmudge = ${evil}\n\tprocess = ${evil}\n[diff "evil"]\n\ttextconv = ${evil}\n\tcommand = ${evil}\n[gc]\n\tauto = 1\n\tautoDetach = false\n\tpruneExpire = now\n`);
    mkdirSync(join(dir, 'info'), { recursive: true });
    writeFileSync(join(dir, 'info', 'attributes'), '* filter=evil diff=evil text eol=crlf\n');
    // the project also ships its own attributes file: it is a blob in a tree here, never a working-tree file git would read
    const evilAttrs = '* filter=evil diff=evil\n';
    // a path under `.git/` is refused by the store's own path rules; the project's own .gitattributes is only a blob in a tree here, never a file git reads
    await expect(store.commit(ref, 'main', new Map([['.git/hooks/post-commit', 'x']]), 'x')).rejects.toBeDefined();
    await store.commit(ref, 'main', new Map([['src/index.ts', 'export const a = 1;\n'], ['.gitattributes', evilAttrs]]), 'first');
    await store.commit(ref, 'main', new Map([['src/index.ts', 'export const a = 2;\n'], ['.gitattributes', evilAttrs]]), 'second');
    const log = await store.log(ref, 'main');
    expect(log.length).toBeGreaterThanOrEqual(2);
    await store.diff(ref, log[1]!.sha, log[0]!.sha);
    await store.readTree(ref, 'main');
    await store.tag(ref, 'cp-1', log[0]!.sha);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('git.store host-process guard', () => {
  it('refuses in production and without the explicit opt-in, audited; plumbing is not refused for a missing origin', async () => {
    const seen: eg.HostExecDecision[] = [];
    eg.setHostExecAuditor((d) => seen.push(d));
    const ref = `${randomUUID()}/${randomUUID()}.git`;
    delete process.env.NUZM_LOCAL_DEV_EXEC;
    await expect(store.init(ref)).rejects.toMatchObject({ reasons: ['opt_in_missing'] });
    process.env.NUZM_LOCAL_DEV_EXEC = '1';
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(store.init(ref)).rejects.toMatchObject({ reasons: ['production'] });
    } finally {
      process.env.NODE_ENV = was;
    }
    await expect(store.init(ref)).resolves.toBeUndefined();
    expect(seen.map((d) => [d.path, d.allowed])).toEqual([['git-store', false], ['git-store', false], ['git-store', true]]);
    eg.setHostExecAuditor(() => undefined);
  });
});
