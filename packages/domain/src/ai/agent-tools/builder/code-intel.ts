import { isAgentSensitivePath } from '../paths';

/**
 * Code intelligence over an in-memory project snapshot (S-05): imports, the import graph, exported symbols and symbol search. Static text analysis only: nothing is parsed by
 * running it, and every loop is bounded by file count, bytes and matches. Used by the review pass, the repair loop and the read-only search tools.
 */
export const INTEL_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 1_000_000,
  maxImportsPerFile: 2_000,
  maxSymbolsPerFile: 500,
  maxResults: 100,
  maxCycles: 20,
} as const;

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
export const isCodePath = (p: string) => CODE_EXT.test(p);
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'] as const;

/** Names of Node's own modules, used only to tell `import 'path'` from a package that must be declared. */
const NODE_BUILTINS = new Set(
  'assert buffer child_process cluster console constants crypto dgram dns domain events fs http http2 https module net os path perf_hooks process punycode querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib'.split(' '),
);

/** Replaces comments with spaces (newlines kept, so line numbers stay right). Strings are left alone: an import specifier IS a string. */
function blankComments(text: string): string {
  let out = '';
  let i = 0;
  let q: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (q) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === q || (c === '\n' && q !== '`')) q = null;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else {
      if (c === '"' || c === "'" || c === '`') q = c;
      out += c;
      i++;
    }
  }
  return out;
}

