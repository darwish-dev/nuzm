import { assertResidency, ResidencyDenied, type ResidencyEvaluator } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { checkPath, scanSecrets } from '../sandbox/paths';
import { fileDiff, renameDiff } from './diff';
import {
  blobOid,
  buildSnapshot,
  commitOid,
  DEFAULT_IDENTITY,
  DIR_MODE,
  FILE_MODE,
  sha256hex,
  subjectOf,
  treeOid,
  type NewBlob,
} from './git-object';
import type {
  ObjectBackend,
  ObjectTx,
  ParsedRef,
  StoredTree,
  StoredCommit,
  StoreEvent,
} from './object-backend';
import {
  BRANCH,
  MAX_FILE_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_REPO_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  PATCH_CAP,
  REPO_REF,
  SHA,
  TAG,
  VersionStoreError,
  type CommitInfo,
  type CommitOptions,
  type FileContent,
  type TreeDiff,
  type TreeFileInfo,
  type VersionStoreExt,
} from './version-store.port';

const REMOTE = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_LOG = 200;
const BLOB_CHUNK = 200;

export interface ObjectStoreOptions {
  audit?: AuditSink;
  /** `assertResidency` is asked before a repository is first registered (CLAUDE.md §4). Absent = not asked (tests only; production wiring passes it). */
  residency?: ResidencyEvaluator;
  now?: () => Date;
  /** Secret scan of new text blobs (default on). */
  scanSecrets?: boolean;
  maxRepoBytes?: number;
}

export function parseRef(ref: string): ParsedRef {
  const m = REPO_REF.exec(ref);
  if (!m) throw new VersionStoreError('invalid repository reference', 'bad_ref');
  return { ref, orgId: m[1]!, projectId: m[2]! };
}
function checkBranch(branch: string): void {
  if (!BRANCH.test(branch) || branch.includes('//') || branch.endsWith('/'))
    throw new VersionStoreError('invalid branch name', 'bad_ref');
}
/** Full reference names the store accepts for `tipOf`. */
function fullRefName(name: string): string | null {
  if (name === 'HEAD') return 'refs/heads/main';
  const m = /^refs\/(heads|tags|remotes\/[a-z][a-z0-9-]{0,30})\/(.+)$/.exec(name);
  if (!m) return null;
  const leaf = m[2]!;
  if (m[1] === 'tags') return TAG.test(leaf) ? name : null;
  return BRANCH.test(leaf) && !leaf.includes('//') && !leaf.endsWith('/') ? name : null;
}
const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const info = (c: StoredCommit): CommitInfo => ({
  sha: c.oid,
  parents: c.parents,
  message: subjectOf(c.message),
  author: c.authorName,
  at: c.at.toISOString(),
});

type FlatFile = { oid: string };

/**
 * All the version-store logic over an `ObjectBackend`: path rules, caps, secret scan, git-compatible hashing, tree building, idempotent replay, compare-and-swap
 * on branches, history walk and diff. It starts no process and touches no file; storage is the backend's business (PostgreSQL in production, memory in tests).
 */
export class ObjectVersionStore implements VersionStoreExt {
  private readonly now: () => Date;
  private readonly maxRepo: number;
  constructor(
    protected readonly backend: ObjectBackend,
    private readonly opts: ObjectStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.maxRepo = opts.maxRepoBytes ?? MAX_REPO_BYTES;
  }

  // ---- audit ---------------------------------------------------------------------------------------------------------------------------
  private async audit(
    r: ParsedRef,
    action: `${string}.${string}.${string}`,
    actor: { actorUserId?: string; traceId?: string },
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.opts.audit?.record({
      action,
      orgId: r.orgId,
      ...(actor.actorUserId
        ? { actorUserId: actor.actorUserId, actorType: 'user' as const }
        : { actorType: 'system' as const }),
      resource: { type: 'builder_project', id: r.projectId },
      outcome: 'success',
      ...(actor.traceId ? { traceId: actor.traceId } : {}),
      after,
    });
  }

