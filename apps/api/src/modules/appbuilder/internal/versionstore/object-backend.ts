import type { NewBlob, TreeEntry } from './git-object';

/** A repository reference `<org uuid>/<project uuid>.git`, parsed. The organisation comes from the reference the call site read under verified auth. */
export interface ParsedRef {
  ref: string;
  orgId: string;
  projectId: string;
}
export interface RepoHandle {
  repoId: string;
  orgId: string;
  dataRegion: string;
}
export type StoredBlob = NewBlob;
export interface BlobMeta {
  oid: string;
  size: number;
  binary: boolean;
}
export interface StoredTree {
  oid: string;
  entries: TreeEntry[];
}
export interface StoredCommit {
  oid: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** whole seconds */
  at: Date;
  /** exactly as hashed (truncated to the cap, without the completed trailing newline) */
  message: string;
  /** sha256(parent0 | tree | message): identifies a replay of the same request */
  replayKey: string;
}
export interface StoreEvent {
  action:
    'repo.initialised' | 'commit.created' | 'ref.moved' | 'checkpoint.created' | 'remote_ref.set';
  refName?: string;
  commitOid?: string;
  actorUserId?: string;
  traceId?: string;
  detail?: Record<string, unknown>;
}

/** Storage primitives inside ONE repository and ONE transaction. Everything the store needs, nothing git-specific. */
export interface ObjectTx {
  readonly repo: RepoHandle;
  /** Serialises writers of this repository (a row lock in PostgreSQL) and returns the quota counters. */
  lock(): Promise<{ storedBytes: number }>;
  existingBlobs(oids: string[]): Promise<Set<string>>;
  insertBlobs(blobs: StoredBlob[]): Promise<void>;
  getBlobs(oids: string[]): Promise<Map<string, StoredBlob>>;
  getBlobMeta(oids: string[]): Promise<Map<string, BlobMeta>>;
  insertTrees(trees: StoredTree[]): Promise<void>;
  getTrees(oids: string[]): Promise<Map<string, StoredTree>>;
  insertCommit(c: StoredCommit): Promise<void>;
  getCommits(oids: string[]): Promise<Map<string, StoredCommit>>;
  /** Up to `n` commits following first parents from `oid` (inclusive): a prefetch for `log`. */
  firstParentChain(oid: string, n: number): Promise<StoredCommit[]>;
  findReplay(replayKey: string): Promise<StoredCommit | null>;
  getRef(name: string): Promise<string | null>;
  /** Sorted by name (byte order). */
  listRefs(prefix: string): Promise<{ name: string; oid: string }[]>;
  /** false when the reference already exists. */
  createRef(name: string, oid: string): Promise<boolean>;
  /** compare-and-swap; false when the reference does not hold `expected`. */
  moveRef(name: string, expected: string, next: string): Promise<boolean>;
  addStoredBytes(n: number): Promise<void>;
  appendEvent(e: StoreEvent): Promise<void>;
}

export interface ObjectBackend {
  /** Registers the repository for the store. `beforeCreate` runs (with the repository's data region) only when it is new, before anything is written. */
  ensureRepo(
    ref: ParsedRef,
    beforeCreate?: (dataRegion: string) => Promise<void>,
    actor?: { actorUserId?: string; traceId?: string },
  ): Promise<{ created: boolean; dataRegion: string }>;
  /** `fn` receives null when the repository is not registered. A write transaction is atomic and serialised per repository. */
  withTx<T>(ref: ParsedRef, write: boolean, fn: (tx: ObjectTx | null) => Promise<T>): Promise<T>;
}
