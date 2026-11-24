import { GitError } from '../git/git.store';

/**
 * The version-store port (P3-S09). It is exactly the surface the call sites of `GitStore` use today (`ChangeService`, the build harness), so the host-git
 * implementation (dev/test) and the PostgreSQL implementation (production) are interchangeable by configuration. No implementation behind this port may start a
 * subprocess on the application host, except `GitStore`, which exists only for development and is refused in production (see `select-version-store.ts`).
 */
export interface CommitInfo {
  sha: string;
  parents: string[];
  /** The subject (first paragraph) like `git log --format=%s`. */
  message: string;
  author: string;
  at: string;
}
export interface TreeDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Unified text diff, capped (`PATCH_CAP`); binary files are reported, not printed. */
  patch: string;
  /** Exact-content renames (same blob under a deleted and an added path). Additive: the three lists above are unchanged. Absent on `GitStore`. */
  renamed?: { from: string; to: string }[];
}
export type FileContent = string | Uint8Array;
export interface CommitOptions {
  /** Compare-and-swap: the branch must still point here (`null` = must not exist yet), else `stale_ref`. */
  expectedTip?: string | null;
  /** Commit time; with the same snapshot, parent and message it yields the same commit id. */
  at?: Date;
  /** Parent other than the branch tip (e.g. a work branch started from a checkpoint). `null` = a root commit. */
  parentOverride?: string | null;
  /** Recorded in the version-store journal and the audit event (never part of the commit id). */
  actorUserId?: string;
  traceId?: string;
}

export const BRANCH = /^[a-z][a-z0-9/_-]{0,60}$/;
export const TAG = /^cp-[0-9a-z][0-9a-z-]{0,60}$/;
export const SHA = /^[0-9a-f]{40}$/;
export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const PATCH_CAP = 200_000;
export const MAX_SNAPSHOT_FILES = 5_000;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_SNAPSHOT_BYTES = 50_000_000;
export const MAX_REPO_BYTES = 200_000_000;
export const MAX_MESSAGE_CHARS = 2_000;
/** Same shape `ChangeService` stores in `builder.git_repos.storage_ref`: `<org uuid>/<project uuid>.git`. */
export const REPO_REF = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.git$/;

export type VersionStoreErrorReason =
  | 'bad_ref'
  | 'stale_ref'
  | 'path_rejected'
  | 'too_large'
  | 'secret_detected'
  | 'corrupt_object'
  | 'unknown_revision'
  | 'residency_denied'
  | 'not_initialised'
  | 'git_failed';

/** Extends `GitError`, so `instanceof GitError` at the existing call sites keeps working; `reason` is the finer classification. */
export class VersionStoreError extends GitError {
  constructor(
    message: string,
    code: 'bad_ref' | 'stale_ref' | 'git_failed',
    readonly reason: VersionStoreErrorReason = code,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message, code);
    this.name = 'VersionStoreError';
  }
}

export interface VersionStore {
  init(ref: string): Promise<void>;
  /** Writes `files` as a full snapshot and commits it on `branch` (created on first use). */
  commit(
    ref: string,
    branch: string,
    files: ReadonlyMap<string, FileContent>,
    message: string,
    o?: CommitOptions,
  ): Promise<CommitInfo>;
  tipOf(ref: string, fullRef: string): Promise<string | null>;
  branches(ref: string): Promise<{ name: string; sha: string }[]>;
  /** Checkpoints are `cp-<name>` references to a commit; creating one that exists is a `stale_ref`. */
  tag(ref: string, name: string, sha: string): Promise<void>;
  checkpoints(ref: string): Promise<{ name: string; sha: string }[]>;
  log(ref: string, rev: string, limit?: number): Promise<CommitInfo[]>;
  /** The files of a commit (or branch/checkpoint) as text. */
  readTree(ref: string, rev: string): Promise<Map<string, string>>;
  diff(ref: string, a: string, b: string): Promise<TreeDiff>;
}

export interface TreeFileInfo {
  path: string;
  oid: string;
  size: number;
  binary: boolean;
}
/** Additive operations of the database-backed stores (not on `GitStore`). */
export interface VersionStoreExt extends VersionStore {
  resolve(ref: string, rev: string): Promise<string | null>;
  listTree(ref: string, rev: string): Promise<TreeFileInfo[]>;
  /** Exact bytes, for binary files. */
  readFiles(ref: string, rev: string): Promise<Map<string, Uint8Array>>;
  /** Mirror of a remote branch (`refs/remotes/<remote>/<branch>`); never used as a write target. */
  setRemoteRef(
    ref: string,
    remote: string,
    branch: string,
    sha: string,
    o?: { actorUserId?: string; traceId?: string; detail?: Record<string, unknown> },
  ): Promise<void>;
  getRemoteRef(ref: string, remote: string, branch: string): Promise<string | null>;
}

/**
 * Rollback = a NEW commit on `branch` whose tree is the checkpoint's tree. History is never rewritten and nothing is deleted. Works on every store.
 * Idempotent: when the branch already has the checkpoint's content, the tip commit is returned and nothing is written.
 */
export async function restoreCheckpoint(
  store: VersionStore,
  ref: string,
  branch: string,
  checkpoint: string,
  message?: string,
  o: CommitOptions = {},
): Promise<CommitInfo> {
  if (!TAG.test(checkpoint)) throw new VersionStoreError('invalid checkpoint name', 'bad_ref');
  const cp = (await store.checkpoints(ref)).find((c) => c.name === checkpoint);
  if (!cp) throw new VersionStoreError('unknown checkpoint', 'bad_ref', 'unknown_revision');
  // Already there (a retry of a restore that succeeded): the branch tip has the checkpoint's content, so there is nothing to write.
  const tip = await store.tipOf(ref, `refs/heads/${branch}`);
  if (tip) {
    const d = await store.diff(ref, tip, cp.sha);
    if (!d.added.length && !d.modified.length && !d.deleted.length) {
      const [head] = await store.log(ref, tip, 1);
      if (head) return head;
    }
  }
  // exact bytes where the store has them (binary files survive a rollback), text otherwise
  const ext = store as Partial<VersionStoreExt>;
  const files: ReadonlyMap<string, FileContent> = ext.readFiles
    ? await ext.readFiles(ref, cp.sha)
    : await store.readTree(ref, cp.sha);
  return store.commit(ref, branch, files, message ?? `Restore ${checkpoint}`, {
    ...o,
    expectedTip:
      o.expectedTip !== undefined ? o.expectedTip : await store.tipOf(ref, `refs/heads/${branch}`),
  });
}
