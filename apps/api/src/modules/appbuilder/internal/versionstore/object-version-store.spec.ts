import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { MemoryBackend, MemoryVersionStore } from './memory-backend';
import { ObjectVersionStore } from './object-version-store';
import {
  MAX_FILE_BYTES,
  PATCH_CAP,
  restoreCheckpoint,
  VersionStoreError,
} from './version-store.port';

class Rec extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
const mk = (opts: ConstructorParameters<typeof MemoryVersionStore>[0] = {}) => {
  const store = new MemoryVersionStore(opts);
  const ref = `${randomUUID()}/${randomUUID()}.git`;
  return { store, ref, init: () => store.init(ref) };
};
const F = (o: Record<string, string | Uint8Array>) => new Map(Object.entries(o));
const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof VersionStoreError ? e.reason : `other:${String(e)}`),
  );

describe('idempotent commits (reconcile before retry)', () => {
  it('a retried commit returns the commit it already made, even after the branch moved on', async () => {
    const { store, ref, init } = mk();
    await init();
    const at = new Date('2026-03-01T00:00:00Z');
    const base = await store.commit(ref, 'main', F({ a: '0' }), 'base', { at });
    const first = await store.commit(ref, 'main', F({ a: '1' }), 'change', {
      expectedTip: base.sha,
      at,
    });
    // the response was lost; meanwhile somebody else committed on top
    await store.commit(ref, 'main', F({ a: '2' }), 'later', { expectedTip: first.sha });
    const retry = await store.commit(ref, 'main', F({ a: '1' }), 'change', {
      expectedTip: base.sha,
    });
    expect(retry.sha).toBe(first.sha);
    expect((await store.log(ref, 'main')).map((c) => c.message)).toEqual([
      'later',
      'change',
      'base',
    ]);
  });
  it('the same request twice (no expected tip) makes one commit, with a different time too', async () => {
    const { store, ref, init } = mk();
    await init();
    const base = await store.commit(ref, 'main', F({ a: '0' }), 'base');
    const a = await store.commit(ref, 'main', F({ a: '1' }), 'x', {
      expectedTip: base.sha,
      at: new Date(1_800_000_000_000),
    });
    const b = await store.commit(ref, 'main', F({ a: '1' }), 'x', {
      expectedTip: base.sha,
      at: new Date(1_800_000_999_000),
    });
    expect(b.sha).toBe(a.sha);
    expect(store.events(ref).filter((e) => e.action === 'commit.created')).toHaveLength(2); // base + x, not three
  });
  it('a different message or tree is a different commit', async () => {
    const { store, ref, init } = mk();
    await init();
    const base = await store.commit(ref, 'main', F({ a: '0' }), 'base');
    const a = await store.commit(ref, 'main', F({ a: '1' }), 'one', { expectedTip: base.sha });
    const b = await store.commit(ref, 'main', F({ a: '1' }), 'two', { expectedTip: a.sha });
    expect(b.sha).not.toBe(a.sha);
    expect(b.parents).toEqual([a.sha]);
  });
  it('concurrent writers: exactly one wins the compare-and-swap, the rest get stale_ref and nothing is half-written', async () => {
    const { store, ref, init } = mk();
    await init();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        store.commit(ref, 'main', F({ f: `v${i}` }), `m${i}`, { expectedTip: null }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'stale_ref' });
    expect((await store.log(ref, 'main')).length).toBe(1);
  });
});

