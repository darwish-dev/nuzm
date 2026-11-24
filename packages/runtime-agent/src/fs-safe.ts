import { constants as C } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';

/**
 * Confined file operations for the workspace directories. The workload (and anything it leaves behind) is hostile: it may have planted symlinks, hard links, devices and FIFOs
 * where the agent will later read, so every operation here
 *   - takes a path RELATIVE to a root the agent chose, refuses absolute, `..`, empty and `.` segments, NUL and backslash;
 *   - `lstat`s every existing component and refuses a symlink in the middle of the path (the classic TOCTOU is narrowed by opening with O_NOFOLLOW and checking the opened
 *     descriptor with `fstat`, not the path);
 *   - never follows a link, never reads a device, FIFO or socket, never reads a hard-linked file (`nlink > 1`), never reads more than the caller's byte cap.
 * These are control-plane-of-the-node defences; the workload's own isolation (gVisor) is what actually contains it, and nothing here claims otherwise.
 */
export class UnsafePath extends Error {
  constructor(
    readonly code: 'path_escapes_workspace' | 'not_a_regular_file' | 'too_large' | 'not_found',
  ) {
    super(code);
    this.name = 'UnsafePath';
  }
}
const NOFOLLOW = C.O_NOFOLLOW ?? 0;

export function assertRelative(rel: string): string[] {
  if (!eg.isWorkspaceRelativePath(rel)) throw new UnsafePath('path_escapes_workspace');
  return rel.split('/');
}

/** create each missing directory of `rel`'s parent chain under `root`, refusing a symlink or a non-directory at any step */
async function ensureParents(root: string, segments: string[], mode: number): Promise<string> {
  let cur = root;
  for (const seg of segments.slice(0, -1)) {
    cur = join(cur, seg);
    let st = await lstat(cur).catch(() => null);
    if (!st) {
      await mkdir(cur, { mode }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      st = await lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePath('path_escapes_workspace');
    await chmod(cur, mode).catch(() => undefined);
  }
  return cur;
}

/** write a NEW regular file (exclusive, no symlink follow). An existing path is an error: `putFiles` never overwrites. */
export async function writeFileConfined(
  root: string,
  rel: string,
  content: string,
  opts: { dirMode: number; fileMode: number },
): Promise<number> {
  const segs = assertRelative(rel);
  const parent = await ensureParents(root, segs, opts.dirMode);
  const target = join(parent, segs[segs.length - 1]!);
  const fh = await open(target, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, opts.fileMode).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ELOOP' || e.code === 'EEXIST') throw new UnsafePath('path_escapes_workspace');
      throw e;
    },
  );
  try {
    const buf = Buffer.from(content, 'utf8');
    await fh.writeFile(buf);
    await fh.chmod(opts.fileMode);
    return buf.length;
  } finally {
    await fh.close();
  }
}

/** a bounded read of one regular, singly-linked file; the checks run on the opened descriptor */
export async function readFileConfined(
  root: string,
  rel: string,
  maxBytes: number,
): Promise<string> {
  const segs = assertRelative(rel);
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    cur = join(cur, seg);
    const st = await lstat(cur).catch(() => null);
    if (!st) throw new UnsafePath('not_found');
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePath('path_escapes_workspace');
  }
  const target = join(cur, segs[segs.length - 1]!);
  const fh = await open(target, C.O_RDONLY | NOFOLLOW | C.O_NONBLOCK).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') throw new UnsafePath('not_found');
      throw new UnsafePath('not_a_regular_file'); // ELOOP (symlink), EACCES, ENXIO (FIFO without writer)...
    },
  );
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1) throw new UnsafePath('not_a_regular_file');
    if (st.size > maxBytes) throw new UnsafePath('too_large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    await fh.close();
  }
}

export interface ListedFile {
  path: string;
  bytes: number;
  kind: 'file' | 'symlink' | 'hardlink' | 'dir' | 'device';
}
/**
 * List what lies under `<root>/<outputRoot>` for each output root, reporting links and devices instead of following them. Bounded by `maxEntries` and `maxDepth` so a deep or
 * huge tree cannot stall the agent; hitting a bound is reported by returning `truncated`.
 */
export async function listOutputs(
  root: string,
  outputRoots: readonly string[],
  maxEntries = 20_000,
  maxDepth = 24,
): Promise<{ files: ListedFile[]; truncated: boolean }> {
  const files: ListedFile[] = [];
  let truncated = false;
  const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (files.length >= maxEntries || depth > maxDepth) {
      truncated = true;
      return;
    }
    const st = await lstat(abs).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) {
      files.push({ path: rel, bytes: 0, kind: 'symlink' });
    } else if (st.isDirectory()) {
      files.push({ path: rel, bytes: 0, kind: 'dir' });
      const names = await readdir(abs).catch(() => [] as string[]);
      for (const n of names.sort()) {
        if (n === '' || n === '.' || n === '..') continue;
        await visit(join(abs, n), `${rel}/${n}`, depth + 1);
      }
    } else if (st.isFile()) {
      files.push({ path: rel, bytes: st.size, kind: st.nlink > 1 ? 'hardlink' : 'file' });
    } else {
      files.push({ path: rel, bytes: 0, kind: 'device' }); // block/char device, FIFO, socket
    }
  };
  for (const r of outputRoots) await visit(join(root, r), r, 0);
  return { files, truncated };
}

/** total bytes and entry count under a directory, without following links (used for accounting, never for security decisions) */
export async function treeUsage(
  dir: string,
  maxEntries = 500_000,
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const walk = async (d: string): Promise<void> => {
    if (entries > maxEntries) return;
    const names = await readdir(d).catch(() => [] as string[]);
    for (const n of names) {
      entries++;
      const p = join(d, n);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p);
      else bytes += st.size;
    }
  };
  await walk(dir);
  return { bytes, entries };
}

/**
 * Remove a directory tree that a hostile workload may have made unremovable (mode 000 directories, immutable-looking trees). `rm` never follows a symlink. On EACCES the tree is
 * made traversable with an lstat-based walk (links skipped) and removal is retried once. Resolves true only if the path is really gone.
 */
export async function forceRemoveTree(dir: string): Promise<boolean> {
  const gone = async () => (await lstat(dir).catch(() => null)) === null;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    /* fall through to the permission repair */
  }
  if (await gone()) return true;
  const relax = async (d: string): Promise<void> => {
    const st = await lstat(d).catch(() => null);
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      await chmod(d, 0o700).catch(() => undefined);
      for (const n of await readdir(d).catch(() => [] as string[])) await relax(join(d, n));
    }
  };
  await relax(dir);
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    return false;
  }
  return gone();
}

/** true if `child` is `parent` or inside it (string-level, after both are absolute and normalised) */
export const isInside = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
