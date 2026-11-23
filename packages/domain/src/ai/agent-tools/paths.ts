import { AGENT_TOOL_LIMITS as L } from './limits';

/**
 * Paths and globs a model may name (D-46, SCR-K-10 §3). A model's path is hostile input: it is normalised or REFUSED, never "fixed" into something else, and it only ever indexes
 * an in-memory snapshot (there is no filesystem behind it), so a traversal has nothing to reach; the checks exist because the refusal is part of the contract and because the
 * same strings are audited and shown.
 */
const BAD_CHARS =
  // eslint-disable-next-line no-control-regex -- control, bidi and zero-width characters are rejected on purpose
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\\]/;
const ENCODED = /%(?:2e|2f|5c|00)/i;
const DRIVE = /^[A-Za-z]:/;

export type PathResult = { ok: true; path: string } | { ok: false };

/** A file path: relative, `/`-separated, no `.`/`..`/empty segments, bounded. */
export function normalizeToolPath(raw: unknown): PathResult {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > L.pathMaxChars)
    return { ok: false };
  if (BAD_CHARS.test(raw) || ENCODED.test(raw) || DRIVE.test(raw)) return { ok: false };
  if (raw.startsWith('/') || raw.startsWith('~') || raw.endsWith('/')) return { ok: false };
  if (raw !== raw.normalize('NFC')) return { ok: false };
  const parts = raw.split('/');
  if (parts.length > L.pathMaxSegments) return { ok: false };
  for (const p of parts)
    if (p === '' || p === '.' || p === '..' || p.length > L.segmentMaxChars) return { ok: false };
  return { ok: true, path: raw };
}

/** A directory: the root (`""` or `"."`) or a path as above, with at most one trailing slash. */
export function normalizeToolDir(raw: unknown): { ok: true; dir: string } | { ok: false } {
  if (raw === undefined || raw === '' || raw === '.' || raw === './') return { ok: true, dir: '' };
  if (typeof raw !== 'string') return { ok: false };
  const r = normalizeToolPath(raw.endsWith('/') ? raw.slice(0, -1) : raw);
  return r.ok ? { ok: true, dir: r.path } : { ok: false };
}

const SENSITIVE_SEGMENT: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.(npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg)$/i,
  /^(credentials|secrets?)(\..*)?$/i,
  /^service[-_]account.*\.json$/i,
  /\.tfstate(\..*)?$/i,
];
const SENSITIVE_DIR = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', 'node_modules']);

/**
 * Files an agent never reads, searches or lists, whatever the project holds: environment files, private keys, credential stores, VCS internals, installed packages. The project
 * pipeline already refuses to store a secret, so this is defence in depth, applied by name before any content is touched.
 */
export function isAgentSensitivePath(path: string): boolean {
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (i < parts.length - 1 && SENSITIVE_DIR.has(seg.toLowerCase())) return true;
    if (
      i === parts.length - 1 &&
      (SENSITIVE_SEGMENT.some((r) => r.test(seg)) || SENSITIVE_DIR.has(seg.toLowerCase()))
    )
      return true;
  }
  return false;
}

/** True when `path` is `dir` itself or inside it (`dir` is `""` for the root). */
export const inDir = (path: string, dir: string): boolean =>
  dir === '' || path === dir || path.startsWith(`${dir}/`);

export interface GlobMatcher {
  test(path: string): boolean;
}
type GlobToken =
  { k: 'lit'; c: string } | { k: 'one' } | { k: 'star' } | { k: 'deep' } | { k: 'dirs' };

/**
 * A glob (`*`, `**`, `?`) as a matcher, or `null` for anything outside a small safe alphabet. It is NOT a regular expression: matching is a memoised walk over (position, token),
 * so its cost is at most (path length x token count) whatever the pattern looks like: a hostile glob cannot make it backtrack. The number of wildcards, the glob and the path are
 * bounded as well. `*` is any run of characters except `/`, `**` any run including `/`, `**` followed by `/` zero or more whole directories, `?` one character except `/`.
 */
export function compileGlob(glob: unknown): GlobMatcher | null {
  if (typeof glob !== 'string' || glob.length < 1 || glob.length > L.globMaxChars) return null;
  if (!/^[A-Za-z0-9_\-./*?@+~ ]+$/.test(glob)) return null;
  if (glob.includes('..') || glob.startsWith('/')) return null;
  if ((glob.match(/[*?]/g) ?? []).length > L.globMaxWildcards) return null;
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        tokens.push({ k: 'dirs' });
        i += 2;
      } else {
        tokens.push({ k: 'deep' });
        i += 1;
      }
    } else if (c === '*') tokens.push({ k: 'star' });
    else if (c === '?') tokens.push({ k: 'one' });
    else tokens.push({ k: 'lit', c });
  }
  return {
    test(path: string): boolean {
      if (typeof path !== 'string' || path.length > L.pathMaxChars) return false;
      const n = path.length;
      const memo = new Map<number, boolean>();
      const go = (i: number, j: number): boolean => {
        if (j === tokens.length) return i === n;
        const key = i * (tokens.length + 1) + j;
        const hit = memo.get(key);
        if (hit !== undefined) return hit;
        const t = tokens[j]!;
        let r: boolean;
        switch (t.k) {
          case 'lit':
            r = i < n && path[i] === t.c && go(i + 1, j + 1);
            break;
          case 'one':
            r = i < n && path[i] !== '/' && go(i + 1, j + 1);
            break;
          case 'star':
            r = go(i, j + 1) || (i < n && path[i] !== '/' && go(i + 1, j));
            break;
          case 'deep':
            r = go(i, j + 1) || (i < n && go(i + 1, j));
            break;
          case 'dirs': {
            // zero directories, or one whole non-empty directory name followed by "/" and then the same again
            const e = i < n && path[i] !== '/' ? path.indexOf('/', i) : -1;
            r = go(i, j + 1) || (e > i && go(e + 1, j));
            break;
          }
        }
        memo.set(key, r);
        return r;
      };
      return go(0, 0);
    },
  };
}