describe('history is never rewritten', () => {
  it('refuses a commit that does not build on the branch tip, and refuses an unknown parent', async () => {
    const { store, ref, init } = mk();
    await init();
    const c1 = await store.commit(ref, 'main', F({ a: '1' }), 'c1');
    await store.commit(ref, 'main', F({ a: '2' }), 'c2');
    expect(
      await reason(store.commit(ref, 'main', F({ a: '3' }), 'c3', { parentOverride: c1.sha })),
    ).toBe('stale_ref');
    expect(
      await reason(
        store.commit(ref, 'work/x', F({ a: '3' }), 'c3', { parentOverride: 'f'.repeat(40) }),
      ),
    ).toBe('unknown_revision');
    expect((await store.log(ref, 'main')).map((c) => c.message)).toEqual(['c2', 'c1']);
  });
  it('rollback is a NEW commit restoring the checkpoint tree; the checkpoint and the old history stay', async () => {
    const { store, ref, init } = mk();
    await init();
    const v1 = await store.commit(ref, 'main', F({ 'a.txt': 'one', 'b.txt': 'keep' }), 'v1');
    await store.tag(ref, 'cp-v1', v1.sha);
    await store.commit(ref, 'main', F({ 'a.txt': 'two', 'c.txt': 'new' }), 'v2');
    const restored = await restoreCheckpoint(store, ref, 'main', 'cp-v1');
    expect(restored.message).toBe('Restore cp-v1');
    expect(restored.sha).not.toBe(v1.sha);
    expect(restored.parents).toHaveLength(1);
    expect(Object.fromEntries(await store.readTree(ref, 'main'))).toEqual({
      'a.txt': 'one',
      'b.txt': 'keep',
    });
    expect((await store.log(ref, 'main')).map((c) => c.message)).toEqual([
      'Restore cp-v1',
      'v2',
      'v1',
    ]);
    expect(await store.checkpoints(ref)).toEqual([{ name: 'cp-v1', sha: v1.sha }]);
    // a retry of the same restore is a no-op
    expect((await restoreCheckpoint(store, ref, 'main', 'cp-v1')).sha).toBe(restored.sha);
    expect((await store.log(ref, 'main')).length).toBe(3);
    expect(await reason(restoreCheckpoint(store, ref, 'main', 'cp-nope'))).toBe('unknown_revision');
  });
  it('branch names that would clash as references are refused (a, then a/b)', async () => {
    const { store, ref, init } = mk();
    await init();
    await store.commit(ref, 'topic', F({ a: '1' }), 'm');
    expect(await reason(store.commit(ref, 'topic/sub', F({ a: '1' }), 'm'))).toBe('bad_ref');
    await store.commit(ref, 'x/y', F({ a: '1' }), 'm');
    expect(await reason(store.commit(ref, 'x', F({ a: '1' }), 'm'))).toBe('bad_ref');
    expect(await reason(store.commit(ref, 'a//b', F({ a: '1' }), 'm'))).toBe('bad_ref');
    expect(await reason(store.commit(ref, 'a/', F({ a: '1' }), 'm'))).toBe('bad_ref');
  });
  it('a checkpoint can only name an existing commit and never be created twice', async () => {
    const { store, ref, init } = mk();
    await init();
    const c = await store.commit(ref, 'main', F({ a: '1' }), 'm');
    expect(await reason(store.tag(ref, 'cp-x', 'a'.repeat(40)))).toBe('unknown_revision');
    await store.tag(ref, 'cp-x', c.sha);
    expect(await reason(store.tag(ref, 'cp-x', c.sha))).toBe('stale_ref');
  });
});