export interface ImportRef {
  spec: string;
  kind: 'static' | 'dynamic' | 'require';
  line: number;
}
const IMPORT_RES: { re: RegExp; kind: ImportRef['kind'] }[] = [
  { re: /(?:^|[\s;])import\s+(?:[\w*${},\s]+?\s+from\s+)?(['"])([^'"\n]{1,300})\1/g, kind: 'static' },
  { re: /(?:^|[\s;])export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s+(['"])([^'"\n]{1,300})\1/g, kind: 'static' },
  { re: /\bimport\s*\(\s*(['"])([^'"\n]{1,300})\1\s*\)/g, kind: 'dynamic' },
  { re: /\brequire\s*\(\s*(['"])([^'"\n]{1,300})\1\s*\)/g, kind: 'require' },
];

export function parseImports(text: string): ImportRef[] {
  if (text.length > INTEL_LIMITS.maxFileBytes) return [];
  const clean = blankComments(text);
  const out: ImportRef[] = [];
  for (const { re, kind } of IMPORT_RES) {
    re.lastIndex = 0;
    for (const m of clean.matchAll(re)) {
      if (out.length >= INTEL_LIMITS.maxImportsPerFile) return out;
      const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
      out.push({ spec: m[2]!, kind, line: clean.slice(0, at).split('\n').length });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const isRelative = (s: string) => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');
/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg` */
export function packageName(spec: string): string {
  const p = spec.split('/');
  return spec.startsWith('@') ? p.slice(0, 2).join('/') : p[0]!;
}
export const isBuiltin = (spec: string) => spec.startsWith('node:') || NODE_BUILTINS.has(spec.split('/')[0]!);

function joinPath(dir: string, rel: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escapes the project root
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export type Resolution = { ok: true; path: string } | { ok: false; reason: 'not_found' | 'outside_project' };

/** Resolves a relative (or `@/`, `~/` alias) specifier the way a bundler would: exact, with an extension, as a directory index, and `.js` written for a `.ts` source. */
export function resolveImport(fromPath: string, spec: string, files: ReadonlyMap<string, string>): Resolution {
  let base: string | null;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  if (isRelative(spec)) base = joinPath(dir, spec);
  else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const rest = spec.slice(2);
    for (const root of ['src', '']) {
      const r = tryResolve(root ? `${root}/${rest}` : rest, files);
      if (r) return { ok: true, path: r };
    }
    return { ok: false, reason: 'not_found' };
  } else return { ok: false, reason: 'not_found' };
  if (base === null) return { ok: false, reason: 'outside_project' };
  const r = tryResolve(base, files);
  return r ? { ok: true, path: r } : { ok: false, reason: 'not_found' };
}
function tryResolve(base: string, files: ReadonlyMap<string, string>): string | null {
  if (files.has(base)) return base;
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  for (const b of stripped === base ? [base] : [stripped, base])
    for (const e of RESOLVE_EXT) if (files.has(b + e)) return b + e;
  for (const e of RESOLVE_EXT) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`;
  return null;
}
export interface ImportAnalysis {
  /** file -> project files it imports */
  graph: Map<string, string[]>;
  unresolved: { path: string; spec: string; line: number; reason: 'not_found' | 'outside_project' }[];
  /** bare packages imported but not declared in package.json */
  missingPackages: { path: string; pkg: string; line: number }[];
  /** packages declared in `dependencies` but never imported (information only) */
  unusedDependencies: string[];
  cycles: string[][];
  truncated: boolean;
}

function declaredPackages(files: ReadonlyMap<string, string>): { all: Set<string>; deps: Set<string> } | null {
  const raw = files.get('package.json');
  if (raw === undefined) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const names = (k: string) => (j[k] && typeof j[k] === 'object' ? Object.keys(j[k] as object) : []);
    const deps = new Set(names('dependencies'));
    return { deps, all: new Set([...deps, ...names('devDependencies'), ...names('peerDependencies'), ...names('optionalDependencies')]) };
  } catch {
    return null;
  }
}

export function analyzeImports(files: ReadonlyMap<string, string>): ImportAnalysis {
  const graph = new Map<string, string[]>();
  const unresolved: ImportAnalysis['unresolved'] = [];
  const missingPackages: ImportAnalysis['missingPackages'] = [];
  const declared = declaredPackages(files);
  const used = new Set<string>();
  let truncated = false;
  let n = 0;
  for (const [path, text] of files) {
    if (!isCodePath(path) || isAgentSensitivePath(path)) continue;
    if (++n > INTEL_LIMITS.maxFiles) {
      truncated = true;
      break;
    }
    const deps = new Set<string>();
    for (const imp of parseImports(text)) {
      if (isRelative(imp.spec) || imp.spec.startsWith('@/') || imp.spec.startsWith('~/')) {
        const r = resolveImport(path, imp.spec, files);
        if (r.ok) deps.add(r.path);
        else unresolved.push({ path, spec: imp.spec, line: imp.line, reason: r.reason });
      } else if (!isBuiltin(imp.spec)) {
        const pkg = packageName(imp.spec);
        used.add(pkg);
        if (declared && !declared.all.has(pkg) && !pkg.startsWith('@types/')) missingPackages.push({ path, pkg, line: imp.line });
      }
    }
    graph.set(path, [...deps].sort());
  }
  return {
    graph,
    unresolved,
    missingPackages,
    unusedDependencies: declared ? [...declared.deps].filter((d) => !used.has(d)).sort() : [],
    cycles: findCycles(graph),
    truncated,
  };
}

/** Import cycles (strongly connected components of size > 1, and self-imports), each reported once as a sorted member list. Iterative Tarjan: no recursion limit on deep graphs. */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    while (work.length) {
      const f = work[work.length - 1]!;
      if (f.i === 0) {
        index.set(f.v, idx);
        low.set(f.v, idx);
        idx++;
        stack.push(f.v);
        onStack.add(f.v);
      }
      const edges = graph.get(f.v) ?? [];
      if (f.i < edges.length) {
        const w = edges[f.i++]!;
        if (!graph.has(w)) continue;
        if (!index.has(w)) work.push({ v: w, i: 0 });
        else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(f.v)!));
        if (low.get(f.v) === index.get(f.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== f.v);
          if (comp.length > 1 || (graph.get(f.v) ?? []).includes(f.v)) out.push(comp.sort());
        }
      }
    }
  }
  return out.sort((a, b) => (a[0]! < b[0]! ? -1 : 1)).slice(0, INTEL_LIMITS.maxCycles);
}

export type SymbolKind = 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum';
export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  exported: boolean;
}
const SYMBOL_RES: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(export\s+)?(?:declare\s+)?const\s+enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*(export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type' },
  { re: /^\s*(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
];

export function extractSymbols(path: string, text: string): CodeSymbol[] {
  if (!isCodePath(path) || text.length > INTEL_LIMITS.maxFileBytes) return [];
  const out: CodeSymbol[] = [];
  const lines = blankComments(text).split('\n');
  for (let i = 0; i < lines.length && out.length < INTEL_LIMITS.maxSymbolsPerFile; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    for (const { re, kind } of SYMBOL_RES) {
      const m = re.exec(line);
      if (m) {
        out.push({ name: m[2]!, kind, path, line: i + 1, exported: !!m[1] });
        break;
      }
    }
  }
  return out;
}

export interface SymbolHit extends CodeSymbol {
  /** 3 exact, 2 prefix, 1 contains (case-insensitive) */
  rank: 1 | 2 | 3;
}
/** Symbol search over the project (sensitive paths are never read). Best match first, then path, then line; at most `limit` results. */
export function searchSymbols(
  files: ReadonlyMap<string, string>,
  query: string,
  opts: { kind?: SymbolKind; exportedOnly?: boolean; limit?: number } = {},
): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 1 || q.length > 100) return [];
  const limit = Math.min(opts.limit ?? 20, INTEL_LIMITS.maxResults);
  const hits: SymbolHit[] = [];
  let n = 0;
  for (const [path, text] of files) {
    if (!isCodePath(path) || isAgentSensitivePath(path)) continue;
    if (++n > INTEL_LIMITS.maxFiles) break;
    for (const s of extractSymbols(path, text)) {
      if (opts.kind && s.kind !== opts.kind) continue;
      if (opts.exportedOnly && !s.exported) continue;
      const name = s.name.toLowerCase();
      const rank = name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0;
      if (rank) hits.push({ ...s, rank: rank as 1 | 2 | 3 });
    }
  }
  return hits
    .sort((a, b) => b.rank - a.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line)
    .slice(0, limit);
}
