import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import { newId } from '../core';
import type { TreeEntry } from './git-object';
import type {
  BlobMeta,
  ObjectBackend,
  ObjectTx,
  ParsedRef,
  RepoHandle,
  StoredBlob,
  StoredCommit,
  StoredTree,
  StoreEvent,
} from './object-backend';
import { ObjectVersionStore, type ObjectStoreOptions } from './object-version-store';
import { VersionStoreError } from './version-store.port';

type Row = Record<string, unknown>;
const MAX_BATCH_BYTES = 8_000_000;
const MAX_BATCH_ROWS = 200;

const toCommit = (r: Row): StoredCommit => {
  const author = String(r.author);
  const m = /^(.*) <([^<>]*)>$/.exec(author);
  return {
    oid: String(r.oid),
    tree: String(r.tree_oid),
    parents: (r.parents as string[]) ?? [],
    authorName: m ? m[1]! : author,
    authorEmail: m ? m[2]! : '',
    at: r.committed_at as Date,
    message: String(r.message),
    replayKey: String(r.replay_key),
  };
};
const COMMIT_COLS = 'oid, tree_oid, parents, author, committed_at, message, replay_key';

class PgTx implements ObjectTx {
  constructor(
    private readonly c: PoolClient,
    readonly repo: RepoHandle,
  ) {}
  private get ids(): [string, string] {
    return [this.repo.repoId, this.repo.orgId];
  }

