import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, ORG_A, ORG_B, SEED_USER, type TestEnv } from '@nuzm/platform/testing';
import { AuditSink, type AuditEvent } from '../../../../common/audit';
import { runConformance } from './conformance';
import { MemoryVersionStore } from './memory-backend';
import { PgVersionStore } from './pg-version-store';
import { restoreCheckpoint, VersionStoreError } from './version-store.port';

// This file never falls back to the default development cluster: the caller must name a database server explicitly (NUZM_TEST_ADMIN_URL).
if (!process.env.NUZM_TEST_ADMIN_URL)
  throw new Error(
    'set NUZM_TEST_ADMIN_URL to a Postgres of your own (P3-S09 uses :54359); the default :54329 is not used by this suite',
  );

class Rec extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}
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
const F = (o: Record<string, string | Uint8Array>) => new Map(Object.entries(o));
const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof VersionStoreError ? e.reason : `other:${(e as Error).message}`),
  );

let env: TestEnv;
let audit: Rec;
let store: PgVersionStore;
beforeAll(async () => {
  env = await createEnv();
  audit = new Rec();
  store = new PgVersionStore(env.app, { audit, residency: allow });
});
afterAll(async () => {
  await env.close();
});

/** Registers `builder.git_repos` the way ChangeService.repoFor does (under the organisation's RLS context), then initialises the store. */
async function newRepo(org = ORG_A, region = 'sa-central', s: PgVersionStore = store) {
  const project = randomUUID();
  const ref = `${org}/${project}.git`;
  const id = randomUUID();
  await env.app.withOrg(org, (c) =>
    c.query(
      `INSERT INTO builder.git_repos (id, org_id, project_id, storage_ref, data_region) VALUES ($1,$2,$3,$4,$5)`,
      [id, org, project, ref, region],
    ),
  );
  await s.init(ref);
  return { ref, id, project };
}
const q = (org: string, sql: string, p: unknown[] = []) =>
  env.app.withOrg(org, (c) => c.query(sql, p));
const count = async (org: string, table: string, repo?: string) =>
  Number(
    (
      await q(
        org,
        `SELECT count(*)::int AS n FROM builder.${table}${repo ? ' WHERE repo_id = $1' : ''}`,
        repo ? [repo] : [],
      )
    ).rows[0].n,
  );

runConformance('PgVersionStore (PostgreSQL, RLS)', async () => ({
  store,
  newRef: async () => (await newRepo()).ref,
}));

