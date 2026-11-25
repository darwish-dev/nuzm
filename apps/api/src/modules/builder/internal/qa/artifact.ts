import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The static artifact a website build produces: a set of files and a manifest that binds them by content hash. `rootHash` is the SHA-256 of the sorted lines
 * `path NUL sha256 NUL size LF` of every file, so it changes when any byte, path or file is added, removed or altered, and it does not depend on the order files
 * were produced or on file metadata. The deploy target (P3-S07) serves exactly these files; `verifyServedArtifact` proves it did.
 */
export interface ArtifactFile {
  path: string;
  bytes: Uint8Array;
  mime?: string;
}
export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mime: string;
}
export interface ArtifactManifest {
  schema: 'nuzm.site-artifact/1';
  rootHash: string;
  files: ManifestEntry[];
  totalBytes: number;
  /** extra facts the builder binds to the artifact (model hash, tool versions); part of the manifest file, NOT of `rootHash` */
  provenance: Record<string, string>;
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
export const mimeOf = (p: string): string =>
  MIME_BY_EXT[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

/** A path inside an artifact: relative, `/`-separated, no empty/`.`/`..` segment, no backslash or NUL. */
export function isSafeArtifactPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export function rootHashOf(entries: { path: string; sha256: string; size: number }[]): string {
  const h = createHash('sha256');
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    h.update(`${e.path}\0${e.sha256}\0${e.size}\n`);
  return h.digest('hex');
}

export function artifactManifest(
  files: ArtifactFile[],
  provenance: Record<string, string> = {},
): ArtifactManifest {
  const seen = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const f of files) {
    if (!isSafeArtifactPath(f.path))
      throw new Error(`unsafe artifact path: ${JSON.stringify(f.path)}`);
    if (seen.has(f.path)) throw new Error(`duplicate artifact path: ${f.path}`);
    seen.add(f.path);
    entries.push({
      path: f.path,
      sha256: sha256Hex(f.bytes),
      size: f.bytes.length,
      mime: f.mime ?? mimeOf(f.path),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    schema: 'nuzm.site-artifact/1',
    rootHash: rootHashOf(entries),
    files: entries,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    provenance: Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export interface ManifestMismatch {
  path: string;
  kind: 'missing' | 'extra' | 'modified';
  expected?: string;
  actual?: string;
}
/** Compare actual files with a manifest. An empty list means the files ARE the artifact the manifest binds (and `rootHash` of both sides is equal). */
export function verifyAgainstManifest(
  manifest: ArtifactManifest,
  files: ArtifactFile[],
): ManifestMismatch[] {
  const want = new Map(manifest.files.map((e) => [e.path, e]));
  const out: ManifestMismatch[] = [];
  const got = new Map(files.map((f) => [f.path, f]));
  for (const [p, e] of want) {
    const f = got.get(p);
    if (!f) out.push({ path: p, kind: 'missing', expected: e.sha256 });
    else {
      const actual = sha256Hex(f.bytes);
      if (actual !== e.sha256) out.push({ path: p, kind: 'modified', expected: e.sha256, actual });
    }
  }
  for (const p of got.keys()) if (!want.has(p)) out.push({ path: p, kind: 'extra' });
  return out;
}

/**
 * W4: prove that what a deploy target SERVES is the built artifact. `fetchServed(path)` returns the bytes the target answers for that path (or `undefined` for a
 * non-200). Each manifest file must be served byte-identically. The fetcher is injected: S07 passes a real HTTP client, tests pass the preview service.
 */
export async function verifyServedArtifact(
  manifest: ArtifactManifest,
  fetchServed: (path: string) => Promise<Uint8Array | undefined>,
): Promise<{ ok: boolean; servedRootHash: string | null; mismatches: ManifestMismatch[] }> {
  const mismatches: ManifestMismatch[] = [];
  const served: { path: string; sha256: string; size: number }[] = [];
  for (const e of manifest.files) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await fetchServed(e.path);
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      mismatches.push({ path: e.path, kind: 'missing', expected: e.sha256 });
      continue;
    }
    const actual = sha256Hex(bytes);
    served.push({ path: e.path, sha256: actual, size: bytes.length });
    if (actual !== e.sha256)
      mismatches.push({ path: e.path, kind: 'modified', expected: e.sha256, actual });
  }
  const complete = mismatches.length === 0;
  return { ok: complete, servedRootHash: complete ? rootHashOf(served) : null, mismatches };
}

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Read an artifact directory. Symbolic links, special files, oversized files and too many files are refused (a build output must be plain files). */
export async function loadArtifactDir(dir: string): Promise<ArtifactFile[]> {
  const root = path.resolve(dir);
  const out: ArtifactFile[] = [];
  const rec = async (rel: string): Promise<void> => {
    const abs = path.join(root, rel);
    for (const name of (await readdir(abs)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = await lstat(path.join(root, r));
      if (st.isSymbolicLink())
        throw new Error(`symbolic links are not allowed in an artifact: ${r}`);
      if (st.isDirectory()) await rec(r);
      else if (st.isFile()) {
        if (out.length >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
        if (st.size > MAX_FILE_BYTES)
          throw new Error(`${r} is larger than ${MAX_FILE_BYTES} bytes`);
        out.push({ path: r, bytes: await readFile(path.join(root, r)) });
      } else throw new Error(`not a regular file: ${r}`);
    }
  };
  await rec('');
  return out;
}

/** Write an artifact: the files under `<dir>/site/` and the manifest as `<dir>/manifest.json` (outside the served tree). */
export async function writeArtifactDir(
  dir: string,
  files: ArtifactFile[],
  manifest: ArtifactManifest,
): Promise<{ siteDir: string; manifestPath: string }> {
  const siteDir = path.join(path.resolve(dir), 'site');
  for (const f of files) {
    if (!isSafeArtifactPath(f.path))
      throw new Error(`unsafe artifact path: ${JSON.stringify(f.path)}`);
    const abs = path.join(siteDir, f.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.bytes);
  }
  const manifestPath = path.join(path.resolve(dir), 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { siteDir, manifestPath };
}
