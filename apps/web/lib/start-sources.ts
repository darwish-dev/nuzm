/**
 * Where a new builder project starts from (the "+" menu of the start screen): the person's own files (a folder or files from their device), a GitHub
 * repository (through the organization's GitHub App connection), or a template. Pure helpers only: no I/O, tested in `start-sources.spec.ts`.
 *
 * Local files travel as the web-app pipeline's safe-diff patch set (`POST …/changes`), so the API's path, size, secret and canary checks apply to them as
 * they do to any change. This module only keeps out what never belongs in a project (dependencies, build output, VCS folders, secrets files, binaries)
 * and splits the rest into batches the API accepts.
 */

/** the API's limits (apps/api … changes/change.service.ts, sandbox/paths.ts), kept a little under so a batch is never refused for size */
export const MAX_PATCHES_PER_CHANGE = 200;
export const MAX_BATCH_BYTES = 4_500_000;
export const MAX_FILE_BYTES = 1_000_000;
/** the API's per-project file limit (MAX_PROJECT_FILES) */
export const MAX_IMPORT_FILES = 5_000;

export type SkipReason = 'ignored' | 'secret' | 'binary' | 'large';

/** folders that are generated, installed or private, at any depth */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.dart_tool',
  '.gradle',
  'Pods',
  '__pycache__',
  '.venv',
  'venv',
  '.claude',
  '.yarn',
  '.pnpm-store',
  'bower_components',
  'jspm_packages',
  'vendor',
  '.expo',
  '.svelte-kit',
  '.parcel-cache',
  '.output',
  '.vercel',
  '.netlify',
  '.angular',
  '.docusaurus',
  'target',
  'DerivedData',
  '.terraform',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.sass-cache',
  'tmp',
  'logs',
]);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
/** files that usually hold credentials: never uploaded (the person keeps them on their device) */
const SECRET_FILE =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|credentials(\.json)?|service-account.*\.json)$/i;
/** the project pipeline stores text; these are binary formats */
const BINARY_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tiff',
  'psd',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'wav',
  'ogg',
  'flac',
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'tar',
  'jar',
  'war',
  'apk',
  'aab',
  'ipa',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'class',
  'o',
  'a',
  'wasm',
  'pyc',
  'sqlite',
  'db',
  'lock-binary',
]);

/** A path relative to the project, `/`-separated, without leading `./` or `/`. */
export function cleanPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/{2,}/g, '/');
}

/** When every path starts with the same top folder (a picked directory), drop it: `my-app/src/a.ts` → `src/a.ts`. */
export function stripCommonRoot(paths: readonly string[]): string[] {
  const clean = paths.map(cleanPath);
  if (clean.length === 0) return clean;
  const first = clean[0]!.split('/')[0]!;
  const all = clean.every((p) => p.includes('/') && p.split('/')[0] === first);
  return all ? clean.map((p) => p.slice(first.length + 1)) : clean;
}

/** Why a file is left out, or null when it is imported. `size` is in bytes. */
export function skipReason(path: string, size: number): SkipReason | null {
  const p = cleanPath(path);
  const segs = p.split('/');
  const name = segs[segs.length - 1] ?? '';
  if (segs.slice(0, -1).some((s) => IGNORED_DIRS.has(s)) || IGNORED_FILES.has(name))
    return 'ignored';
  if (SECRET_FILE.test(name) && !/\.(example|sample|template)$/i.test(name)) return 'secret';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (BINARY_EXT.has(ext)) return 'binary';
  if (size > MAX_FILE_BYTES) return 'large';
  return null;
}

/**
 * The project's own `.gitignore` (the root one): what the person never commits is not uploaded either. Supports the common forms — names, `*`, `**`,
 * `?`, a leading `/` (anchored to the root), a trailing `/` (folders only) — and ignores negations (`!`), which only ever add files back.
 */
export function gitignoreMatcher(text: string): (path: string) => boolean {
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    const body = line
      .split('')
      .map((ch, i, a) => {
        if (ch === '*' && a[i + 1] === '*') return '\uE000';
        if (ch === '*' && a[i - 1] === '*') return '';
        if (ch === '*') return '[^/]*';
        if (ch === '?') return '[^/]';
        return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      })
      .join('')
      .replace(/\uE000\//g, '(?:.*/)?')
      .replace(/\uE000/g, '.*');
    rules.push({ re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`), dirOnly });
  }
  return (path: string) => {
    const segs = cleanPath(path).split('/');
    // a rule matches the file itself, or any folder on its way
    for (let n = 1; n <= segs.length; n++) {
      const sub = segs.slice(0, n).join('/');
      const isDir = n < segs.length;
      if (rules.some((r) => (!r.dirOnly || isDir) && r.re.test(sub))) return true;
    }
    return false;
  };
}

/** Text content that is really binary (a NUL byte in the first part) is left out too. */
export const looksBinary = (text: string) => text.slice(0, 8000).includes('\u0000');

/** A Flutter project (pubspec.yaml at the root) starts as a mobile app; anything else as a web app. */
export function guessProjectType(paths: readonly string[]): 'mobile' | 'webapp' {
  return paths.some((p) => cleanPath(p) === 'pubspec.yaml') ? 'mobile' : 'webapp';
}

/** The folder or file name shown on the source chip. */
export function sourceLabel(rawPaths: readonly string[]): string {
  const clean = rawPaths.map(cleanPath);
  if (clean.length === 1) return clean[0]!.split('/').pop()!;
  const top = clean[0]?.split('/')[0] ?? '';
  return clean.every((p) => p.split('/')[0] === top && p.includes('/')) ? top : `${clean.length}`;
}

export interface Patch {
  op: 'add';
  path: string;
  content: string;
}

/** Splits files into change sets the API accepts: at most `MAX_PATCHES_PER_CHANGE` files and about `MAX_BATCH_BYTES` each. */
export function batchPatches(files: ReadonlyMap<string, string>): Patch[][] {
  const enc = new TextEncoder();
  const out: Patch[][] = [];
  let cur: Patch[] = [];
  let bytes = 0;
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const size = enc.encode(content).length;
    if (cur.length && (cur.length >= MAX_PATCHES_PER_CHANGE || bytes + size > MAX_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push({ op: 'add', path, content });
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** What the start screen holds once a source is chosen. */
export type StartSource =
  | {
      kind: 'local';
      label: string;
      files: Map<string, string>;
      skipped: Record<SkipReason, number>;
      type: 'mobile' | 'webapp';
    }
  | { kind: 'github'; fullName: string; private: boolean };

export const emptySkipped = (): Record<SkipReason, number> => ({
  ignored: 0,
  secret: 0,
  binary: 0,
  large: 0,
});
export const skippedTotal = (s: Record<SkipReason, number>) =>
  s.ignored + s.secret + s.binary + s.large;