describe('tenant isolation (RLS + composite foreign keys)', () => {
  it('another organisation sees none of the rows, cannot write rows for the first, and a forged reference finds nothing', async () => {
    const a = await newRepo(ORG_A);
    const c = await store.commit(a.ref, 'main', F({ 'secret.txt': 'tenant A only\n' }), 'a1');
    await store.tag(a.ref, 'cp-a', c.sha);
    for (const t of [
      'vcs_blobs',
      'vcs_trees',
      'vcs_commits',
      'vcs_refs',
      'vcs_events',
      'vcs_repo_state',
    ])
      expect(await count(ORG_B, t, a.id), t).toBe(0);
    expect(
      (await q(ORG_B, `SELECT count(*)::int AS n FROM builder.git_repos WHERE id = $1`, [a.id]))
        .rows[0].n,
    ).toBe(0);
    expect(await count(ORG_A, 'vcs_blobs', a.id)).toBeGreaterThan(0);
    // writing rows that claim organisation A while acting as B is refused by the row-level policy
    await expect(
      q(
        ORG_B,
        `INSERT INTO builder.vcs_blobs (repo_id, org_id, oid, sha256, size, is_binary, content, data_region) VALUES ($1,$2,$3,$4,0,false,''::bytea,'sa-central')`,
        [a.id, ORG_A, 'a'.repeat(40), 'b'.repeat(64)],
      ),
    ).rejects.toThrow(/row-level security/);
    // claiming organisation B for A's repository breaks the composite foreign key (checked by the database itself, not by the app)
    await expect(
      env.sql(
        `INSERT INTO builder.vcs_blobs (repo_id, org_id, oid, sha256, size, is_binary, content, data_region) VALUES ($1,$2,$3,$4,0,false,''::bytea,'sa-central')`,
        [a.id, ORG_B, 'c'.repeat(40), 'd'.repeat(64)],
      ),
    ).rejects.toThrow(/foreign key/);
    // B's store calls with A's project id under B's organisation: no repository, no data
    const forged = `${ORG_B}/${a.project}.git`;
    expect(await store.tipOf(forged, 'refs/heads/main')).toBeNull();
    expect(await store.branches(forged)).toEqual([]);
    expect(await reason(store.commit(forged, 'main', F({ x: '1' }), 'm'))).toBe('not_initialised');
    expect(await reason(store.init(forged))).toBe('not_initialised');
    // B has its own repository (a project id is unique platform-wide): A's history is not reachable through it, not even by commit id
    const b = await newRepo(ORG_B);
    expect(await store.log(b.ref, 'main')).toEqual([]);
    expect(await reason(store.readTree(b.ref, c.sha))).toBe('unknown_revision');
    expect(await reason(store.tag(b.ref, 'cp-steal', c.sha))).toBe('unknown_revision');
    expect(await store.checkpoints(b.ref)).toEqual([]);
    // the platform scope (admin console) may read, the application role in A may not see B's
    const admin = await env.app.withPlatformScope((cl) =>
      cl.query(`SELECT count(*)::int AS n FROM builder.vcs_commits`),
    );
    expect(Number(admin.rows[0].n)).toBeGreaterThan(0);
    expect(await count(ORG_A, 'vcs_commits', b.id)).toBe(0);
  });
  it('the runtime role has no way to delete or rewrite objects, and even a superuser hits the immutability triggers', async () => {
    const a = await newRepo(ORG_A);
    const c = await store.commit(a.ref, 'main', F({ 'f.txt': 'x\n' }), 'm');
    await store.tag(a.ref, 'cp-x', c.sha);
    for (const t of ['vcs_blobs', 'vcs_trees', 'vcs_commits', 'vcs_events']) {
      await expect(q(ORG_A, `DELETE FROM builder.${t} WHERE repo_id = $1`, [a.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(env.sql(`DELETE FROM builder.${t} WHERE repo_id = $1`, [a.id])).rejects.toThrow(
        /immutable/,
      );
      await expect(
        env.sql(`UPDATE builder.${t} SET org_id = org_id WHERE repo_id = $1`, [a.id]),
      ).rejects.toThrow(/immutable/);
    }
    await expect(
      q(ORG_A, `UPDATE builder.vcs_blobs SET content = 'x'::bytea WHERE repo_id = $1`, [a.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      env.sql(`DELETE FROM builder.vcs_refs WHERE repo_id = $1`, [a.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      q(
        ORG_A,
        `UPDATE builder.vcs_refs SET oid = $2 WHERE repo_id = $1 AND name = 'refs/tags/cp-x'`,
        [a.id, 'e'.repeat(40)],
      ),
    ).rejects.toThrow(/never moves/);
    await expect(
      env.sql(`UPDATE builder.vcs_repo_state SET stored_bytes = 0 WHERE repo_id = $1`, [a.id]),
    ).rejects.toThrow(/only grow/);
    await expect(
      env.sql(`DELETE FROM builder.vcs_repo_state WHERE repo_id = $1`, [a.id]),
    ).rejects.toThrow(/never deleted/);
  });
});

describe('commits are atomic, serialised and idempotent in PostgreSQL', () => {
  it('concurrent writers: exactly one compare-and-swap wins, the losers leave no rows', async () => {
    const r = await newRepo();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        store.commit(r.ref, 'main', F({ f: `v${i}`, [`only-${i}`]: `${i}` }), `m${i}`, {
          expectedTip: null,
        }),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of results.filter((y) => y.status === 'rejected'))
      expect((x as PromiseRejectedResult).reason).toMatchObject({ code: 'stale_ref' });
    expect(await count(ORG_A, 'vcs_commits', r.id)).toBe(1);
    expect(
      (
        await q(ORG_A, `SELECT count(*)::int AS n FROM builder.vcs_blobs WHERE repo_id = $1`, [
          r.id,
        ])
      ).rows[0].n,
    ).toBe(2); // only the winner's two files
    expect(
      Number(
        (
          await q(ORG_A, `SELECT stored_bytes FROM builder.vcs_repo_state WHERE repo_id = $1`, [
            r.id,
          ])
        ).rows[0].stored_bytes,
      ),
    ).toBe(
      Number(
        (
          await q(
            ORG_A,
            `SELECT coalesce(sum(size),0) AS s FROM builder.vcs_blobs WHERE repo_id = $1`,
            [r.id],
          )
        ).rows[0].s,
      ),
    );
  });
  it('writers to different branches of one repository are serialised, none lost', async () => {
    const r = await newRepo();
    const base = await store.commit(r.ref, 'main', F({ a: '0' }), 'base');
    const out = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.commit(r.ref, `work/b${i}`, F({ a: `${i}` }), `b${i}`, { parentOverride: base.sha }),
      ),
    );
    expect(new Set(out.map((c) => c.sha)).size).toBe(6);
    expect((await store.branches(r.ref)).map((b) => b.name)).toEqual([
      'main',
      ...Array.from({ length: 6 }, (_, i) => `work/b${i}`),
    ]);
  });
  it('a refused commit writes nothing: secret, bad path, quota', async () => {
    const r = await newRepo();
    const before = [
      await count(ORG_A, 'vcs_blobs', r.id),
      await count(ORG_A, 'vcs_trees', r.id),
      await count(ORG_A, 'vcs_events', r.id),
    ];
    expect(
      await reason(
        store.commit(
          r.ref,
          'main',
          F({ 'ok.txt': 'fine', 'k.txt': 'key=AKIAABCDEFGHIJKLMNOP' }),
          'm',
        ),
      ),
    ).toBe('secret_detected');
    expect(
      await reason(store.commit(r.ref, 'main', F({ 'ok.txt': 'fine', '../k': 'x' }), 'm')),
    ).toBe('path_rejected');
    expect([
      await count(ORG_A, 'vcs_blobs', r.id),
      await count(ORG_A, 'vcs_trees', r.id),
      await count(ORG_A, 'vcs_events', r.id),
    ]).toEqual(before);
    const small = new PgVersionStore(env.app, { maxRepoBytes: 50 });
    const q2 = await newRepo(ORG_A, 'sa-central', small);
    await small.commit(q2.ref, 'main', F({ a: 'x'.repeat(40) }), 'm1');
    expect(await reason(small.commit(q2.ref, 'main', F({ a: 'y'.repeat(40) }), 'm2'))).toBe(
      'too_large',
    );
    expect(await count(ORG_A, 'vcs_commits', q2.id)).toBe(1);
  });
  it('a retried commit (response lost, branch moved on) returns the original commit; rollback restores a checkpoint as a new commit', async () => {
    const r = await newRepo();
    const base = await store.commit(r.ref, 'main', F({ a: '0' }), 'base');
    await store.tag(r.ref, 'cp-base', base.sha);
    const first = await store.commit(
      r.ref,
      'main',
      F({ a: '1', 'b.bin': Uint8Array.from([0, 1, 2, 255]) }),
      'change',
      { expectedTip: base.sha },
    );
    await store.commit(r.ref, 'main', F({ a: '2' }), 'later', { expectedTip: first.sha });
    expect(
      (
        await store.commit(
          r.ref,
          'main',
          F({ a: '1', 'b.bin': Uint8Array.from([0, 1, 2, 255]) }),
          'change',
          { expectedTip: base.sha },
        )
      ).sha,
    ).toBe(first.sha);
    expect(await count(ORG_A, 'vcs_commits', r.id)).toBe(3);
    const back = await restoreCheckpoint(store, r.ref, 'main', 'cp-base');
    expect(back.parents).toHaveLength(1);
    expect(Object.fromEntries(await store.readTree(r.ref, 'main'))).toEqual({ a: '0' });
    expect((await restoreCheckpoint(store, r.ref, 'main', 'cp-base')).sha).toBe(back.sha);
    expect(await count(ORG_A, 'vcs_commits', r.id)).toBe(4); // history only grows
    expect((await store.log(r.ref, 'main')).map((c) => c.message)).toEqual([
      'Restore cp-base',
      'later',
      'change',
      'base',
    ]);
    expect([...(await store.readFiles(r.ref, first.sha)).get('b.bin')!]).toEqual([0, 1, 2, 255]);
  });
  it('the same history on PostgreSQL and on the memory store gives the same ids, log and diff', async () => {
    const mem = new MemoryVersionStore();
    const mref = `${randomUUID()}/${randomUUID()}.git`;
    await mem.init(mref);
    const r = await newRepo();
    const snaps = [
      F({ 'a/x.ts': 'x\n', 'b.md': '# b\n', 'a.b': 'dot' }),
      F({ 'a/x.ts': 'x2\n', 'c/new.ts': 'n\n', 'a.b': 'dot' }),
      F({ 'c/new.ts': 'n\n', z: '' }),
    ];
    const shas: string[][] = [[], []];
    for (const [i, s] of snaps.entries())
      for (const [k, [st, ref]] of (
        [
          [store, r.ref],
          [mem, mref],
        ] as const
      ).entries())
        shas[k]!.push(
          (
            await st.commit(ref, 'main', s, `step ${i}`, {
              at: new Date(1_800_000_000_000 + i * 60_000),
            })
          ).sha,
        );
    expect(shas[0]).toEqual(shas[1]);
    expect(await store.log(r.ref, 'main')).toEqual(await mem.log(mref, 'main'));
    expect(await store.diff(r.ref, shas[0]![0]!, shas[0]![2]!)).toEqual(
      await mem.diff(mref, shas[1]![0]!, shas[1]![2]!),
    );
  });
  it('a stored object changed behind the store’s back is detected and never returned', async () => {
    const r = await newRepo();
    const c = await store.commit(r.ref, 'main', F({ 'a.txt': 'genuine\n' }), 'm');
    const [f] = await store.listTree(r.ref, c.sha);
    await env.sql('ALTER TABLE builder.vcs_blobs DISABLE TRIGGER vcs_blobs_immutable');
    try {
      await env.sql(
        `UPDATE builder.vcs_blobs SET content = convert_to('forged!!', 'UTF8') WHERE repo_id = $1 AND oid = $2`,
        [r.id, f!.oid],
      );
    } finally {
      await env.sql('ALTER TABLE builder.vcs_blobs ENABLE TRIGGER vcs_blobs_immutable');
    }
    expect(await reason(store.readTree(r.ref, c.sha))).toBe('corrupt_object');
  });
});

describe('audit, journal, residency and data region', () => {
  it('journals every mutation atomically and sends audit events; reads and replays add nothing', async () => {
    const before = audit.events.length;
    const r = await newRepo();
    const actor = { actorUserId: SEED_USER, traceId: 'trace-xyz' };
    const c = await store.commit(r.ref, 'main', F({ a: 'x' }), 'first', actor);
    await store.commit(r.ref, 'main', F({ a: 'x' }), 'first', { ...actor, expectedTip: null });
    await store.tag(r.ref, 'cp-first', c.sha, actor);
    await store.readTree(r.ref, 'main');
    const rows = (
      await q(
        ORG_A,
        `SELECT action, ref_name, commit_oid, actor_user_id, trace_id, data_region FROM builder.vcs_events WHERE repo_id = $1 ORDER BY created_at, id`,
        [r.id],
      )
    ).rows;
    expect(rows.map((x) => x.action)).toEqual([
      'repo.initialised',
      'commit.created',
      'checkpoint.created',
    ]);
    expect(rows[1]).toMatchObject({
      ref_name: 'refs/heads/main',
      commit_oid: c.sha,
      actor_user_id: SEED_USER,
      trace_id: 'trace-xyz',
      data_region: 'sa-central',
    });
    expect(audit.events.slice(before).map((e) => e.action)).toEqual([
      'builder.version.repo_initialised',
      'builder.version.committed',
      'builder.version.checkpointed',
    ]);
    expect(audit.events.at(-2)).toMatchObject({
      orgId: ORG_A,
      actorUserId: SEED_USER,
      traceId: 'trace-xyz',
      resource: { type: 'builder_project', id: r.project },
    });
    expect(JSON.stringify(audit.events.slice(before))).not.toContain('"x"');
  });
  it('every object row carries the repository’s data region', async () => {
    const r = await newRepo(ORG_A, 'eu-west');
    await store.commit(r.ref, 'main', F({ 'a/b.txt': 'x' }), 'm');
    for (const t of [
      'vcs_repo_state',
      'vcs_blobs',
      'vcs_trees',
      'vcs_commits',
      'vcs_refs',
      'vcs_events',
    ])
      expect(
        (await q(ORG_A, `SELECT DISTINCT data_region FROM builder.${t} WHERE repo_id = $1`, [r.id]))
          .rows,
        t,
      ).toEqual([{ data_region: 'eu-west' }]);
  });
  it('residency is asked before a repository is placed; a denial leaves no state row', async () => {
    const seen: unknown[] = [];
    const deny = new PgVersionStore(env.app, {
      residency: {
        evaluate: async (req) => (
          seen.push(req),
          {
            decision: 'deny' as const,
            reasons: [{ code: 'r', message: { ar: 'x', en: 'x' } }],
            policyVersion: 1,
            floorVersion: 1,
            assessmentId: null,
            evidenceRef: 'e',
          }
        ),
      },
    });
    const project = randomUUID();
    const ref = `${ORG_A}/${project}.git`;
    const id = randomUUID();
    await q(
      ORG_A,
      `INSERT INTO builder.git_repos (id, org_id, project_id, storage_ref, data_region) VALUES ($1,$2,$3,$4,'sa-central')`,
      [id, ORG_A, project, ref],
    );
    expect(await reason(deny.init(ref))).toBe('residency_denied');
    expect(seen[0]).toMatchObject({
      orgId: ORG_A,
      dataClass: 'customer-content',
      targetRegion: 'sa-central',
      purpose: 'builder_version_store',
      operation: 'write',
    });
    expect(await count(ORG_A, 'vcs_repo_state', id)).toBe(0);
    await store.init(ref); // allowed by the normal store
    expect(await count(ORG_A, 'vcs_repo_state', id)).toBe(1);
  });
  it('init needs the repository registered in builder.git_repos', async () => {
    expect(await reason(store.init(`${ORG_A}/${randomUUID()}.git`))).toBe('not_initialised');
  });
});

describe('load: structural sharing, size caps, many repositories', () => {
  it('150 commits of a 300-file project that change 3 files each store only the new blobs and stay fast', async () => {
    const r = await newRepo();
    const files = new Map(
      Array.from(
        { length: 300 },
        (_, i) =>
          [
            `src/m${i % 20}/f${i}.ts`,
            `export const v${i} = ${i};\n${'// filler\n'.repeat(40)}`,
          ] as const,
      ),
    );
    const t0 = Date.now();
    let first = 0;
    for (let n = 0; n < 150; n++) {
      for (let k = 0; k < 3; k++)
        files.set(`src/m${k}/f${k}.ts`, `export const v${k} = ${n};\n${'// filler\n'.repeat(40)}`);
      const t = Date.now();
      await store.commit(r.ref, 'main', files, `c${n}`, {
        at: new Date(1_800_000_000_000 + n * 1000),
      });
      if (n === 0) first = Date.now() - t;
    }
    const total = Date.now() - t0;
    expect(await count(ORG_A, 'vcs_commits', r.id)).toBe(150);
    expect(await count(ORG_A, 'vcs_blobs', r.id)).toBe(297 + 150 * 3); // 297 untouched files once, the 3 edited files once per commit
    const log = await store.log(r.ref, 'main', 200);
    expect(log).toHaveLength(150);
    expect(log[0]!.message).toBe('c149');
    expect((await store.readTree(r.ref, 'main')).get('src/m0/f0.ts')).toContain('= 149;');
    process.stdout.write(
      `[load] 150 commits x 300 files: total ${total} ms, first ${first} ms, mean ${(total / 150).toFixed(1)} ms\n`,
    );
    expect(total).toBeLessThan(120_000);
  }, 180_000);
  it('one commit of 2 000 files (about 7 MB) and the caps around it', async () => {
    const r = await newRepo();
    const big = new Map(
      Array.from(
        { length: 2000 },
        (_, i) => [`d${i % 40}/file${i}.txt`, `${i}`.repeat(1000)] as const,
      ),
    );
    const t = Date.now();
    await store.commit(r.ref, 'main', big, 'big');
    const ms = Date.now() - t;
    expect((await store.readTree(r.ref, 'main')).size).toBe(2000);
    process.stdout.write(`[load] 1 commit x 2000 files (~7 MB): ${ms} ms\n`);
    expect(
      await reason(
        store.commit(
          r.ref,
          'main',
          new Map(Array.from({ length: 5001 }, (_, i) => [`f${i}`, 'x'] as const)),
          'x',
        ),
      ),
    ).toBe('too_large');
    expect(await reason(store.commit(r.ref, 'main', F({ big: 'x'.repeat(1_000_001) }), 'x'))).toBe(
      'too_large',
    );
  }, 120_000);
  it('20 repositories with 8 commits each, written concurrently', async () => {
    const repos = await Promise.all(Array.from({ length: 20 }, () => newRepo()));
    const t = Date.now();
    await Promise.all(
      repos.map(async (r) => {
        for (let n = 0; n < 8; n++)
          await store.commit(
            r.ref,
            'main',
            F({ 'a.txt': `v${n}`, 'dir/b.txt': `${r.id}-${n}` }),
            `m${n}`,
          );
      }),
    );
    process.stdout.write(`[load] 20 repos x 8 commits concurrently: ${Date.now() - t} ms\n`);
    for (const r of repos) expect((await store.log(r.ref, 'main')).length).toBe(8);
  }, 120_000);
});