describe('path rules, caps and the secret scan', () => {
  it('refuses forbidden paths and leaves the repository untouched', async () => {
    const { store, ref, init } = mk();
    await init();
    const bad = [
      '../x',
      '/abs',
      'a/../b',
      '.git/config',
      'sub/.git/x',
      'a\\b',
      'a//b',
      'x/',
      '.ssh/id',
      'node_modules/p/i.js',
      'a/ ',
      'con:x',
      'a/%2e%2e/b',
      'é.txt',
      'a‮b',
    ];
    for (const p of bad)
      expect(await reason(store.commit(ref, 'main', F({ [p]: 'x' }), 'm')), p).toBe(
        'path_rejected',
      );
    expect(await reason(store.commit(ref, 'main', F({ a: 'x', 'a/b': 'y' }), 'm'))).toBe(
      'path_rejected',
    );
    expect(await store.branches(ref)).toEqual([]);
  });
  it('enforces the file count, per-file and per-snapshot size caps', async () => {
    const { store, ref, init } = mk();
    await init();
    const many = new Map(Array.from({ length: 5001 }, (_, i) => [`f${i}.txt`, `${i}`] as const));
    expect(await reason(store.commit(ref, 'main', many, 'm'))).toBe('too_large');
    expect(
      await reason(store.commit(ref, 'main', F({ big: 'x'.repeat(MAX_FILE_BYTES + 1) }), 'm')),
    ).toBe('too_large');
    const fifty = new Map(
      Array.from(
        { length: 51 },
        (_, i) => [`b${i}.bin`, new Uint8Array(1_000_000).fill(i + 1)] as const,
      ),
    );
    expect(await reason(store.commit(ref, 'main', fifty, 'm'))).toBe('too_large');
    const ok = await store.commit(ref, 'main', F({ big: 'x'.repeat(MAX_FILE_BYTES) }), 'm');
    expect(ok.sha).toMatch(/^[0-9a-f]{40}$/);
  });
  it('enforces the per-repository storage quota (only NEW bytes count)', async () => {
    const { store, ref, init } = mk({ maxRepoBytes: 100 });
    await init();
    await store.commit(ref, 'main', F({ a: 'x'.repeat(80) }), 'm1');
    expect(await reason(store.commit(ref, 'main', F({ a: 'y'.repeat(80) }), 'm2'))).toBe(
      'too_large',
    );
    // unchanged content costs nothing
    await store.commit(ref, 'main', F({ a: 'x'.repeat(80), b: 'x'.repeat(80) }), 'm3');
  });
  it('rejects a secret on write without echoing it; an existing blob is not rescanned, so a rollback still works', async () => {
    const backend = new MemoryBackend();
    const off = new ObjectVersionStore(backend, { scanSecrets: false });
    const on = new ObjectVersionStore(backend);
    const ref = `${randomUUID()}/${randomUUID()}.git`;
    await on.init(ref);
    const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''); // assembled at run time (the repository secret scan refuses key-shaped literals)
    const err = await on
      .commit(ref, 'main', F({ 'cfg/aws.txt': `id=${key}\n` }), 'm')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).reason).toBe('secret_detected');
    expect((err as VersionStoreError).detail).toMatchObject({
      path: 'cfg/aws.txt',
      rule: 'aws_access_key_id',
      line: 1,
    });
    expect(String((err as Error).message)).not.toContain(key);
    expect(await on.branches(ref)).toEqual([]);
    // history that predates the rule: written with the scan off, restorable with it on
    const v1 = await off.commit(ref, 'main', F({ 'cfg/aws.txt': `id=${key}\n` }), 'legacy');
    await on.tag(ref, 'cp-legacy', v1.sha);
    await on.commit(ref, 'main', F({ 'cfg/aws.txt': 'id=redacted\n' }), 'clean');
    const back = await restoreCheckpoint(on, ref, 'main', 'cp-legacy');
    expect((await on.readTree(ref, back.sha)).get('cfg/aws.txt')).toContain(key);
  });
});

describe('messages and history', () => {
  it('truncates at 2000 characters, rejects empty or NUL messages, reports the subject like git log', async () => {
    const { store, ref, init } = mk();
    await init();
    expect(await reason(store.commit(ref, 'main', F({ a: '1' }), '   '))).toBe('bad_ref');
    expect(await reason(store.commit(ref, 'main', F({ a: '1' }), 'x\0y'))).toBe('bad_ref');
    const c = await store.commit(
      ref,
      'main',
      F({ a: '1' }),
      `first line\ncontinues\n\nbody paragraph ${'z'.repeat(3000)}`,
    );
    expect(c.message).toBe('first line continues');
    expect((await store.log(ref, 'main'))[0]!.message).toBe('first line continues');
  });
  it('log: unknown branch is empty, unknown sha is an error, limit is honoured and capped', async () => {
    const { store, ref, init } = mk();
    await init();
    for (let i = 0; i < 5; i++)
      await store.commit(ref, 'main', F({ a: `${i}` }), `m${i}`, {
        at: new Date(1_800_000_000_000 + i * 1000),
      });
    expect(await store.log(ref, 'nope')).toEqual([]);
    expect(await reason(store.log(ref, 'f'.repeat(40)))).toBe('unknown_revision');
    expect((await store.log(ref, 'main', 2)).map((c) => c.message)).toEqual(['m4', 'm3']);
    expect(await store.log(ref, 'main', 0)).toEqual([]);
    expect((await store.log(ref, 'main', 10_000)).length).toBe(5);
  });
  it('a long history walks in time order, a checkpoint name resolves like a branch', async () => {
    const { store, ref, init } = mk();
    await init();
    let last = '';
    for (let i = 0; i < 260; i++)
      last = (
        await store.commit(ref, 'main', F({ n: `${i}` }), `m${i}`, {
          at: new Date(1_800_000_000_000 + i * 1000),
        })
      ).sha;
    const log = await store.log(ref, 'main', 500);
    expect(log).toHaveLength(200);
    expect(log[0]!.sha).toBe(last);
    expect(log[0]!.message).toBe('m259');
    expect(log[199]!.message).toBe('m60');
    await store.tag(ref, 'cp-end', last);
    expect((await store.readTree(ref, 'cp-end')).get('n')).toBe('259');
    expect(await store.tipOf(ref, 'refs/tags/cp-end')).toBe(last);
    expect(await store.tipOf(ref, 'HEAD')).toBe(last);
    expect(await store.tipOf(ref, 'refs/heads/../../etc')).toBeNull();
  });
});