  // ---- init ----------------------------------------------------------------------------------------------------------------------------
  async init(ref: string, actor: { actorUserId?: string; traceId?: string } = {}): Promise<void> {
    const r = parseRef(ref);
    let created: { created: boolean; dataRegion: string };
    try {
      created = await this.backend.ensureRepo(
        r,
        this.opts.residency
          ? async (region) => {
              // CLAUDE.md §4: ask the residency policy BEFORE placing customer content
              await assertResidency(this.opts.residency!, {
                orgId: r.orgId,
                dataClass: 'customer-content',
                targetRegion: region,
                purpose: 'builder_version_store',
                operation: 'write',
              });
            }
          : undefined,
        actor,
      );
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new VersionStoreError(
          'the data residency policy does not allow storing this repository',
          'bad_ref',
          'residency_denied',
        );
      throw e;
    }
    if (created.created)
      await this.audit(r, 'builder.version.repo_initialised', actor, {
        region: created.dataRegion,
      });
  }

  // ---- write path ----------------------------------------------------------------------------------------------------------------------
  private prepare(files: ReadonlyMap<string, FileContent>) {
    if (files.size > MAX_SNAPSHOT_FILES)
      throw new VersionStoreError(
        `a snapshot may hold at most ${MAX_SNAPSHOT_FILES} files`,
        'bad_ref',
        'too_large',
      );
    const bytes = new Map<string, Buffer>();
    const firstPath = new Map<string, string>();
    let total = 0;
    for (const [path, content] of files) {
      const err = checkPath(path);
      if (err) throw new VersionStoreError(`${path}: ${err}`, 'bad_ref', 'path_rejected', { path });
      const b = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
      if (b.byteLength > MAX_FILE_BYTES)
        throw new VersionStoreError(
          `${path}: the file is larger than ${MAX_FILE_BYTES} bytes`,
          'bad_ref',
          'too_large',
          { path },
        );
      total += b.byteLength;
      if (total > MAX_SNAPSHOT_BYTES)
        throw new VersionStoreError('the snapshot is too large', 'bad_ref', 'too_large');
      bytes.set(path, b);
    }
    const snap = buildSnapshot(bytes);
    if (snap.clash)
      throw new VersionStoreError(
        `${snap.clash}: a file and a directory share a name`,
        'bad_ref',
        'path_rejected',
        { path: snap.clash },
      );
    for (const [path, b] of bytes) {
      const oid = blobOid(b);
      if (!firstPath.has(oid)) firstPath.set(oid, path);
    }
    return { ...snap, firstPath, fileCount: bytes.size, totalBytes: total };
  }

  private scan(fresh: NewBlob[], pathOf: Map<string, string>): void {
    if (this.opts.scanSecrets === false) return;
    for (const b of fresh) {
      if (b.binary) continue;
      const f = scanSecrets(b.content.toString('utf8'))[0];
      if (f) {
        const path = pathOf.get(b.oid) ?? '?';
        throw new VersionStoreError(
          `${path}: looks like a secret (${f.rule}, line ${f.line}); the matched text is not shown`,
          'bad_ref',
          'secret_detected',
          { path, rule: f.rule, line: f.line },
        );
      }
    }
  }

