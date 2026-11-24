import type { GitHostAdapter } from '../studio/git-host';
import {
  BRANCH,
  VersionStoreError,
  type CommitInfo,
  type VersionStoreExt,
} from './version-store.port';

/**
 * Glue between the version store and the existing GitHub App adapter (`GitHostAdapter`). The adapter talks to GitHub ONLY through the REST Git Data API over HTTPS
 * (blobs, trees, commits, refs; installation token minted per call and kept in memory; key and webhook secret are vault references; webhook deliveries are deduped
 * by `X-GitHub-Delivery` in `builder.github_events`). Nothing here starts a process or needs a `git` binary. A branch on GitHub is only ever moved forward from the tip the
 * adapter read (never forced). Only text files are exchanged: binary and oversized files are reported as skipped.
 */
export interface ExportInput {
  ref: string;
  /** branch, checkpoint or commit of the store */
  rev: string;
  installationId: number;
  fullName: string;
  /** GitHub branch to move (created from the repository's default branch when missing) */
  branch: string;
  message: string;
  actorUserId?: string;
  traceId?: string;
}
export interface ExportResult {
  pushed: boolean;
  reason?: 'already_exported' | 'nothing_to_push';
  commit: string;
  remoteSha?: string;
  changed: number;
  deleted: number;
  skippedBinary: string[];
}
export interface ImportInput {
  ref: string;
  installationId: number;
  fullName: string;
  /** GitHub branch (or commit) to read */
  branch: string;
  /** local branch that receives the snapshot (default `import/github-<branch>`) */
  localBranch?: string;
  actorUserId?: string;
  traceId?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'main';

export class GithubVersionBridge {
  constructor(
    private readonly store: VersionStoreExt,
    private readonly host: GitHostAdapter,
  ) {}

  async exportToGitHub(i: ExportInput): Promise<ExportResult> {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(i.fullName))
      throw new VersionStoreError('invalid repository name', 'bad_ref');
    if (!BRANCH.test(i.branch)) throw new VersionStoreError('invalid branch name', 'bad_ref');
    const commit = await this.store.resolve(i.ref, i.rev);
    if (!commit) throw new VersionStoreError('unknown revision', 'bad_ref', 'unknown_revision');
    const mirror = slug(i.branch);
    // A retry after a timeout: the mirror already points at this commit, so the export happened (reconcile, do not push twice).
    if ((await this.store.getRemoteRef(i.ref, 'github', mirror)) === commit)
      return {
        pushed: false,
        reason: 'already_exported',
        commit,
        changed: 0,
        deleted: 0,
        skippedBinary: [],
      };

    const listing = await this.store.listTree(i.ref, commit);
    const skippedBinary = listing.filter((f) => f.binary).map((f) => f.path);
    const local = await this.store.readTree(i.ref, commit);
    for (const p of skippedBinary) local.delete(p);

    let baseSha = await this.host.branchSha(i.installationId, i.fullName, i.branch);
    if (!baseSha) {
      const repo = await this.host.getRepo(i.installationId, i.fullName);
      baseSha = await this.host.branchSha(i.installationId, i.fullName, repo.defaultBranch);
    }
    if (!baseSha)
      throw new VersionStoreError('the repository has no commit to build on', 'bad_ref');
    const base = await this.host.readTree(i.installationId, i.fullName, baseSha);
    const files = new Map([...local].filter(([p, c]) => base.files.get(p) !== c));
    const deletes = [...base.files.keys()].filter(
      (p) => !local.has(p) && !base.skipped.includes(p),
    );
    if (!files.size && !deletes.length) {
      await this.store.setRemoteRef(i.ref, 'github', mirror, commit, {
        ...(i.actorUserId ? { actorUserId: i.actorUserId } : {}),
        ...(i.traceId ? { traceId: i.traceId } : {}),
        detail: { repo: i.fullName, remoteSha: baseSha, noop: true },
      });
      return {
        pushed: false,
        reason: 'nothing_to_push',
        commit,
        changed: 0,
        deleted: 0,
        skippedBinary,
      };
    }
    const out = await this.host.commit(i.installationId, i.fullName, {
      branch: i.branch,
      baseSha,
      files,
      deletes,
      message: i.message.slice(0, 500),
    });
    await this.store.setRemoteRef(i.ref, 'github', mirror, commit, {
      ...(i.actorUserId ? { actorUserId: i.actorUserId } : {}),
      ...(i.traceId ? { traceId: i.traceId } : {}),
      detail: {
        repo: i.fullName,
        remoteSha: out.sha,
        changed: files.size,
        deleted: deletes.length,
      },
    });
    return {
      pushed: true,
      commit,
      remoteSha: out.sha,
      changed: files.size,
      deleted: deletes.length,
      skippedBinary,
    };
  }

  /** The repository's files at `branch` become a commit on a local import branch (never on `main`: the project's own history is not rewritten). */
  async importFromGitHub(
    i: ImportInput,
  ): Promise<{ commit: CommitInfo; remoteSha: string; skipped: string[] }> {
    const localBranch = i.localBranch ?? `import/github-${slug(i.branch)}`;
    const tree = await this.host.readTree(i.installationId, i.fullName, i.branch);
    const message = `Import ${i.fullName}@${tree.sha.slice(0, 7)}`;
    const tip = await this.store.tipOf(i.ref, `refs/heads/${localBranch}`);
    // Importing a state the import branch already holds is a no-op (a retry, or nothing new on GitHub): no empty commit.
    const current = tip ? await this.store.readTree(i.ref, tip) : null;
    const same =
      current !== null &&
      current.size === tree.files.size &&
      [...tree.files].every(([p, c]) => current.get(p) === c);
    const commit =
      same && tip
        ? (await this.store.log(i.ref, tip, 1))[0]!
        : await this.store.commit(i.ref, localBranch, tree.files, message, {
            expectedTip: tip,
            ...(i.actorUserId ? { actorUserId: i.actorUserId } : {}),
            ...(i.traceId ? { traceId: i.traceId } : {}),
          });
    await this.store.setRemoteRef(i.ref, 'github', slug(i.branch), commit.sha, {
      ...(i.actorUserId ? { actorUserId: i.actorUserId } : {}),
      ...(i.traceId ? { traceId: i.traceId } : {}),
      detail: { repo: i.fullName, remoteSha: tree.sha, imported: tree.files.size },
    });
    return { commit, remoteSha: tree.sha, skipped: tree.skipped };
  }
}