describe('binary files, sizes, renames and big diffs', () => {
  it('stores bytes exactly, reports binary files instead of printing them, and keeps them through a rollback', async () => {
    const { store, ref, init } = mk();
    await init();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 0]);
    const v1 = await store.commit(ref, 'main', F({ 'logo.png': png, 'a.txt': 'x\n' }), 'v1');
    await store.tag(ref, 'cp-v1', v1.sha);
    const png2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 9]);
    const v2 = await store.commit(ref, 'main', F({ 'logo.png': png2, 'a.txt': 'x\n' }), 'v2');
    expect([...(await store.readFiles(ref, v1.sha)).get('logo.png')!]).toEqual([...png]);
    const d = await store.diff(ref, v1.sha, v2.sha);
    expect(d.modified).toEqual(['logo.png']);
    expect(d.patch).toContain('Binary files a/logo.png and b/logo.png differ');
    expect(d.patch).not.toContain('@@');
    expect(await store.listTree(ref, v1.sha)).toEqual([
      expect.objectContaining({ path: 'a.txt', size: 2, binary: false }),
      expect.objectContaining({ path: 'logo.png', size: 10, binary: true }),
    ]);
    await restoreCheckpoint(store, ref, 'main', 'cp-v1');
    expect([...(await store.readFiles(ref, 'main')).get('logo.png')!]).toEqual([...png]);
  });
  it('reports an exact rename without changing the three lists; empty files are never paired', async () => {
    const { store, ref, init } = mk();
    await init();
    const a = await store.commit(
      ref,
      'main',
      F({ 'old/name.ts': 'export const x = 1;\n', e1: '', keep: 'k' }),
      'a',
    );
    const b = await store.commit(
      ref,
      'main',
      F({ 'new/name.ts': 'export const x = 1;\n', e2: '', keep: 'k' }),
      'b',
    );
    const d = await store.diff(ref, a.sha, b.sha);
    expect(d.added).toEqual(['e2', 'new/name.ts']);
    expect(d.deleted).toEqual(['e1', 'old/name.ts']);
    expect(d.renamed).toEqual([{ from: 'old/name.ts', to: 'new/name.ts' }]);
    expect(d.patch).toContain('rename from old/name.ts\nrename to new/name.ts');
  });
  it('a file replaced by a directory of the same name is a delete plus adds', async () => {
    const { store, ref, init } = mk();
    await init();
    const a = await store.commit(ref, 'main', F({ x: 'file' }), 'a');
    const b = await store.commit(ref, 'main', F({ 'x/y': 'nested' }), 'b');
    const d = await store.diff(ref, a.sha, b.sha);
    expect(d).toMatchObject({ added: ['x/y'], deleted: ['x'], modified: [] });
  });
  it('a total rewrite of a huge file and a flood of changed files stay within the caps', async () => {
    const { store, ref, init } = mk();
    await init();
    const lines = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join('\n');
    const a = await store.commit(ref, 'main', F({ 'big.txt': lines('a') }), 'a');
    const b = await store.commit(ref, 'main', F({ 'big.txt': lines('b') }), 'b');
    const d = await store.diff(ref, a.sha, b.sha);
    expect(d.modified).toEqual(['big.txt']);
    expect(d.patch).toContain('diff omitted');
    const many1 = new Map(
      Array.from({ length: 400 }, (_, i) => [`f${i}.txt`, `old ${i}\n`.repeat(50)] as const),
    );
    const many2 = new Map(
      Array.from({ length: 400 }, (_, i) => [`f${i}.txt`, `new ${i}\n`.repeat(50)] as const),
    );
    const c = await store.commit(ref, 'work/m', many1, 'c');
    const e = await store.commit(ref, 'work/m', many2, 'e');
    const d2 = await store.diff(ref, c.sha, e.sha);
    expect(d2.modified).toHaveLength(400);
    expect(d2.patch.length).toBeLessThanOrEqual(PATCH_CAP);
  });
});