  async commit(
    ref: string,
    branch: string,
    files: ReadonlyMap<string, FileContent>,
    message: string,
    o: CommitOptions = {},
  ): Promise<CommitInfo> {
    const r = parseRef(ref);
    checkBranch(branch);
    const msg = message.slice(0, MAX_MESSAGE_CHARS);
    if (!msg.trim() || msg.includes('\0'))
      throw new VersionStoreError('the commit message is empty or invalid', 'bad_ref');
    const snap = this.prepare(files);
    const when = Math.floor((o.at ?? this.now()).getTime() / 1000);
    const branchRef = `refs/heads/${branch}`;
    const out = await this.backend.withTx(r, true, async (tx) => {
      if (!tx)
        throw new VersionStoreError(
          'the repository is not initialised',
          'bad_ref',
          'not_initialised',
        );
      const { storedBytes } = await tx.lock();
      const tip = await tx.getRef(branchRef);
      const parent =
        o.parentOverride !== undefined
          ? o.parentOverride
          : o.expectedTip !== undefined
            ? o.expectedTip
            : tip;
      if (parent !== null && !SHA.test(parent))
        throw new VersionStoreError('invalid parent commit', 'bad_ref');
      const stale = o.expectedTip !== undefined && o.expectedTip !== tip;

      // Replay: the same request (parent + tree + message) already produced a commit. Reconcile, do not duplicate.
      const replayKey = sha256hex(`${parent ?? ''}\n${snap.root}\n${msg}`);
      const replay = await tx.findReplay(replayKey);
      if (replay) {
        let moved = false;
        if (!stale && tip !== replay.oid) {
          if (tip !== null && parent !== tip)
            throw new VersionStoreError('the branch moved', 'stale_ref');
          if (tip === null) await this.assertNoRefClash(tx, branchRef, 'refs/heads/');
          moved = await this.setBranch(tx, branchRef, tip, replay.oid);
          if (!moved) throw new VersionStoreError('the branch moved', 'stale_ref');
          await tx.appendEvent({
            action: 'ref.moved',
            refName: branchRef,
            commitOid: replay.oid,
            ...(o.actorUserId ? { actorUserId: o.actorUserId } : {}),
            ...(o.traceId ? { traceId: o.traceId } : {}),
            detail: { replay: true },
          });
        }
        return { commit: replay, changed: moved, replayed: true, bytes: 0, newBlobs: 0 };
      }

      if (stale) throw new VersionStoreError('the branch moved', 'stale_ref');
      if (tip !== null && parent !== tip)
        throw new VersionStoreError(
          'the commit does not build on the branch tip (history is never rewritten)',
          'stale_ref',
        );
      if (parent !== null && !(await tx.getCommits([parent])).has(parent))
        throw new VersionStoreError('unknown parent commit', 'bad_ref', 'unknown_revision');

      const existing = await tx.existingBlobs([...snap.blobs.keys()]);
      const fresh = [...snap.blobs.values()].filter((b) => !existing.has(b.oid));
      this.scan(fresh, snap.firstPath);
      const newBytes = fresh.reduce((n, b) => n + b.size, 0);
      if (storedBytes + newBytes > this.maxRepo)
        throw new VersionStoreError(
          'the repository storage quota is reached',
          'bad_ref',
          'too_large',
        );

      const commit: StoredCommit = {
        oid: commitOid({
          tree: snap.root,
          parents: parent ? [parent] : [],
          author: DEFAULT_IDENTITY,
          when,
          message: msg,
        }),
        tree: snap.root,
        parents: parent ? [parent] : [],
        authorName: DEFAULT_IDENTITY.name,
        authorEmail: DEFAULT_IDENTITY.email,
        at: new Date(when * 1000),
        message: msg,
        replayKey,
      };
      if (tip === null) await this.assertNoRefClash(tx, branchRef, 'refs/heads/');
      await tx.insertBlobs(fresh);
      await tx.insertTrees([...snap.trees.values()]);
      await tx.insertCommit(commit);
      if (!(await this.setBranch(tx, branchRef, tip, commit.oid)))
        throw new VersionStoreError('the branch moved', 'stale_ref');
      await tx.addStoredBytes(newBytes);
      await tx.appendEvent({
        action: 'commit.created',
        refName: branchRef,
        commitOid: commit.oid,
        ...(o.actorUserId ? { actorUserId: o.actorUserId } : {}),
        ...(o.traceId ? { traceId: o.traceId } : {}),
        detail: {
          branch,
          parent,
          tree: snap.root,
          files: snap.fileCount,
          bytes: snap.totalBytes,
          newBlobs: fresh.length,
          newBytes,
        },
      });
      return {
        commit,
        changed: true,
        replayed: false,
        bytes: snap.totalBytes,
        newBlobs: fresh.length,
      };
    });
    if (out.changed)
      await this.audit(r, 'builder.version.committed', o, {
        branch,
        commit: out.commit.oid,
        parent: out.commit.parents[0] ?? null,
        files: snap.fileCount,
        bytes: out.bytes,
        newBlobs: out.newBlobs,
        replayed: out.replayed,
      });
    return info(out.commit);
  }

