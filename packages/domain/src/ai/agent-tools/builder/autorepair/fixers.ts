import { sha256Hex, type FileOp } from '../changeset';
import { extractSymbols, isCodePath, parseImports, resolveImport } from '../code-intel';
import type { Diagnostic } from '../diagnose';
import type { ErrorClass } from './classes';

/**
 * Deterministic repairs (P3-S03). A fixer handles ONE error class with a mechanical edit that is provably local: it needs no model, costs no tokens and cannot be steered by text in a
 * log, because it acts only on the NAMES the diagnostic carries and on what the project itself contains (a symbol the project exports, a file that exists, an import line). Each fixer
 * answers `null` the moment it is not certain (two candidate files, a multi-line import, a name nothing in the project exports): the case then goes to the model strategy. A fixer
 * never invents: it adds no dependency, no version, no file, and never touches a path the diagnostic does not name or the project does not already import.
 */
export interface FixerInput {
  files: ReadonlyMap<string, string>;
  diagnostics: readonly Diagnostic[];
}
export interface FixerResult {
  /** the fixer's id (a row of the strategy corpus) */
  id: string;
  class: ErrorClass;
  ops: FileOp[];
  /** how many diagnostics this fixer answered */
  fixed: number;
  note: string;
}
export type Fixer = (i: FixerInput) => FixerResult | null;

