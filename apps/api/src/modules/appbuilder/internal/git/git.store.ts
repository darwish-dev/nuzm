import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPath } from '../sandbox/paths';

/**
 * Git storage of generated source (S46.2) using ONLY plumbing commands on a bare repository: blobs are written with `hash-object`, trees with `mktree`, commits with
 * `commit-tree`, refs with `update-ref`. No working tree exists, so no file path of the project ever becomes a path on the control-plane disk (no traversal, no symlink),
 * and no hook, filter, textconv or attribute driver can run: git is started with an empty system/global configuration and `core.hooksPath=/dev/null`.
 * Generated code is never executed here. There is NO HTTP route to this class until the owner approves SCR-M10-01.
 */
export interface CommitInfo {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  at: string;
}
export interface TreeDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Unified text diff (`git diff`), capped; no external diff or textconv. */
  patch: string;
}
const BRANCH = /^[a-z][a-z0-9/_-]{0,60}$/;
const TAG = /^cp-[0-9a-z][0-9a-z-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;
export const PATCH_CAP = 200_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_ref' | 'stale_ref' | 'git_failed',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

function run(gitDir: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const home = process.env.TMPDIR ?? tmpdir();
    const child = spawn('git', ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Nuzm App Builder', GIT_AUTHOR_EMAIL: 'builder@nuzm.invalid', GIT_COMMITTER_NAME: 'Nuzm App Builder', GIT_COMMITTER_EMAIL: 'builder@nuzm.invalid', ...extraEnv },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new GitError(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').slice(0, 300)}`, 'git_failed'))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

type Node = { files: Map<string, string>; dirs: Map<string, Node> };
const mkNode = (): Node => ({ files: new Map(), dirs: new Map() });

export class GitStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }
  static temp(): { store: GitStore; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'nuzm-git-'));
    return { store: new GitStore(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  gitDir(ref: string): string {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.git$/.test(ref)) throw new GitError('invalid repository reference', 'bad_ref');
    return join(this.root, ref);
  }
  async init(ref: string): Promise<void> {
    const dir = this.gitDir(ref);
    if (existsSync(join(dir, 'HEAD'))) return;
    mkdirSync(dir, { recursive: true });
    await run(dir, ['init', '--bare', '--quiet', '--initial-branch=main']);
  }

  private async blob(dir: string, content: string): Promise<string> {
    return (await run(dir, ['hash-object', '-w', '--stdin'], content)).toString('utf8').trim();
  }
  private async tree(dir: string, n: Node): Promise<string> {
    const lines: string[] = [];
    for (const [name, sub] of n.dirs) lines.push(`040000 tree ${await this.tree(dir, sub)}\t${name}`);
    for (const [name, sha] of n.files) lines.push(`100644 blob ${sha}\t${name}`);
    return (await run(dir, ['mktree'], lines.join('\n') + (lines.length ? '\n' : ''))).toString('utf8').trim();
  }
  /** Writes `files` as a full snapshot and commits it on `branch` (created on first use). `expectedTip` makes the ref update compare-and-swap. */
  async commit(ref: string, branch: string, files: ReadonlyMap<string, string>, message: string, o: { expectedTip?: string | null; at?: Date; parentOverride?: string | null } = {}): Promise<CommitInfo> {
    if (!BRANCH.test(branch)) throw new GitError('invalid branch name', 'bad_ref');
    const dir = this.gitDir(ref);
    const root = mkNode();
    for (const [path, content] of files) {
      const err = checkPath(path);
      if (err) throw new GitError(`${path}: ${err}`, 'bad_ref');
      const parts = path.split('/');
      let n = root;
      for (const d of parts.slice(0, -1)) {
        if (n.files.has(d)) throw new GitError(`${path}: a file and a directory share a name`, 'bad_ref');
        if (!n.dirs.has(d)) n.dirs.set(d, mkNode());
        n = n.dirs.get(d)!;
      }
      const leaf = parts.at(-1)!;
      if (n.dirs.has(leaf)) throw new GitError(`${path}: a file and a directory share a name`, 'bad_ref');
      n.files.set(leaf, await this.blob(dir, content));
    }
    const treeSha = await this.tree(dir, root);
    const tip = await this.tipOf(ref, `refs/heads/${branch}`);
    if (o.expectedTip !== undefined && o.expectedTip !== tip) throw new GitError('the branch moved', 'stale_ref');
    const parent = o.parentOverride !== undefined ? o.parentOverride : tip;
    const when = Math.floor((o.at ?? new Date()).getTime() / 1000);
    const date = `${when} +0000`;
    const sha = (await run(dir, ['commit-tree', treeSha, ...(parent ? ['-p', parent] : []), '-m', message.slice(0, 2000)], undefined, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })).toString('utf8').trim();
    await run(dir, ['update-ref', `refs/heads/${branch}`, sha, ...(tip ? [tip] : ['0000000000000000000000000000000000000000'])]);
    return { sha, parents: parent ? [parent] : [], message, author: 'Nuzm App Builder', at: new Date(when * 1000).toISOString() };
  }
  async tipOf(ref: string, fullRef: string): Promise<string | null> {
    try {
      const out = (await run(this.gitDir(ref), ['rev-parse', '--verify', '--quiet', fullRef])).toString('utf8').trim();
      return SHA.test(out) ? out : null;
    } catch {
      return null;
    }
  }
  async branches(ref: string): Promise<{ name: string; sha: string }[]> {
    const out = (await run(this.gitDir(ref), ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])).toString('utf8').trim();
    return out ? out.split('\n').map((l) => ({ name: l.split(' ')[0]!, sha: l.split(' ')[1]! })) : [];
  }
  /** Checkpoints are tags `cp-<name>` pointing at a commit. */
  async tag(ref: string, name: string, sha: string): Promise<void> {
    if (!TAG.test(name) || !SHA.test(sha)) throw new GitError('invalid checkpoint name or commit', 'bad_ref');
    const dir = this.gitDir(ref);
    if (await this.tipOf(ref, `refs/tags/${name}`)) throw new GitError('the checkpoint already exists', 'stale_ref');
    await run(dir, ['update-ref', `refs/tags/${name}`, sha, '0000000000000000000000000000000000000000']);
  }
  async checkpoints(ref: string): Promise<{ name: string; sha: string }[]> {
    const out = (await run(this.gitDir(ref), ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/tags'])).toString('utf8').trim();
    return out ? out.split('\n').map((l) => ({ name: l.split(' ')[0]!, sha: l.split(' ')[1]! })) : [];
  }
  async log(ref: string, rev: string, limit = 50): Promise<CommitInfo[]> {
    if (!BRANCH.test(rev) && !SHA.test(rev) && !TAG.test(rev)) throw new GitError('invalid revision', 'bad_ref');
    const full = SHA.test(rev) ? rev : BRANCH.test(rev) ? `refs/heads/${rev}` : `refs/tags/${rev}`;
    if (!SHA.test(rev) && !(await this.tipOf(ref, full))) return [];
    const out = (await run(this.gitDir(ref), ['log', `--max-count=${Math.min(limit, 200)}`, '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e', full])).toString('utf8');
    return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
      const [sha, parents, author, at, message] = r.split('\x1f') as [string, string, string, string, string];
      return { sha, parents: parents ? parents.split(' ') : [], author, at, message };
    });
  }
  /** Reads the files of a commit (or branch/checkpoint) back. */
  async readTree(ref: string, rev: string): Promise<Map<string, string>> {
    const sha = SHA.test(rev) ? rev : await this.tipOf(ref, BRANCH.test(rev) ? `refs/heads/${rev}` : `refs/tags/${rev}`);
    if (!sha) throw new GitError('unknown revision', 'bad_ref');
    const dir = this.gitDir(ref);
    const listing = (await run(dir, ['ls-tree', '-r', '-z', sha])).toString('utf8').split('\0').filter(Boolean);
    const entries = listing.map((l) => {
      const tab = l.indexOf('\t');
      const [mode, type, oid] = l.slice(0, tab).split(' ') as [string, string, string];
      return { mode, type, oid, path: l.slice(tab + 1) };
    });
    const bad = entries.find((e) => e.type !== 'blob' || e.mode === '120000' || e.mode === '160000');
    if (bad) throw new GitError(`${bad.path}: symlinks and submodules are not allowed`, 'bad_ref');
    const out = new Map<string, string>();
    if (entries.length === 0) return out;
    const batch = await run(dir, ['cat-file', '--batch'], entries.map((e) => e.oid).join('\n') + '\n');
    let off = 0;
    for (const e of entries) {
      const nl = batch.indexOf(0x0a, off);
      const header = batch.subarray(off, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      out.set(e.path, batch.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      off = nl + 1 + size + 1;
    }
    return out;
  }
  async diff(ref: string, a: string, b: string): Promise<TreeDiff> {
    const [fa, fb] = await Promise.all([this.readTree(ref, a), this.readTree(ref, b)]);
    const added = [...fb.keys()].filter((p) => !fa.has(p)).sort();
    const deleted = [...fa.keys()].filter((p) => !fb.has(p)).sort();
    const modified = [...fb.keys()].filter((p) => fa.has(p) && fa.get(p) !== fb.get(p)).sort();
    const sha = (r: string) => (SHA.test(r) ? r : null);
    const [ra, rb] = [sha(a) ?? (await this.tipOf(ref, BRANCH.test(a) ? `refs/heads/${a}` : `refs/tags/${a}`)), sha(b) ?? (await this.tipOf(ref, BRANCH.test(b) ? `refs/heads/${b}` : `refs/tags/${b}`))];
    const patch = ra && rb ? (await run(this.gitDir(ref), ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', ra, rb])).toString('utf8').slice(0, PATCH_CAP) : '';
    return { added, modified, deleted, patch };
  }
}