  private async setBranch(
    tx: ObjectTx,
    name: string,
    tip: string | null,
    next: string,
  ): Promise<boolean> {
    return tip === null ? tx.createRef(name, next) : tx.moveRef(name, tip, next);
  }
  /** git refuses `refs/heads/a/b` while `refs/heads/a` exists, and the reverse. */
  private async assertNoRefClash(tx: ObjectTx, name: string, prefix: string): Promise<void> {
    const existing = await tx.listRefs(prefix);
    const clash = existing.find(
      (e) => e.name.startsWith(`${name}/`) || name.startsWith(`${e.name}/`),
    );
    if (clash) throw new VersionStoreError('a branch with a clashing name exists', 'bad_ref');
  }

  async tag(
    ref: string,
    name: string,
    sha: string,
    o: { actorUserId?: string; traceId?: string } = {},
  ): Promise<void> {
    if (!TAG.test(name) || !SHA.test(sha))
      throw new VersionStoreError('invalid checkpoint name or commit', 'bad_ref');
    const r = parseRef(ref);
    const refName = `refs/tags/${name}`;
    await this.backend.withTx(r, true, async (tx) => {
      if (!tx)
        throw new VersionStoreError(
          'the repository is not initialised',
          'bad_ref',
          'not_initialised',
        );
      await tx.lock();
      if (!(await tx.getCommits([sha])).has(sha))
        throw new VersionStoreError('unknown commit', 'bad_ref', 'unknown_revision');
      if (!(await tx.createRef(refName, sha)))
        throw new VersionStoreError('the checkpoint already exists', 'stale_ref');
      await tx.appendEvent({
        action: 'checkpoint.created',
        refName,
        commitOid: sha,
        ...(o.actorUserId ? { actorUserId: o.actorUserId } : {}),
        ...(o.traceId ? { traceId: o.traceId } : {}),
        detail: { name },
      });
    });
    await this.audit(r, 'builder.version.checkpointed', o, { name, commit: sha });
  }