const modify = (path: string, before: string, after: string): FileOp => ({
  op: 'modify',
  path,
  content: after,
  expectedHash: sha256Hex(before),
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stripExt = (p: string) => p.replace(/\.(?:tsx?|jsx?|mjs|cjs|dart)$/, '');

/** `from`-relative specifier of `to` (no extension for JS/TS, `./` prefix, `/`-separated). */
export function relativeSpecifier(from: string, to: string): string {
  const a = dirOf(from) === '' ? [] : dirOf(from).split('/');
  const b = stripExt(to)
    .replace(/\/index$/, '')
    .split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join('/');
  return `${up === 0 ? './' : '../'.repeat(up)}${rest}`;
}

const EXPORT_DEFAULT = (name: string) =>
  new RegExp(
    `^\\s*export\\s+default\\s+(?:async\\s+)?(?:function\\s*\\*?|class|abstract\\s+class)\\s+${escapeRe(name)}\\b`,
    'm',
  );

/** The files that export `name` (named or default) among the code files of the project. */
function exportersOf(
  files: ReadonlyMap<string, string>,
  name: string,
): { path: string; isDefault: boolean }[] {
  const out: { path: string; isDefault: boolean }[] = [];
  for (const [p, text] of files) {
    if (!isCodePath(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /\.d\.ts$/.test(p)) continue;
    const sym = extractSymbols(p, text).find((s) => s.name === name && s.exported);
    if (sym) out.push({ path: p, isDefault: EXPORT_DEFAULT(name).test(text) });
  }
  return out;
}

/** The index just after the last top-level `import` statement (or 0), counted in lines; only single-line and simple multi-line imports count. */
function importInsertLine(lines: readonly string[]): number {
  let last = -1;
  let open = false;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const l = lines[i]!;
    if (open) {
      if (/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(l) || /^\s*}\s*from/.test(l)) {
        open = false;
        last = i;
      }
      continue;
    }
    if (/^\s*import\b/.test(l)) {
      if (/from\s+['"][^'"]+['"]|^\s*import\s+['"]/.test(l)) last = i;
      else open = true;
    } else if (/^\s*(?:['"]use (?:client|server)['"];?\s*)$/.test(l)) last = Math.max(last, i);
  }
  return last + 1;
}

/** the names an `import { a, b as c } from 'x'` line binds locally */
function boundNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s+([^'"]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1]!;
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.trim());
    if (def) names.add(def[1]!);
    for (const b of clause.matchAll(/\{([^}]*)\}/g))
      for (const part of b[1]!.split(','))
        names.add(
          part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        );
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.add(ns[1]!);
  }
  return names;
}

/**
 * `Cannot find name 'X'` where exactly ONE project file exports X and the importing file neither declares nor already imports it: add `import { X } from '<relative path>'` after the
 * last import (a default export is imported as the default). Two exporters, or none, is not mechanical.
 */
export const fixMissingImport: Fixer = ({ files, diagnostics }) => {
  const ops = new Map<string, { before: string; after: string }>();
  let fixed = 0;
  const handled = new Set<string>();
  for (const d of diagnostics) {
    if (d.class !== 'undefined_name' || !d.subject || !d.path || d.kind !== 'typescript') continue;
    const key = `${d.path}|${d.subject}`;
    if (handled.has(key)) {
      fixed++;
      continue;
    }
    const text = ops.get(d.path)?.after ?? files.get(d.path);
    if (text === undefined || !isCodePath(d.path)) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(d.subject)) continue;
    if (boundNames(text).has(d.subject)) continue;
    if (extractSymbols(d.path, text).some((s) => s.name === d.subject)) continue;
    const ex = exportersOf(files, d.subject).filter((e) => e.path !== d.path);
    if (ex.length !== 1) continue;
    const spec = relativeSpecifier(d.path, ex[0]!.path);
    const stmt = ex[0]!.isDefault
      ? `import ${d.subject} from '${spec}';`
      : `import { ${d.subject} } from '${spec}';`;
    const lines = text.split('\n');
    lines.splice(importInsertLine(lines), 0, stmt);
    ops.set(d.path, { before: files.get(d.path)!, after: lines.join('\n') });
    handled.add(key);
    fixed++;
  }
  if (ops.size === 0) return null;
  return {
    id: 'add_missing_import',
    class: 'undefined_name',
    ops: [...ops].map(([p, v]) => modify(p, v.before, v.after)),
    fixed,
    note: 'added an import of a symbol the project already exports',
  };
};

/**
 * `Cannot find module './util'` where the file that was meant exists under another path (wrong case, a missing or an extra directory level, a wrong extension): rewrite the specifier
 * to the single project file with the same base name. Zero or several candidates is not mechanical.
 */
export const fixRelativeImport: Fixer = ({ files, diagnostics }) => {
  const ops = new Map<string, { before: string; after: string }>();
  let fixed = 0;
  for (const d of diagnostics) {
    if (d.class !== 'missing_module' || !d.subject || !d.path) continue;
    if (!/^(?:\.{1,2}\/|\.{1,2}$)/.test(d.subject)) continue;
    const text = ops.get(d.path)?.after ?? files.get(d.path);
    if (text === undefined) continue;
    if (resolveImport(d.path, d.subject, files).ok) continue;
    const want = stripExt(baseOf(d.subject)).toLowerCase();
    if (!want) continue;
    const candidates = [...files.keys()].filter(
      (p) => isCodePath(p) && p !== d.path && stripExt(baseOf(p)).toLowerCase() === want,
    );
    // a name that exists as several files (index.ts in two folders) is ambiguous
    if (candidates.length !== 1) continue;
    const spec = relativeSpecifier(d.path, candidates[0]!);
    const re = new RegExp(`(['"])${escapeRe(d.subject)}\\1`, 'g');
    const after = text.replace(re, `$1${spec}$1`);
    if (after === text) continue;
    ops.set(d.path, { before: files.get(d.path)!, after });
    fixed++;
  }
  if (ops.size === 0) return null;
  return {
    id: 'rewrite_relative_import',
    class: 'missing_module',
    ops: [...ops].map(([p, v]) => modify(p, v.before, v.after)),
    fixed,
    note: 'pointed a relative import at the one file that has that name',
  };
};

/**
 * `Module './x' has no exported member 'Y'` where './x' declares Y without exporting it: add `export`. Several declarations of that name, or none, is not mechanical.
 */
export const fixMissingExport: Fixer = ({ files, diagnostics }) => {
  const ops = new Map<string, { before: string; after: string }>();
  let fixed = 0;
  for (const d of diagnostics) {
    if (d.class !== 'missing_export' || !d.subject || !d.path) continue;
    const mod =
      /Module\s+['"]+([^'"]+)['"]+\s+(?:has no exported member|declares\s+['"][^'"]+['"]\s+locally)/i.exec(
        d.message,
      )?.[1];
    if (!mod || !/^[A-Za-z_$][\w$]*$/.test(d.subject)) continue;
    const r = resolveImport(d.path, mod, files);
    if (!r.ok) continue;
    const text = ops.get(r.path)?.after ?? files.get(r.path);
    if (text === undefined) continue;
    const syms = extractSymbols(r.path, text).filter((s) => s.name === d.subject);
    if (syms.length !== 1 || syms[0]!.exported) continue;
    const lines = text.split('\n');
    const at = syms[0]!.line - 1;
    const line = lines[at]!;
    if (
      !/^\s*(?:declare\s+)?(?:async\s+)?(?:function|class|abstract|const|let|var|enum|interface|type)\b/.test(
        line,
      )
    )
      continue;
    lines[at] = line.replace(/^(\s*)/, '$1export ');
    ops.set(r.path, { before: files.get(r.path)!, after: lines.join('\n') });
    fixed++;
  }
  if (ops.size === 0) return null;
  return {
    id: 'export_declared_symbol',
    class: 'missing_export',
    ops: [...ops].map(([p, v]) => modify(p, v.before, v.after)),
    fixed,
    note: 'exported a symbol that was declared but not exported',
  };
};

/**
 * An unused IMPORT (`'x' is declared but its value is never read`, dart `unused_import`): remove the name, or the whole statement when it was the only one. Only single-line imports on
 * the exact line the diagnostic names are touched; an unused local variable is not mechanical (its initialiser may have a side effect).
 */
export const fixUnusedImport: Fixer = ({ files, diagnostics }) => {
  const edits = new Map<string, { before: string; lines: string[] }>();
  let fixed = 0;
  for (const d of diagnostics) {
    if (d.class !== 'unused_symbol' || !d.path || !d.line) continue;
    const entry =
      edits.get(d.path) ??
      (() => {
        const t = files.get(d.path!);
        return t === undefined ? null : { before: t, lines: t.split('\n') };
      })();
    if (!entry) continue;
    const idx = d.line - 1;
    const line = entry.lines[idx];
    if (line === undefined) continue;
    if (d.kind === 'dart') {
      if (d.code === 'unused_import' && /^\s*import\s+['"][^'"]+['"][^;]*;\s*$/.test(line)) {
        entry.lines[idx] = '';
        edits.set(d.path, entry);
        fixed++;
      }
      continue;
    }
    if (!d.subject || !/^\s*import\b[^;]*\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) continue;
    const m = /^(\s*import\s+)(type\s+)?(.*?)(\s+from\s+['"][^'"]+['"]\s*;?\s*)$/.exec(line);
    if (!m) continue;
    const clause = m[3]!.trim();
    const names = (/^\{([^}]*)\}$/.exec(clause)?.[1] ?? null)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names) {
      const keep = names.filter(
        (n) =>
          n
            .split(/\s+as\s+/)
            .pop()!
            .replace(/^type\s+/, '')
            .trim() !== d.subject,
      );
      if (keep.length === names.length) continue;
      entry.lines[idx] =
        keep.length === 0 ? '' : `${m[1]}${m[2] ?? ''}{ ${keep.join(', ')} }${m[4]}`;
    } else if (clause === d.subject) entry.lines[idx] = '';
    else continue;
    edits.set(d.path, entry);
    fixed++;
  }
  if (edits.size === 0) return null;
  const ops: FileOp[] = [];
  for (const [p, e] of edits) {
    // an emptied import leaves no blank line behind (and no blank line at the top of the file)
    const orig = e.before.split('\n');
    const kept: string[] = [];
    for (let i = 0; i < e.lines.length; i++) {
      const l = e.lines[i]!;
      if (l === '' && orig[i] !== '') continue; // the removed import itself
      const afterRemoved = i > 0 && e.lines[i - 1] === '' && orig[i - 1] !== '';
      if (l === '' && afterRemoved && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
      kept.push(l);
    }
    const after = kept.join('\n');
    if (after !== e.before) ops.push(modify(p, e.before, after));
  }
  return ops.length === 0
    ? null
    : {
        id: 'remove_unused_import',
        class: 'unused_symbol',
        ops,
        fixed,
        note: 'removed an unused import',
      };
};

/** a dependency a monorepo sibling already declares can be reused with the SAME version: that is a copy, not an invention */
export const fixMissingPackageFromSibling: Fixer = ({ files, diagnostics }) => {
  const pkgFiles = [...files.keys()].filter(
    (p) => p === 'package.json' || p.endsWith('/package.json'),
  );
  if (pkgFiles.length < 2) return null;
  const ops = new Map<string, { before: string; json: Record<string, unknown> }>();
  let fixed = 0;
  for (const d of diagnostics) {
    if (d.class !== 'missing_package' || !d.subject || !d.path) continue;
    const spec = d.subject.startsWith('@')
      ? d.subject.split('/').slice(0, 2).join('/')
      : d.subject.split('/')[0]!;
    if (!/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(spec)) continue;
    // the package.json that owns the importing file: the nearest one up the tree
    const owner = pkgFiles
      .filter((p) => dirOf(p) === '' || d.path!.startsWith(`${dirOf(p)}/`))
      .sort((a, b) => dirOf(b).length - dirOf(a).length)[0];
    if (!owner) continue;
    const cur =
      ops.get(owner) ??
      (() => {
        try {
          return {
            before: files.get(owner)!,
            json: JSON.parse(files.get(owner)!) as Record<string, unknown>,
          };
        } catch {
          return null;
        }
      })();
    if (!cur) continue;
    const deps = (cur.json.dependencies ?? {}) as Record<string, string>;
    const dev = (cur.json.devDependencies ?? {}) as Record<string, string>;
    if (deps[spec] || dev[spec]) continue;
    let version: string | null = null;
    for (const p of pkgFiles) {
      if (p === owner) continue;
      try {
        const j = JSON.parse(files.get(p)!) as { dependencies?: Record<string, string> };
        const v = j.dependencies?.[spec];
        if (typeof v === 'string' && /^[\^~]?\d[\w.+-]*$/.test(v)) {
          version = v;
          break;
        }
      } catch {
        /* a broken sibling package.json is the JSON rule's business */
      }
    }
    if (!version) continue;
    cur.json.dependencies = { ...deps, [spec]: version };
    ops.set(owner, cur);
    fixed++;
  }
  if (ops.size === 0) return null;
  return {
    id: 'copy_sibling_dependency',
    class: 'missing_package',
    ops: [...ops].map(([p, v]) => modify(p, v.before, `${JSON.stringify(v.json, null, 2)}\n`)),
    fixed,
    note: 'declared a dependency with the version a sibling package already uses',
  };
};

/** imports in a file, for a strategy that needs to know what a diagnostic's file pulls in */
export const importsOf = (text: string): string[] => parseImports(text).map((i) => i.spec);

export const FIXERS: readonly { id: string; class: ErrorClass; run: Fixer }[] = [
  { id: 'rewrite_relative_import', class: 'missing_module', run: fixRelativeImport },
  { id: 'add_missing_import', class: 'undefined_name', run: fixMissingImport },
  { id: 'export_declared_symbol', class: 'missing_export', run: fixMissingExport },
  { id: 'remove_unused_import', class: 'unused_symbol', run: fixUnusedImport },
  { id: 'copy_sibling_dependency', class: 'missing_package', run: fixMissingPackageFromSibling },
];

/**
 * All fixers that apply, merged into ONE proposal (a path appears once: when two fixers touch the same file the later one is dropped this round and the next round picks it up from the
 * rebuilt log). Returns null when nothing applies.
 */
export function runFixers(i: FixerInput): { ops: FileOp[]; used: FixerResult[] } | null {
  const used: FixerResult[] = [];
  const touched = new Set<string>();
  const ops: FileOp[] = [];
  for (const f of FIXERS) {
    const r = f.run(i);
    if (!r) continue;
    if (r.ops.some((o) => touched.has(o.path))) continue;
    for (const o of r.ops) touched.add(o.path);
    ops.push(...r.ops);
    used.push(r);
  }
  return ops.length === 0 ? null : { ops, used };
}
