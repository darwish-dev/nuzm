/** Minimal semantic-version helpers for entitlement version ranges (`*`, exact, `^`, `~`, `>=`, `>`, `<=`, `<`, space = AND). No dependency, no regex backtracking hazards. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}
const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
export function parseSemver(v: string): Semver | null {
  const m = RE.exec(v);
  return m
    ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
    : null;
}
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ['major', 'minor', 'patch'] as const)
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1; // a release is newer than its prerelease
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}
function atom(v: Semver, term: string): boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(term);
  const op = m?.[1] ?? '=';
  const base = m ? parseSemver(m[2]!) : null;
  if (!base) return false;
  const c = compareSemver(v, base);
  switch (op) {
    case '=':
      return c === 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '~':
      return c >= 0 && v.major === base.major && v.minor === base.minor;
    case '^':
      return (
        c >= 0 &&
        (base.major > 0
          ? v.major === base.major
          : base.minor > 0
            ? v.major === 0 && v.minor === base.minor
            : v.major === 0 && v.minor === 0 && v.patch === base.patch)
      );
    default:
      return false;
  }
}
/** Does `version` satisfy `range`? A malformed version or range never matches (fail closed). A prerelease only matches an exact or comparator range that names a prerelease. */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v || typeof range !== 'string' || range.length > 100) return false;
  const r = range.trim();
  if (r === '*') return v.pre === null;
  const terms = r.split(/\s+/);
  if (terms.length === 0 || terms.length > 4) return false;
  if (v.pre !== null && !terms.some((t) => /-/.test(t))) return false;
  return terms.every((t) => atom(v, t));
}
export const validRange = (range: string): boolean =>
  range === '*' ||
  (/^[\^~<>=0-9a-zA-Z. -]{1,100}$/.test(range) &&
    range
      .split(/\s+/)
      .every((t) =>
        /^(\^|~|>=|<=|>|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(t),
      ));