describe('integrity, audit and residency', () => {
  it('detects a blob changed in storage and refuses to return it', async () => {
    const { store, ref, init } = mk();
    await init();
    const c = await store.commit(ref, 'main', F({ 'a.txt': 'genuine\n' }), 'm');
    const [f] = await store.listTree(ref, c.sha);
    store.memory.corruptBlob(ref, f!.oid, Buffer.from('forged!\n'));
    expect(await reason(store.readTree(ref, c.sha))).toBe('corrupt_object');
  });
  it('detects a reference moved to an object that is not a commit of this repository', async () => {
    const { store, ref, init } = mk();
    await init();
    await store.commit(ref, 'main', F({ a: '1' }), 'm');
    store.memory.tamperRef(ref, 'refs/heads/main', 'e'.repeat(40));
    expect(await reason(store.readTree(ref, 'main'))).toBe('unknown_revision');
  });
  it('records every mutation in the journal and in the audit sink, with actor and trace, and nothing for reads or replays', async () => {
    const audit = new Rec();
    const { store, ref } = mk({ audit });
    const actor = { actorUserId: randomUUID(), traceId: 'trace-1' };
    await store.init(ref, actor);
    await store.init(ref, actor); // second init: no new event
    const c = await store.commit(ref, 'main', F({ a: 'content-marker-9137' }), 'first', actor);
    await store.commit(ref, 'main', F({ a: 'content-marker-9137' }), 'first', {
      ...actor,
      expectedTip: null,
    }); // replay
    await store.tag(ref, 'cp-one', c.sha, actor);
    await store.setRemoteRef(ref, 'github', 'main', c.sha, { ...actor, detail: { repo: 'o/r' } });
    await store.readTree(ref, 'main');
    await store.log(ref, 'main');
    expect(audit.events.map((e) => e.action)).toEqual([
      'builder.version.repo_initialised',
      'builder.version.committed',
      'builder.version.checkpointed',
      'builder.version.remote_synced',
    ]);
    for (const e of audit.events) {
      expect(e).toMatchObject({
        orgId: ref.split('/')[0],
        outcome: 'success',
        resource: { type: 'builder_project' },
      });
    }
    expect(audit.events[1]).toMatchObject({
      actorUserId: actor.actorUserId,
      traceId: 'trace-1',
      after: { branch: 'main', commit: c.sha, files: 1 },
    });
    expect(store.events(ref).map((e) => e.action)).toEqual([
      'repo.initialised',
      'commit.created',
      'checkpoint.created',
      'remote_ref.set',
    ]);
    expect(JSON.stringify(audit.events)).not.toContain('content-marker'); // file content never reaches the audit event
  });
  it('asks the residency policy before placing a repository, and refuses (writing nothing) when it says no', async () => {
    const asked: unknown[] = [];
    const deny = {
      evaluate: async (req: unknown) => {
        asked.push(req);
        return {
          decision: 'deny' as const,
          reasons: [{ code: 'region', message: { ar: 'x', en: 'x' } }],
          policyVersion: 1,
          floorVersion: 1,
          assessmentId: null,
          evidenceRef: 'e',
        };
      },
    };
    const { store, ref } = mk({ residency: deny });
    expect(await reason(store.init(ref))).toBe('residency_denied');
    expect(asked[0]).toMatchObject({
      dataClass: 'customer-content',
      purpose: 'builder_version_store',
      operation: 'write',
      targetRegion: 'memory',
    });
    expect(await reason(store.commit(ref, 'main', F({ a: '1' }), 'm'))).toBe('not_initialised');
    const allow = {
      evaluate: async () => ({
        decision: 'allow' as const,
        reasons: [],
        policyVersion: 1,
        floorVersion: 1,
        assessmentId: null,
        evidenceRef: 'e',
      }),
    };
    const ok = mk({ residency: allow });
    await ok.init();
    expect((await ok.store.commit(ok.ref, 'main', F({ a: '1' }), 'm')).sha).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
  it('an uninitialised repository cannot be written, and the organisation comes only from the reference', async () => {
    const { store, ref } = mk();
    expect(await reason(store.commit(ref, 'main', F({ a: '1' }), 'm'))).toBe('not_initialised');
    expect(await reason(store.tag(ref, 'cp-a', 'a'.repeat(40)))).toBe('not_initialised');
    expect(await store.tipOf(ref, 'refs/heads/main')).toBeNull();
  });
});