  async setRemoteRef(
    ref: string,
    remote: string,
    branch: string,
    sha: string,
    o: { actorUserId?: string; traceId?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (!REMOTE.test(remote)) throw new VersionStoreError('invalid remote name', 'bad_ref');
    checkBranch(branch);
    if (!SHA.test(sha)) throw new VersionStoreError('invalid commit', 'bad_ref');
    const r = parseRef(ref);
    const refName = `refs/remotes/${remote}/${branch}`;
    await this.backend.withTx(r, true, async (tx) => {
      if (!tx)
        throw new VersionStoreError(
          'the repository is not initialised',
          'bad_ref',
          'not_initialised',
        );
      await tx.lock();
      if (!(await tx.getCommits([sha])).has(sha))
        throw new VersionStoreError('unknown commit', 'bad_ref', 'unknown_revision');
      const cur = await tx.getRef(refName);
      if (cur === sha) return;
      if (cur === null) await this.assertNoRefClash(tx, refName, `refs/remotes/${remote}/`);
      if (!(await this.setBranch(tx, refName, cur, sha)))
        throw new VersionStoreError('the remote reference moved', 'stale_ref');
      await tx.appendEvent({
        action: 'remote_ref.set',
        refName,
        commitOid: sha,
        ...(o.actorUserId ? { actorUserId: o.actorUserId } : {}),
        ...(o.traceId ? { traceId: o.traceId } : {}),
        ...(o.detail ? { detail: o.detail } : {}),
      });
    });
    await this.audit(r, 'builder.version.remote_synced', o, {
      remote,
      branch,
      commit: sha,
      ...(o.detail ?? {}),
    });
  }
  async getRemoteRef(ref: string, remote: string, branch: string): Promise<string | null> {
    if (!REMOTE.test(remote)) return null;
    return this.tipOf(ref, `refs/remotes/${remote}/${branch}`);
  }

  // ---- read path -----------------------------------------------------------------------------------------------------------------------
  private async read<T>(ref: string, empty: T, fn: (tx: ObjectTx) => Promise<T>): Promise<T> {
    const r = parseRef(ref);
    return this.backend.withTx(r, false, async (tx) => (tx ? fn(tx) : empty));
  }
  async tipOf(ref: string, fullRef: string): Promise<string | null> {
    const name = fullRefName(fullRef);
    if (!name) return null;
    try {
      return await this.read(ref, null, (tx) => tx.getRef(name));
    } catch (e) {
      if (e instanceof VersionStoreError && e.reason === 'bad_ref') return null;
      throw e;
    }
  }
  async branches(ref: string): Promise<{ name: string; sha: string }[]> {
    return this.read(ref, [], async (tx) =>
      (await tx.listRefs('refs/heads/'))
        .map((e) => ({ name: e.name.slice('refs/heads/'.length), sha: e.oid }))
        .sort(byName),
    );
  }
  async checkpoints(ref: string): Promise<{ name: string; sha: string }[]> {
    return this.read(ref, [], async (tx) =>
      (await tx.listRefs('refs/tags/'))
        .map((e) => ({ name: e.name.slice('refs/tags/'.length), sha: e.oid }))
        .sort(byName),
    );
  }

  private async resolveIn(tx: ObjectTx, rev: string): Promise<string | null> {
    if (SHA.test(rev)) return (await tx.getCommits([rev])).has(rev) ? rev : null;
    if (rev.startsWith('refs/') || rev === 'HEAD') {
      const n = fullRefName(rev);
      return n ? tx.getRef(n) : null;
    }
    if (BRANCH.test(rev)) {
      const t = await tx.getRef(`refs/heads/${rev}`);
      if (t) return t;
    }
    if (TAG.test(rev)) return tx.getRef(`refs/tags/${rev}`);
    return null;
  }
  async resolve(ref: string, rev: string): Promise<string | null> {
    return this.read(ref, null, (tx) => this.resolveIn(tx, rev));
  }
  private async mustResolve(tx: ObjectTx, rev: string): Promise<StoredCommit> {
    const oid = await this.resolveIn(tx, rev);
    const c = oid ? (await tx.getCommits([oid])).get(oid) : undefined;
    if (!c) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
    this.verifyCommit(c);
    return c;
  }
  private verifyCommit(c: StoredCommit): void {
    const again = commitOid({
      tree: c.tree,
      parents: c.parents,
      author: { name: c.authorName, email: c.authorEmail },
      when: Math.floor(c.at.getTime() / 1000),
      message: c.message,
    });
    if (again !== c.oid)
      throw new VersionStoreError(
        'a stored commit does not match its id',
        'git_failed',
        'corrupt_object',
        { oid: c.oid },
      );
  }

  async log(ref: string, rev: string, limit = 50): Promise<CommitInfo[]> {
    if (!BRANCH.test(rev) && !SHA.test(rev) && !TAG.test(rev))
      throw new VersionStoreError('invalid revision', 'bad_ref');
    const max = Math.min(limit, MAX_LOG);
    return this.read(ref, [], async (tx) => {
      const startOid = await this.resolveIn(tx, rev);
      if (!startOid) {
        if (SHA.test(rev))
          throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
        return [];
      }
      if (max <= 0) return [];
      const cache = new Map<string, StoredCommit>();
      for (const c of await tx.firstParentChain(startOid, max + 1)) cache.set(c.oid, c);
      const fetch = async (oids: string[]) => {
        const miss = oids.filter((x) => !cache.has(x));
        if (miss.length) for (const [k, v] of await tx.getCommits(miss)) cache.set(k, v);
        return oids.map((x) => cache.get(x)).filter((c): c is StoredCommit => !!c);
      };
      const start = (await fetch([startOid]))[0];
      if (!start) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
      // newest first by commit time, a child always before its parents (like `git log`)
      const seen = new Set([startOid]);
      let queue: { c: StoredCommit; n: number }[] = [{ c: start, n: 0 }];
      let n = 1;
      const out: CommitInfo[] = [];
      while (queue.length && out.length < max) {
        queue.sort((x, y) => y.c.at.getTime() - x.c.at.getTime() || x.n - y.n);
        const { c } = queue.shift()!;
        this.verifyCommit(c);
        out.push(info(c));
        const next = (await fetch(c.parents.filter((p) => !seen.has(p)))).map((pc) => {
          seen.add(pc.oid);
          return { c: pc, n: n++ };
        });
        queue = queue.concat(next);
      }
      return out;
    });
  }

  /** Path -> blob oid of a tree, level by level (one batched read per level). Refuses anything but regular files. */
  private async flatten(tx: ObjectTx, root: string): Promise<Map<string, FlatFile>> {
    const out = new Map<string, FlatFile>();
    let level: { prefix: string; oid: string }[] = [{ prefix: '', oid: root }];
    while (level.length) {
      const trees = await tx.getTrees([...new Set(level.map((l) => l.oid))]);
      const next: { prefix: string; oid: string }[] = [];
      for (const l of level) {
        const t = trees.get(l.oid);
        if (!t)
          throw new VersionStoreError('a tree is missing', 'git_failed', 'corrupt_object', {
            oid: l.oid,
          });
        if (treeOid(t.entries) !== t.oid)
          throw new VersionStoreError(
            'a stored tree does not match its id',
            'git_failed',
            'corrupt_object',
            { oid: t.oid },
          );
        for (const e of t.entries) {
          const p = l.prefix + e.name;
          if (e.mode === DIR_MODE) next.push({ prefix: `${p}/`, oid: e.oid });
          else if (e.mode === FILE_MODE) out.set(p, { oid: e.oid });
          else
            throw new VersionStoreError(
              `${p}: symlinks and submodules are not allowed`,
              'bad_ref',
              'path_rejected',
            );
        }
      }
      level = next;
    }
    return out;
  }
  private async loadBlobs(tx: ObjectTx, oids: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const uniq = [...new Set(oids)];
    for (let i = 0; i < uniq.length; i += BLOB_CHUNK) {
      const got = await tx.getBlobs(uniq.slice(i, i + BLOB_CHUNK));
      for (const oid of uniq.slice(i, i + BLOB_CHUNK)) {
        const b = got.get(oid);
        if (!b)
          throw new VersionStoreError('a file is missing', 'git_failed', 'corrupt_object', { oid });
        if (
          b.content.byteLength !== b.size ||
          sha256hex(b.content) !== b.sha256 ||
          blobOid(b.content) !== oid
        )
          throw new VersionStoreError(
            'a stored file does not match its id',
            'git_failed',
            'corrupt_object',
            { oid },
          );
        out.set(oid, b.content);
      }
    }
    return out;
  }

  async readFiles(ref: string, rev: string): Promise<Map<string, Uint8Array>> {
    return this.read<Map<string, Uint8Array> | null>(ref, null, async (tx) => {
      const c = await this.mustResolve(tx, rev);
      const flat = await this.flatten(tx, c.tree);
      const blobs = await this.loadBlobs(
        tx,
        [...flat.values()].map((f) => f.oid),
      );
      const out = new Map<string, Uint8Array>();
      for (const [p, f] of flat) out.set(p, new Uint8Array(blobs.get(f.oid)!));
      return out;
    }).then((m) => {
      if (!m) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
      return m;
    });
  }
  async readTree(ref: string, rev: string): Promise<Map<string, string>> {
    const files = await this.readFiles(ref, rev);
    return new Map([...files].map(([p, b]) => [p, Buffer.from(b).toString('utf8')]));
  }
  async listTree(ref: string, rev: string): Promise<TreeFileInfo[]> {
    const r = await this.read<TreeFileInfo[] | null>(ref, null, async (tx) => {
      const c = await this.mustResolve(tx, rev);
      const flat = await this.flatten(tx, c.tree);
      const meta = await tx.getBlobMeta([...new Set([...flat.values()].map((f) => f.oid))]);
      return [...flat]
        .map(([path, f]) => ({
          path,
          oid: f.oid,
          size: meta.get(f.oid)?.size ?? 0,
          binary: meta.get(f.oid)?.binary ?? false,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    });
    if (!r) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
    return r;
  }

  /** Changed paths between two trees; identical subtrees (same oid) are skipped without being read. */
  private async changes(tx: ObjectTx, a: string, b: string) {
    const out: { path: string; a: string | null; b: string | null }[] = [];
    let level: { prefix: string; a: string | null; b: string | null }[] = [{ prefix: '', a, b }];
    while (level.length) {
      level = level.filter((l) => l.a !== l.b);
      const need = [...new Set(level.flatMap((l) => [l.a, l.b]).filter((x): x is string => !!x))];
      const trees: Map<string, StoredTree> = need.length ? await tx.getTrees(need) : new Map();
      const next: typeof level = [];
      for (const l of level) {
        const ta = l.a ? trees.get(l.a) : null;
        const tb = l.b ? trees.get(l.b) : null;
        if ((l.a && !ta) || (l.b && !tb))
          throw new VersionStoreError('a tree is missing', 'git_failed', 'corrupt_object');
        const names = new Set([...(ta?.entries ?? []), ...(tb?.entries ?? [])].map((e) => e.name));
        const ea = new Map((ta?.entries ?? []).map((e) => [e.name, e]));
        const eb = new Map((tb?.entries ?? []).map((e) => [e.name, e]));
        for (const name of names) {
          const x = ea.get(name);
          const y = eb.get(name);
          const xd = x?.mode === DIR_MODE;
          const yd = y?.mode === DIR_MODE;
          const p = l.prefix + name;
          // a name that is a file on one side and a directory on the other is a delete plus an add
          if (x && !xd && (!y || yd)) out.push({ path: p, a: x.oid, b: null });
          if (y && !yd && (!x || xd)) out.push({ path: p, a: null, b: y.oid });
          if (x && y && !xd && !yd && x.oid !== y.oid) out.push({ path: p, a: x.oid, b: y.oid });
          if (xd || yd)
            next.push({ prefix: `${p}/`, a: xd ? x!.oid : null, b: yd ? y!.oid : null });
        }
      }
      level = next;
    }
    return out;
  }

  async diff(ref: string, a: string, b: string): Promise<TreeDiff> {
    const res = await this.read<TreeDiff | null>(ref, null, async (tx) => {
      const [ca, cb] = [await this.mustResolve(tx, a), await this.mustResolve(tx, b)];
      const ch = await this.changes(tx, ca.tree, cb.tree);
      const added = ch
        .filter((c) => !c.a)
        .map((c) => c.path)
        .sort();
      const deleted = ch
        .filter((c) => !c.b)
        .map((c) => c.path)
        .sort();
      const modified = ch
        .filter((c) => c.a && c.b)
        .map((c) => c.path)
        .sort();
      const meta = await tx.getBlobMeta([
        ...new Set(ch.flatMap((c) => [c.a, c.b]).filter((x): x is string => !!x)),
      ]);
      // exact renames: the same NON-EMPTY blob under one deleted and one added path (empty files would all match each other)
      const renamed: { from: string; to: string }[] = [];
      const gone = new Map<string, string[]>();
      for (const c of ch.filter((x) => !x.b && (meta.get(x.a!)?.size ?? 0) > 0))
        gone.set(c.a!, [...(gone.get(c.a!) ?? []), c.path].sort());
      for (const c of ch.filter((x) => !x.a).sort((x, y) => (x.path < y.path ? -1 : 1))) {
        const from = gone.get(c.b!)?.shift();
        if (from) renamed.push({ from, to: c.path });
      }
      const rt = new Map(renamed.map((x) => [x.to, x.from]));
      const rf = new Set(renamed.map((x) => x.from));
      let patch = '';
      const ordered = [...ch].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      for (let i = 0; i < ordered.length && patch.length < PATCH_CAP; i += 40) {
        const chunk = ordered.slice(i, i + 40).filter((c) => !rf.has(c.path) || c.b);
        const blobs = await this.loadBlobs(
          tx,
          chunk.flatMap((c) => [c.a, c.b]).filter((x): x is string => !!x),
        );
        const side = (oid: string | null) => {
          if (!oid) return null;
          const m = meta.get(oid);
          return { oid, bytes: blobs.get(oid)!, binary: m?.binary ?? false };
        };
        for (const c of chunk) {
          if (rt.has(c.path)) patch += renameDiff(rt.get(c.path)!, c.path);
          else patch += fileDiff(c.path, side(c.a), side(c.b));
        }
      }
      return {
        added,
        modified,
        deleted,
        patch: patch.slice(0, PATCH_CAP),
        ...(renamed.length ? { renamed } : {}),
      };
    });
    if (!res) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
    return res;
  }
}
export type { StoreEvent };