  async lock() {
    const r = await this.c.query(
      `SELECT stored_bytes FROM builder.vcs_repo_state WHERE repo_id = $1 FOR UPDATE`,
      [this.repo.repoId],
    );
    return { storedBytes: Number((r.rows[0] as Row | undefined)?.stored_bytes ?? 0) };
  }
  async existingBlobs(oids: string[]) {
    if (!oids.length) return new Set<string>();
    const r = await this.c.query(
      `SELECT oid FROM builder.vcs_blobs WHERE repo_id = $1 AND oid = ANY($2::text[])`,
      [this.repo.repoId, oids],
    );
    return new Set((r.rows as Row[]).map((x) => String(x.oid)));
  }
  async insertBlobs(blobs: StoredBlob[]) {
    let batch: StoredBlob[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const params: unknown[] = [];
      // column order: repo_id, org_id, oid, sha256, size, is_binary, content, data_region (8 placeholders per row)
      const ph = batch.map((b, i) => {
        params.push(
          ...this.ids,
          b.oid,
          b.sha256,
          b.size,
          b.binary,
          b.content,
          this.repo.dataRegion,
        );
        const o = i * 8;
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
      });
      await this.c.query(
        `INSERT INTO builder.vcs_blobs (repo_id, org_id, oid, sha256, size, is_binary, content, data_region) VALUES ${ph.join(',')} ON CONFLICT (repo_id, oid) DO NOTHING`,
        params,
      );
      batch = [];
      bytes = 0;
    };
    for (const b of blobs) {
      if (batch.length >= MAX_BATCH_ROWS || bytes + b.size > MAX_BATCH_BYTES) await flush();
      batch.push(b);
      bytes += b.size;
    }
    await flush();
  }
  async getBlobs(oids: string[]) {
    const out = new Map<string, StoredBlob>();
    if (!oids.length) return out;
    const r = await this.c.query(
      `SELECT oid, sha256, size, is_binary, content FROM builder.vcs_blobs WHERE repo_id = $1 AND oid = ANY($2::text[])`,
      [this.repo.repoId, oids],
    );
    for (const x of r.rows as Row[])
      out.set(String(x.oid), {
        oid: String(x.oid),
        sha256: String(x.sha256),
        size: Number(x.size),
        binary: Boolean(x.is_binary),
        content: x.content as Buffer,
      });
    return out;
  }
  async getBlobMeta(oids: string[]) {
    const out = new Map<string, BlobMeta>();
    if (!oids.length) return out;
    const r = await this.c.query(
      `SELECT oid, size, is_binary FROM builder.vcs_blobs WHERE repo_id = $1 AND oid = ANY($2::text[])`,
      [this.repo.repoId, oids],
    );
    for (const x of r.rows as Row[])
      out.set(String(x.oid), {
        oid: String(x.oid),
        size: Number(x.size),
        binary: Boolean(x.is_binary),
      });
    return out;
  }
  async insertTrees(trees: StoredTree[]) {
    for (let i = 0; i < trees.length; i += MAX_BATCH_ROWS) {
      const part = trees.slice(i, i + MAX_BATCH_ROWS);
      const params: unknown[] = [];
      const ph = part.map((t, k) => {
        params.push(
          ...this.ids,
          t.oid,
          JSON.stringify(t.entries.map((e) => [e.name, e.mode, e.oid])),
          this.repo.dataRegion,
        );
        const o = k * 5;
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4}::jsonb,$${o + 5})`;
      });
      await this.c.query(
        `INSERT INTO builder.vcs_trees (repo_id, org_id, oid, entries, data_region) VALUES ${ph.join(',')} ON CONFLICT (repo_id, oid) DO NOTHING`,
        params,
      );
    }
  }
  async getTrees(oids: string[]) {
    const out = new Map<string, StoredTree>();
    if (!oids.length) return out;
    const r = await this.c.query(
      `SELECT oid, entries FROM builder.vcs_trees WHERE repo_id = $1 AND oid = ANY($2::text[])`,
      [this.repo.repoId, oids],
    );
    for (const x of r.rows as Row[])
      out.set(String(x.oid), {
        oid: String(x.oid),
        entries: (x.entries as [string, string, string][]).map(([name, mode, oid]): TreeEntry => ({
          name,
          mode: mode as TreeEntry['mode'],
          oid,
        })),
      });
    return out;
  }
  async insertCommit(c: StoredCommit) {
    await this.c.query(
      `INSERT INTO builder.vcs_commits (repo_id, org_id, oid, tree_oid, parents, author, committed_at, message, replay_key, data_region)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10) ON CONFLICT (repo_id, oid) DO NOTHING`,
      [
        ...this.ids,
        c.oid,
        c.tree,
        c.parents,
        `${c.authorName} <${c.authorEmail}>`,
        c.at,
        c.message,
        c.replayKey,
        this.repo.dataRegion,
      ],
    );
  }
  async getCommits(oids: string[]) {
    const out = new Map<string, StoredCommit>();
    if (!oids.length) return out;
    const r = await this.c.query(
      `SELECT ${COMMIT_COLS} FROM builder.vcs_commits WHERE repo_id = $1 AND oid = ANY($2::text[])`,
      [this.repo.repoId, oids],
    );
    for (const x of r.rows as Row[]) out.set(String(x.oid), toCommit(x));
    return out;
  }
  async firstParentChain(oid: string, n: number) {
    const r = await this.c.query(
      `WITH RECURSIVE h AS (
         SELECT ${COMMIT_COLS}, 1 AS n FROM builder.vcs_commits WHERE repo_id = $1 AND oid = $2
         UNION ALL
         SELECT ${COMMIT_COLS.split(', ')
           .map((c) => `c.${c}`)
           .join(', ')}, h.n + 1
           FROM builder.vcs_commits c JOIN h ON c.repo_id = $1 AND c.oid = h.parents[1] WHERE h.n < $3
       ) SELECT ${COMMIT_COLS} FROM h ORDER BY n`,
      [this.repo.repoId, oid, n],
    );
    return (r.rows as Row[]).map(toCommit);
  }
  async findReplay(replayKey: string) {
    const r = await this.c.query(
      `SELECT ${COMMIT_COLS} FROM builder.vcs_commits WHERE repo_id = $1 AND replay_key = $2 ORDER BY created_at, oid LIMIT 1`,
      [this.repo.repoId, replayKey],
    );
    return r.rows[0] ? toCommit(r.rows[0] as Row) : null;
  }
  async getRef(name: string) {
    const r = await this.c.query(
      `SELECT oid FROM builder.vcs_refs WHERE repo_id = $1 AND name = $2`,
      [this.repo.repoId, name],
    );
    return r.rows[0] ? String((r.rows[0] as Row).oid) : null;
  }
  async listRefs(prefix: string) {
    const r = await this.c.query(
      `SELECT name, oid FROM builder.vcs_refs WHERE repo_id = $1 AND starts_with(name, $2) ORDER BY name COLLATE "C"`,
      [this.repo.repoId, prefix],
    );
    return (r.rows as Row[]).map((x) => ({ name: String(x.name), oid: String(x.oid) }));
  }
  async createRef(name: string, oid: string) {
    const r = await this.c.query(
      `INSERT INTO builder.vcs_refs (repo_id, org_id, name, oid, data_region) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (repo_id, name) DO NOTHING`,
      [...this.ids, name, oid, this.repo.dataRegion],
    );
    return r.rowCount === 1;
  }
  async moveRef(name: string, expected: string, next: string) {
    const r = await this.c.query(
      `UPDATE builder.vcs_refs SET oid = $3 WHERE repo_id = $1 AND name = $2 AND oid = $4`,
      [this.repo.repoId, name, next, expected],
    );
    return r.rowCount === 1;
  }
  async addStoredBytes(n: number) {
    if (n > 0)
      await this.c.query(
        `UPDATE builder.vcs_repo_state SET stored_bytes = stored_bytes + $2 WHERE repo_id = $1`,
        [this.repo.repoId, n],
      );
  }
  async appendEvent(e: StoreEvent) {
    await this.c.query(
      `INSERT INTO builder.vcs_events (id, org_id, repo_id, action, ref_name, commit_oid, actor_user_id, trace_id, detail, data_region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        newId(),
        this.repo.orgId,
        this.repo.repoId,
        e.action,
        e.refName ?? null,
        e.commitOid ?? null,
        e.actorUserId ?? null,
        e.traceId?.slice(0, 100) ?? null,
        JSON.stringify(e.detail ?? {}),
        this.repo.dataRegion,
      ],
    );
  }
}

