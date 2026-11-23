import { lines, obj, parseJson, entries } from './util';

/** Resolved versions from lockfiles. Text only; best effort; anything unreadable yields no version (the declared range is then reported as declared). */
export interface Lock {
  kind: 'npm' | 'yarn' | 'pnpm' | 'pub';
  /** `name` → versions in preference order, per importer (project path relative to the lockfile directory, `.` for the root). */
  resolve: (importer: string, name: string, range: string | null) => string | null;
}
const clean = (v: string) =>
  v
    .replace(/\(.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();

export function parsePackageLock(text: string | null): Lock | null {
  const j = parseJson(text);
  if (!j) return null;
  const packages = obj(j.packages);
  const legacy = obj(j.dependencies);
  return {
    kind: 'npm',
    resolve(importer, name) {
      const tries =
        importer === '.'
          ? [`node_modules/${name}`]
          : [`${importer}/node_modules/${name}`, `node_modules/${name}`];
      for (const k of tries) {
        const e = Object.hasOwn(packages, k) ? obj(packages[k]) : null;
        if (e && typeof e.version === 'string') return clean(e.version);
      }
      const l = Object.hasOwn(legacy, name) ? obj(legacy[name]) : null;
      return l && typeof l.version === 'string' ? clean(l.version) : null;
    },
  };
}
export function parseYarnLock(text: string | null): Lock | null {
  if (!text) return null;
  const byKey = new Map<string, string>();
  const byName = new Map<string, Set<string>>();
  let keys: string[] = [];
  for (const [, l] of lines(text, 200_000)) {
    if (l && !l.startsWith(' ') && !l.startsWith('#') && l.endsWith(':')) {
      keys = l
        .slice(0, -1)
        .split(',')
        .map((k) => k.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    } else {
      const m = /^ {2}version:? "?([^"\s]+)"?$/.exec(l);
      if (m && keys.length) {
        for (const k of keys) {
          const at = k.lastIndexOf('@');
          if (at <= 0) continue;
          const name = k.slice(0, at);
          byKey.set(k, m[1]!);
          (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(m[1]!);
        }
        keys = [];
      }
    }
  }
  if (byKey.size === 0) return null;
  return {
    kind: 'yarn',
    resolve(_i, name, range) {
      if (range && byKey.has(`${name}@${range}`)) return byKey.get(`${name}@${range}`)!;
      const all = byName.get(name);
      return all && all.size === 1 ? [...all][0]! : null;
    },
  };
}
/** pnpm: `importers:` (v6+) or the top level (older). Reads `version:` under each dependency of each importer. */
export function parsePnpmLock(text: string | null): Lock | null {
  if (!text) return null;
  const map = new Map<string, Map<string, string>>();
  let importer = '.';
  let inImporters = false;
  let name: string | null = null;
  for (const [, raw] of lines(text, 300_000)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (indent === 0) {
      inImporters = t === 'importers:';
      importer = '.';
      name = null;
      continue;
    }
    if (inImporters && indent === 2 && t.endsWith(':')) {
      importer = t.slice(0, -1).replace(/^['"]|['"]$/g, '');
      name = null;
      continue;
    }
    const depIndent = inImporters ? 6 : 4;
    if (indent === depIndent && t.endsWith(':')) name = t.slice(0, -1).replace(/^['"]|['"]$/g, '');
    else if (indent === depIndent + 2 && t.startsWith('version:') && name) {
      const v = clean(t.slice(8));
      if (/^\d/.test(v))
        (map.get(importer) ?? map.set(importer, new Map()).get(importer)!).set(name, v);
    }
  }
  if (map.size === 0) return null;
  return { kind: 'pnpm', resolve: (i, n) => map.get(i)?.get(n) ?? null };
}
export function parsePubLock(text: string | null): Lock | null {
  if (!text) return null;
  const m = new Map<string, string>();
  let name: string | null = null;
  let inPackages = false;
  for (const [, l] of lines(text, 100_000)) {
    if (!l.startsWith(' ')) inPackages = l.trim() === 'packages:';
    else if (inPackages) {
      const a = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(l);
      if (a) name = a[1]!;
      const v = /^ {4}version:\s*"?([^"\s]+)"?\s*$/.exec(l);
      if (v && name) m.set(name, v[1]!);
    }
  }
  return m.size ? { kind: 'pub', resolve: (_i, n) => m.get(n) ?? null } : null;
}
export const lockOfFile = (basename: string, text: string | null): Lock | null =>
  basename === 'package-lock.json' || basename === 'npm-shrinkwrap.json'
    ? parsePackageLock(text)
    : basename === 'yarn.lock'
      ? parseYarnLock(text)
      : basename === 'pnpm-lock.yaml'
        ? parsePnpmLock(text)
        : basename === 'pubspec.lock'
          ? parsePubLock(text)
          : null;
export const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pubspec.lock',
] as const;
void entries;
