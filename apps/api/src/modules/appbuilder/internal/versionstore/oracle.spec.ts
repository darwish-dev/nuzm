import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { GitStore } from '../git/git.store';
import { applyHunks } from './diff';
import { hunksByPath, runConformance } from './conformance';
import { MemoryVersionStore } from './memory-backend';
import type { VersionStore } from './version-store.port';

/**
 * `GitStore` (real git) is the oracle. Memory stands for every `ObjectVersionStore` (the PostgreSQL store runs the same core, see pg-version-store.int.spec.ts).
 * Besides the shared conformance cases, random snapshots must yield IDENTICAL object ids and history, and every patch must apply.
 */
const git = GitStore.temp();
afterAll(git.cleanup);
const ref = () => `${randomUUID()}/${randomUUID()}.git`;

runConformance('GitStore (oracle, development only)', async () => ({
  store: git.store,
  newRef: async () => {
    const r = ref();
    await git.store.init(r);
    return r;
  },
}));
runConformance('MemoryVersionStore', async () => {
  const store = new MemoryVersionStore();
  return {
    store,
    newRef: async () => {
      const r = ref();
      await store.init(r);
      return r;
    },
  };
});

// ---- generators --------------------------------------------------------------------------------------------------------------------------
const SEGMENTS = ['a', 'b', 'a.b', 'a-b', 'a_b', 'Z', 'ab', 'a0', 'é', '0', 'x.ts', 'src', 'ملف'];
const segment = fc.constantFrom(...SEGMENTS);
const pathArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));
const LINES = ['alpha', 'beta', 'gamma', '', 'delta', '  indented', 'x = 1;', '}', 'عربى', 'same'];
const contentArb = fc
  .tuple(fc.array(fc.constantFrom(...LINES), { maxLength: 14 }), fc.boolean())
  .map(([ls, eol]) => (ls.length ? ls.join('\n') + (eol ? '\n' : '') : ''));
/** No path may be a directory prefix of another (a file and a directory with the same name cannot coexist). */
const snapshotArb = fc.array(fc.tuple(pathArb, contentArb), { maxLength: 6 }).map((pairs) => {
  const m = new Map<string, string>();
  for (const [p, c] of pairs) {
    const clash = [...m.keys()].some((k) => k.startsWith(`${p}/`) || p.startsWith(`${k}/`));
    if (!clash) m.set(p, c);
  }
  return m;
});
const messageArb = fc
  .array(fc.constantFrom('fix', 'add', 'update', 'مرحبا', 'wip', 'x'), {
    minLength: 1,
    maxLength: 4,
  })
  .map((w) => w.join(' '));
const secondsArb = fc.integer({ min: 1_577_836_800, max: 1_893_456_000 });

async function history(store: VersionStore, snaps: Map<string, string>[], msg: string, t0: number) {
  const r = ref();
  await store.init(r);
  const shas: string[] = [];
  for (let i = 0; i < snaps.length; i++)
    shas.push(
      (
        await store.commit(r, 'main', snaps[i]!, `${msg} ${i}`, {
          at: new Date((t0 + i * 60) * 1000),
        })
      ).sha,
    );
  return { r, shas };
}

describe('property: the PostgreSQL-grade core agrees with real git', () => {
  it('same snapshot, message and time give the same commit ids, the same log and the same tree on both stores', async () => {
    const mem = new MemoryVersionStore();
    await fc.assert(
      fc.asyncProperty(
        fc.array(snapshotArb, { minLength: 1, maxLength: 3 }),
        messageArb,
        secondsArb,
        async (snaps, msg, t0) => {
          const g = await history(git.store, snaps, msg, t0);
          const m = await history(mem, snaps, msg, t0);
          expect(m.shas).toEqual(g.shas);
          // git prints `%aI` (+00:00), the stores print ISO `Z`: compare the instants
          const norm = (l: { at: string }[]) =>
            l.map((c) => ({ ...c, at: new Date(c.at).toISOString() }));
          expect(norm(await mem.log(m.r, 'main'))).toEqual(norm(await git.store.log(g.r, 'main')));
          for (let i = 0; i < snaps.length; i++) {
            const a = await mem.readTree(m.r, m.shas[i]!);
            const b = await git.store.readTree(g.r, g.shas[i]!);
            expect([...a].sort()).toEqual([...b].sort());
            expect([...a].sort()).toEqual([...snaps[i]!].sort());
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 180_000);

  it('diff lists equal git and every patch (git’s and ours) turns the old content into the new content', async () => {
    const mem = new MemoryVersionStore();
    await fc.assert(
      fc.asyncProperty(
        snapshotArb,
        snapshotArb,
        messageArb,
        secondsArb,
        async (s1, s2, msg, t0) => {
          const g = await history(git.store, [s1, s2], msg, t0);
          const m = await history(mem, [s1, s2], msg, t0);
          const dg = await git.store.diff(g.r, g.shas[0]!, g.shas[1]!);
          const dm = await mem.diff(m.r, m.shas[0]!, m.shas[1]!);
          expect({ added: dm.added, modified: dm.modified, deleted: dm.deleted }).toEqual({
            added: dg.added,
            modified: dg.modified,
            deleted: dg.deleted,
          });
          for (const [patch, label] of [
            [dm.patch, 'ours'],
            [dg.patch, 'git'],
          ] as const) {
            const h = hunksByPath(patch);
            // git may pair a deleted and an added file as a rename WITH changes (hunks keyed by the old path): the add/delete checks do not apply then
            const renameish = /^rename from /m.test(patch);
            for (const p of dm.modified) {
              const hunks = h.get(p);
              // a pure rename or an empty-content change prints no hunks; content must then be equal or empty on one side
              if (hunks) expect(applyHunks(s1.get(p)!, hunks), `${label} ${p}`).toBe(s2.get(p)!);
              else expect(s1.get(p)).not.toBe(s2.get(p));
            }
            for (const p of dm.added)
              if (!renameish && h.has(p))
                expect(applyHunks('', h.get(p)!), `${label} +${p}`).toBe(s2.get(p)!);
            for (const p of dm.deleted)
              if (!renameish && h.has(p))
                expect(applyHunks(s1.get(p)!, h.get(p)!), `${label} -${p}`).toBe('');
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 180_000);
});
