import { scanForSecrets } from '@nuzm/domain';
import type { ParsedBuildError } from './types';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** strip ANSI colour codes and control characters; normalise line endings */
export const clean = (s: string): string =>
  s.replace(/\r\n?/g, '\n').replace(ANSI, '').replace(CTRL, '');

/** redact anything the secret scanner recognises; a build log may contain an environment echo, a token in a URL, a signing property */
export function redact(line: string): string {
  let out = line;
  const found = scanForSecrets(line);
  if (found.length > 0) out = '[line withheld: matched a secret pattern]';
  // userinfo in URLs and long hex/base64-looking tokens that follow `token=`/`password=`
  out = out.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@');
  out = out.replace(
    /((?:token|password|passwd|secret|storePassword|keyPassword)\s*[=:]\s*)\S+/gi,
    '$1[redacted]',
  );
  return out;
}

/**
 * Make a log safe to hand to a model or store: paths under the build root become project-relative, every other absolute host path (home directories, SDK and cache locations,
 * temp dirs) becomes `<host-path>`, so no layout of the build machine leaks into prompts, reports or evidence.
 */
export function scrubHostPaths(text: string, roots: readonly string[] = []): string {
  let out = text;
  for (const r of roots) {
    const root = r.replace(/\/+$/, '');
    if (root) out = out.split(`file://${root}/`).join('').split(`${root}/`).join('');
  }
  return out.replace(
    /(?<![\w.:/<-])\/(?:Users|home|private|var|opt|usr|tmp|root|Library|Applications|work|mnt|srv|Volumes)\/[^\s'"():,;]*?([^\s'"():,;/]*)(?=[\s'"():,;]|$)/g,
    (_m, base: string) => `<host-path>/${base}`,
  );
}

export const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Reduce a path a tool printed to a project-relative one. Absolute paths under the build root are made relative; any other absolute path (the SDK, a pub cache, `/Users/...`)
 * returns `undefined`: the loop must not edit files outside the project and the path must not leak the host layout.
 */
export function projectPath(p: string, roots: readonly string[] = []): string | undefined {
  let q = p
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/');
  if (q.startsWith('./')) q = q.slice(2);
  for (const r of roots) {
    const root = r.replace(/\/+$/, '');
    if (root && q.startsWith(root + '/')) return q.slice(root.length + 1);
  }
  if (q.startsWith('/') || /^[A-Za-z]:\//.test(q) || q.includes('<')) return undefined;
  if (q.split('/').includes('..')) return undefined;
  return q;
}

/** keep only lines in [from, from+n) as one excerpt */
export const excerptOf = (lines: string[], from: number, n = 3): string =>
  cap(
    lines
      .slice(from, from + n)
      .map((l) => redact(l.trimEnd()))
      .join('\n'),
    800,
  );

export function dedupe(list: ParsedBuildError[]): ParsedBuildError[] {
  const seen = new Set<string>();
  const out: ParsedBuildError[] = [];
  for (const e of list) {
    const k = `${e.tool}|${e.errorClass}|${e.file ?? ''}|${e.line ?? ''}|${e.column ?? ''}|${e.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** files a source repair may touch: Dart sources under lib/ or test/, never generated or platform files */
export const editableSource = (path: string | undefined): string[] =>
  path && /^(lib|test)\/.+\.dart$/.test(path) && !path.startsWith('lib/generated/') ? [path] : [];