/** PostgreSQL storage: every operation is one `withOrg` transaction (RLS context from the reference), writers serialised by the repository's state row. */
export class PgBackend implements ObjectBackend {
  constructor(private readonly db: Db) {}

  async ensureRepo(
    ref: ParsedRef,
    beforeCreate?: (dataRegion: string) => Promise<void>,
    actor: { actorUserId?: string; traceId?: string } = {},
  ) {
    return this.db.withOrg(ref.orgId, async (c) => {
      const g = await c.query(
        `SELECT id, data_region FROM builder.git_repos WHERE org_id = $1 AND storage_ref = $2`,
        [ref.orgId, ref.ref],
      );
      const row = g.rows[0] as Row | undefined;
      if (!row)
        throw new VersionStoreError(
          'the repository is not registered',
          'bad_ref',
          'not_initialised',
        );
      const handle: RepoHandle = {
        repoId: String(row.id),
        orgId: ref.orgId,
        dataRegion: String(row.data_region),
      };
      const have = await c.query(`SELECT 1 FROM builder.vcs_repo_state WHERE repo_id = $1`, [
        handle.repoId,
      ]);
      if (have.rowCount) return { created: false, dataRegion: handle.dataRegion };
      await beforeCreate?.(handle.dataRegion);
      const ins = await c.query(
        `INSERT INTO builder.vcs_repo_state (repo_id, org_id, data_region) VALUES ($1,$2,$3) ON CONFLICT (repo_id) DO NOTHING`,
        [handle.repoId, handle.orgId, handle.dataRegion],
      );
      if (ins.rowCount === 1)
        await new PgTx(c, handle).appendEvent({
          action: 'repo.initialised',
          ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
          ...(actor.traceId ? { traceId: actor.traceId } : {}),
        });
      return { created: ins.rowCount === 1, dataRegion: handle.dataRegion };
    });
  }

  withTx<T>(ref: ParsedRef, _write: boolean, fn: (tx: ObjectTx | null) => Promise<T>): Promise<T> {
    return this.db.withOrg(ref.orgId, async (c) => {
      const r = await c.query(
        `SELECT g.id, g.data_region FROM builder.git_repos g JOIN builder.vcs_repo_state s ON s.repo_id = g.id
          WHERE g.org_id = $1 AND g.storage_ref = $2`,
        [ref.orgId, ref.ref],
      );
      const row = r.rows[0] as Row | undefined;
      if (!row) return fn(null);
      return fn(
        new PgTx(c, {
          repoId: String(row.id),
          orgId: ref.orgId,
          dataRegion: String(row.data_region),
        }),
      );
    });
  }
}

export class PgVersionStore extends ObjectVersionStore {
  constructor(db: Db, opts: ObjectStoreOptions = {}) {
    super(new PgBackend(db), opts);
  }
}
