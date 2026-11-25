import { createHash } from 'node:crypto';

/**
 * Git-compatible object encoding in pure TypeScript (no `git`, no subprocess, no file system). For the same inputs the ids equal what git computes, which is what
 * the conformance suite checks against `GitStore`. SHA-1 here is an identifier, not an integrity guarantee: blobs also carry a sha256 (see the store).
 */
export const sha1 = (b: Uint8Array | string): string => createHash('sha1').update(b).digest('hex');
export const sha256hex = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

export const FILE_MODE = '100644';
export const DIR_MODE = '40000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const blobOid = (content: Uint8Array): string =>
  sha1(Buffer.concat([Buffer.from(`blob ${content.byteLength}\0`), content]));

export interface TreeEntry {
  name: string;
  mode: typeof FILE_MODE | typeof DIR_MODE;
  oid: string;
}

/** git orders tree entries by name bytes, comparing a directory as if its name ended with "/". */
const sortKey = (e: TreeEntry): Buffer =>
  Buffer.from(e.mode === DIR_MODE ? `${e.name}/` : e.name, 'utf8');
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries
    .map((e) => ({ e, k: sortKey(e) }))
    .sort((a, b) => Buffer.compare(a.k, b.k))
    .map((x) => x.e);
}
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  return Buffer.concat(
    sortEntries(entries).map((e) =>
      Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]),
    ),
  );
}
export const treeOid = (entries: readonly TreeEntry[]): string => {
  const body = encodeTree(entries);
  return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
};

export const DEFAULT_IDENTITY = { name: 'Nuzm App Builder', email: 'builder@nuzm.invalid' };
export interface CommitBody {
  tree: string;
  parents: readonly string[];
  author: { name: string; email: string };
  /** Unix seconds, UTC. */
  when: number;
  message: string;
}
/** `git commit-tree -m <message>`: the message is completed with one trailing newline. */
export function encodeCommit(c: CommitBody): Buffer {
  const who = `${c.author.name} <${c.author.email}> ${c.when} +0000`;
  const msg = c.message.endsWith('\n') ? c.message : `${c.message}\n`;
  return Buffer.from(
    [
      `tree ${c.tree}`,
      ...c.parents.map((p) => `parent ${p}`),
      `author ${who}`,
      `committer ${who}`,
      '',
      msg,
    ].join('\n'),
    'utf8',
  );
}
export const commitOid = (c: CommitBody): string => {
  const body = encodeCommit(c);
  return sha1(Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]));
};

/** `git log --format=%s`: the first paragraph, its lines joined by a space. */
export function subjectOf(message: string): string {
  const para = message.replace(/^\n+/, '').split(/\n[ \t]*\n/)[0] ?? '';
  return para
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

export interface NewBlob {
  oid: string;
  sha256: string;
  size: number;
  binary: boolean;
  content: Buffer;
}
export interface NewTree {
  oid: string;
  entries: TreeEntry[];
}
type Node = { files: Map<string, string>; dirs: Map<string, Node> };
const mkNode = (): Node => ({ files: new Map(), dirs: new Map() });

/** Binary = a NUL byte in the first 8 000 bytes (git's own heuristic). */
export const looksBinary = (b: Uint8Array): boolean => b.subarray(0, 8000).includes(0);

/** Builds the blobs and trees of a flat `path -> bytes` snapshot. Paths must already have passed `checkPath`. Returns null on a file/directory name clash. */
export function buildSnapshot(files: ReadonlyMap<string, Buffer>): {
  root: string;
  blobs: Map<string, NewBlob>;
  trees: Map<string, NewTree>;
  clash: string | null;
} {
  const root = mkNode();
  const blobs = new Map<string, NewBlob>();
  const trees = new Map<string, NewTree>();
  for (const [path, content] of files) {
    const parts = path.split('/');
    let n = root;
    for (const d of parts.slice(0, -1)) {
      if (n.files.has(d)) return { root: '', blobs, trees, clash: path };
      if (!n.dirs.has(d)) n.dirs.set(d, mkNode());
      n = n.dirs.get(d)!;
    }
    const leaf = parts.at(-1)!;
    if (n.dirs.has(leaf)) return { root: '', blobs, trees, clash: path };
    const oid = blobOid(content);
    if (!blobs.has(oid))
      blobs.set(oid, {
        oid,
        sha256: sha256hex(content),
        size: content.byteLength,
        binary: looksBinary(content),
        content,
      });
    n.files.set(leaf, oid);
  }
  const build = (n: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of n.dirs) entries.push({ name, mode: DIR_MODE, oid: build(sub) });
    for (const [name, oid] of n.files) entries.push({ name, mode: FILE_MODE, oid });
    const sorted = sortEntries(entries);
    const oid = treeOid(sorted);
    trees.set(oid, { oid, entries: sorted });
    return oid;
  };
  return { root: build(root), blobs, trees, clash: null };
}
