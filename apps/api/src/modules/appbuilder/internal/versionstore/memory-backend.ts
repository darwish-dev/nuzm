import { randomUUID } from 'node:crypto';
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

interface Repo {
  handle: RepoHandle;
  blobs: Map<string, StoredBlob>;
  trees: Map<string, StoredTree>;
  commits: Map<string, StoredCommit>;
  replay: Map<string, string>;
  refs: Map<string, string>;
  storedBytes: number;
  events: (StoreEvent & { at: Date })[];
  /** serialises write transactions */
  tail: Promise<void>;
}

/** In-memory storage for unit tests and local tooling: same core logic, no database. Never used in production (see `select-version-store.ts`). */
export class MemoryBackend implements ObjectBackend {
  private readonly repos = new Map<string, Repo>();
  /** orgs for which `ref` org segment is allowed; empty = any (tests of tenant isolation use separate stores or refs) */
  constructor(private readonly region = 'memory') {}

  ensureRepo(
    ref: ParsedRef,
    beforeCreate?: (dataRegion: string) => Promise<void>,
    actor: { actorUserId?: string; traceId?: string } = {},
  ) {
    return (async () => {
      if (this.repos.has(ref.ref)) return { created: false, dataRegion: this.region };
      await beforeCreate?.(this.region);
      const repo: Repo = {
        handle: { repoId: randomUUID(), orgId: ref.orgId, dataRegion: this.region },
        blobs: new Map(),
        trees: new Map(),
        commits: new Map(),
        replay: new Map(),
        refs: new Map(),
        storedBytes: 0,
        events: [{ action: 'repo.initialised', ...actor, at: new Date() }],
        tail: Promise.resolve(),
      };
      this.repos.set(ref.ref, repo);
      return { created: true, dataRegion: this.region };
    })();
  }

  eventsOf(ref: string): (StoreEvent & { at: Date })[] {
    return this.repos.get(ref)?.events ?? [];
  }
  /** Test hook: overwrite a stored blob (simulates storage corruption). */
  corruptBlob(ref: string, oid: string, content: Buffer): void {
    const b = this.repos.get(ref)?.blobs.get(oid);
    if (b) b.content = content;
  }
  tamperRef(ref: string, name: string, oid: string): void {
    this.repos.get(ref)?.refs.set(name, oid);
  }

  async withTx<T>(
    ref: ParsedRef,
    write: boolean,
    fn: (tx: ObjectTx | null) => Promise<T>,
  ): Promise<T> {
    const repo = this.repos.get(ref.ref);
    if (!repo) return fn(null);
    if (!write) return fn(this.tx(repo));
    const prev = repo.tail;
    let release!: () => void;
    repo.tail = new Promise<void>((r) => (release = r));
    await prev;
    // Atomic like a database transaction: a failure leaves the repository as it was.
    const snapshot = {
      blobs: new Map(repo.blobs),
      trees: new Map(repo.trees),
      commits: new Map(repo.commits),
      replay: new Map(repo.replay),
      refs: new Map(repo.refs),
      storedBytes: repo.storedBytes,
      events: [...repo.events],
    };
    try {
      return await fn(this.tx(repo));
    } catch (e) {
      Object.assign(repo, snapshot);
      throw e;
    } finally {
      release();
    }
  }

  private tx(repo: Repo): ObjectTx {
    const pick = <V>(m: Map<string, V>, oids: string[]) => {
      const out = new Map<string, V>();
      for (const o of oids) {
        const v = m.get(o);
        if (v) out.set(o, v);
      }
      return out;
    };
    return {
      repo: repo.handle,
      lock: async () => ({ storedBytes: repo.storedBytes }),
      existingBlobs: async (oids) => new Set(oids.filter((o) => repo.blobs.has(o))),
      insertBlobs: async (blobs) => {
        for (const b of blobs) if (!repo.blobs.has(b.oid)) repo.blobs.set(b.oid, { ...b });
      },
      getBlobs: async (oids) => pick(repo.blobs, oids),
      getBlobMeta: async (oids) => {
        const out = new Map<string, BlobMeta>();
        for (const o of oids) {
          const b = repo.blobs.get(o);
          if (b) out.set(o, { oid: o, size: b.size, binary: b.binary });
        }
        return out;
      },
      insertTrees: async (trees) => {
        for (const t of trees) if (!repo.trees.has(t.oid)) repo.trees.set(t.oid, t);
      },
      getTrees: async (oids) => pick(repo.trees, oids),
      insertCommit: async (c) => {
        if (!repo.commits.has(c.oid)) repo.commits.set(c.oid, c);
        if (!repo.replay.has(c.replayKey)) repo.replay.set(c.replayKey, c.oid);
      },
      getCommits: async (oids) => pick(repo.commits, oids),
      firstParentChain: async (oid, n) => {
        const out: StoredCommit[] = [];
        let cur = repo.commits.get(oid);
        while (cur && out.length < n) {
          out.push(cur);
          const p = cur.parents[0];
          cur = p ? repo.commits.get(p) : undefined;
        }
        return out;
      },
      findReplay: async (key) => {
        const o = repo.replay.get(key);
        return o ? (repo.commits.get(o) ?? null) : null;
      },
      getRef: async (name) => repo.refs.get(name) ?? null,
      listRefs: async (prefix) =>
        [...repo.refs]
          .filter(([n]) => n.startsWith(prefix))
          .map(([name, oid]) => ({ name, oid }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      createRef: async (name, oid) => {
        if (repo.refs.has(name)) return false;
        repo.refs.set(name, oid);
        return true;
      },
      moveRef: async (name, expected, next) => {
        if (name.startsWith('refs/tags/')) return false; // checkpoints are immutable
        if (repo.refs.get(name) !== expected) return false;
        repo.refs.set(name, next);
        return true;
      },
      addStoredBytes: async (n) => {
        repo.storedBytes += n;
      },
      appendEvent: async (e) => {
        repo.events.push({ ...e, at: new Date() });
      },
    };
  }
}

export class MemoryVersionStore extends ObjectVersionStore {
  readonly memory: MemoryBackend;
  constructor(opts: ObjectStoreOptions = {}, region?: string) {
    const backend = new MemoryBackend(region);
    super(backend, opts);
    this.memory = backend;
  }
  events(ref: string) {
    return this.memory.eventsOf(ref);
  }
}
