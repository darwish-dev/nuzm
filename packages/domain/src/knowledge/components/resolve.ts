import { dirname, join } from '../detect/util';

const TS_EXT = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];
/** Normalises `a/b/../c` inside the package; null when the path climbs out of it. */
export function normalize(p: string): string | null {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}
export interface Alias {
  /** `@/` for the pattern `@/*`; exact patterns have `exact: true`. */
  prefix: string;
  exact: boolean;
  targets: string[];
}
/** `compilerOptions.baseUrl` and `paths` of a tsconfig, as project-relative alias targets. */
export function aliasesOf(root: string, tsconfig: Record<string, unknown> | null): Alias[] {
  const co =
    tsconfig && typeof tsconfig.compilerOptions === 'object' && tsconfig.compilerOptions
      ? (tsconfig.compilerOptions as Record<string, unknown>)
      : {};
  const base = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
  const paths =
    co.paths && typeof co.paths === 'object' ? (co.paths as Record<string, unknown>) : {};
  const out: Alias[] = [];
  for (const [pat, tgt] of Object.entries(paths).slice(0, 50)) {
    if (!Array.isArray(tgt)) continue;
    const targets = tgt
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 5)
      .map((t) => normalize(join(join(root, base), t.replace(/\*$/, ''))))
      .filter((x): x is string => x !== null);
    const star = pat.endsWith('*');
    out.push({ prefix: star ? pat.slice(0, -1) : pat, exact: !star, targets });
  }
  return out;
}
export function resolveTs(
  from: string,
  spec: string,
  files: Set<string>,
  aliases: Alias[],
): string | null {
  const tryBase = (b: string | null): string | null => {
    if (b === null) return null;
    // `./x.js` in TypeScript source means `./x.ts`
    const stripped = b.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
    for (const base of stripped !== b ? [b, stripped] : [b])
      for (const e of TS_EXT) if (files.has(`${base}${e}`)) return `${base}${e}`;
    return null;
  };
  if (spec.startsWith('.')) return tryBase(normalize(`${dirname(from)}/${spec}`));
  for (const a of aliases) {
    if (a.exact ? spec === a.prefix : spec.startsWith(a.prefix)) {
      const rest = a.exact ? '' : spec.slice(a.prefix.length);
      for (const t of a.targets) {
        const hit = tryBase(normalize(rest ? `${t}/${rest}` : t));
        if (hit) return hit;
      }
    }
  }
  return null;
}
export function resolveDart(
  from: string,
  spec: string,
  files: Set<string>,
  pkg: { name: string | null; root: string },
): string | null {
  const m = /^package:([^/]+)\/(.*)$/.exec(spec);
  if (m)
    return m[1] === pkg.name && files.has(join(pkg.root, `lib/${m[2]}`))
      ? join(pkg.root, `lib/${m[2]}`)
      : null;
  const p = normalize(`${dirname(from)}/${spec}`);
  return p && files.has(p) ? p : null;
}
