import { resolveDart, resolveTs, type Alias } from './resolve';
import {
  COMPONENT_ANALYZER_VERSION,
  LIMITS,
  type ArchitectureSummary,
  type AssembleResult,
  type ComponentFact,
  type ComponentRow,
  type FileFacts,
  type ImportFact,
  type RelationshipRow,
} from './types';

/** Everything needed to turn per-file facts into rows, relationships and an architecture summary. Pure and deterministic. */
export interface AssembleProject {
  root: string;
  name: string | null;
  kind: string;
  aliases: Alias[];
  dartPackage: string | null;
  entryPoints: string[];
  platforms: string[];
}
export interface AssembleFile {
  path: string;
  project: string;
  facts: FileFacts;
}
export interface AssembleRoute {
  kind: string;
  path: string;
  file: string;
  project: string;
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pkgName = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
const SPECIAL_ENTRY =
  /(?:^|\/)(?:layout|page|loading|error|not-found|template|route|middleware)\.(?:tsx|ts|jsx|js)$|(?:^|\/)main\.(?:ts|tsx|js|dart)$/;
const nextKind = (path: string): 'next-page' | 'next-layout' | null =>
  /(?:^|\/)(?:src\/)?app\/(?:.*\/)?layout\.(?:tsx|jsx|js|ts)$/.test(path)
    ? 'next-layout'
    : /(?:^|\/)(?:src\/)?app\/(?:.*\/)?page\.(?:tsx|jsx|js|ts)$/.test(path) ||
        /(?:^|\/)(?:src\/)?pages\/(?!_)(?:.*\/)?[^/]+\.(?:tsx|jsx)$/.test(path)
      ? 'next-page'
      : null;
const NON_ORPHAN = new Set([
  'next-page',
  'next-layout',
  'nest-module',
  'nest-controller',
  'nest-provider',
  'nest-dto',
  'flutter-state',
  'flutter-state-holder',
  'flutter-provider',
]);

const ROLE: [RegExp, string][] = [
  [/^(components?|widgets?|ui)$/i, 'ui'],
  [/^(pages?|screens?|views?|app|routes?|features?|presentation)$/i, 'presentation'],
  [/^(hooks?|providers?|stores?|state|bloc|blocs|cubits?|redux|context)$/i, 'state'],
  [/^(services?|api|data|repositor(?:y|ies)|datasources?|clients?)$/i, 'data'],
  [/^(models?|entities|domain|types|dtos?)$/i, 'domain'],
  [/^(utils?|lib|helpers?|common|shared|core)$/i, 'shared'],
  [/^(config|constants?|theme|themes|styles?|l10n|i18n|assets)$/i, 'config'],
  [/^(modules?|controllers?|guards?|middleware|interceptors?|pipes?)$/i, 'backend'],
];
const roleOf = (dir: string) => ROLE.find(([re]) => re.test(dir))?.[1] ?? 'other';

export function assemble(
  files: AssembleFile[],
  projects: AssembleProject[],
  routes: AssembleRoute[],
): AssembleResult {
  const truncated = new Set<string>();
  const sorted = [...files].sort((a, b) => cmp(a.path, b.path));
  const fileSet = new Set(sorted.map((f) => f.path));
  const byPath = new Map(sorted.map((f) => [f.path, f] as const));
  const proj = new Map(projects.map((p) => [p.root, p] as const));

  const resolveImport = (from: AssembleFile, imp: ImportFact): string | null => {
    const p = proj.get(from.project);
    if (!p) return null;
    return from.facts.lang === 'dart'
      ? resolveDart(from.path, imp.spec, fileSet, { name: p.dartPackage, root: p.root })
      : resolveTs(from.path, imp.spec, fileSet, p.aliases);
  };
  // resolved internal edges per file
  const edges = new Map<string, { to: string; line: number }[]>();
  let unresolved = 0;
  let internalImports = 0;
  for (const f of sorted) {
    const out: { to: string; line: number }[] = [];
    for (const imp of f.facts.imports) {
      if (imp.kind === 'package' && !imp.spec.startsWith('.')) {
        // an alias import ("@/x") is classified `alias` by the analyzer; a bare package is external
        const maybe = proj.get(f.project)?.aliases.length ? resolveImport(f, imp) : null;
        if (!maybe) continue;
        out.push({ to: maybe, line: imp.line });
        internalImports++;
        continue;
      }
      const to = resolveImport(f, imp);
      if (to) {
        out.push({ to, line: imp.line });
        internalImports++;
      } else if (
        !imp.style &&
        !imp.asset &&
        (imp.kind === 'relative' || imp.kind === 'dart-relative' || imp.kind === 'alias')
      )
        unresolved++;
    }
    for (const r of f.facts.reexports) {
      const to = resolveImport(f, {
        spec: r.spec,
        kind: f.facts.lang === 'dart' ? 'dart-relative' : 'relative',
        names: [],
        line: r.line,
        style: false,
        asset: false,
      });
      if (to && !out.some((e) => e.to === to)) out.push({ to, line: r.line });
    }
    edges.set(f.path, out);
  }

  // ---- components ---------------------------------------------------------------------------------------------------------------
  const rows: ComponentRow[] = [];
  const seenRow = new Set<string>();
  const compsOf = new Map<string, ComponentFact[]>();
  for (const f of sorted) {
    compsOf.set(f.path, f.facts.components);
    const deps = [
      ...new Set(
        f.facts.imports
          .filter(
            (i) => (i.kind === 'package' || i.kind === 'dart-package') && !resolveImport(f, i),
          ) // an alias or own-package import is internal, not a dependency
          .map((i) =>
            i.kind === 'dart-package'
              ? i.spec.replace(/^package:([^/]+)\/.*$/, '$1')
              : pkgName(i.spec),
          ),
      ),
    ]
      .sort()
      .slice(0, 40);
    const style = [...new Set(f.facts.imports.filter((i) => i.style).map((i) => i.spec))]
      .sort()
      .slice(0, 20);
    const assets = [...new Set(f.facts.imports.filter((i) => i.asset).map((i) => i.spec))]
      .sort()
      .slice(0, 20);
    const platforms = f.facts.lang === 'dart' ? (proj.get(f.project)?.platforms ?? []) : ['web'];
    for (const c of f.facts.components) {
      const k = `${f.path}|${c.name}|${c.kind}`;
      if (seenRow.has(k)) continue;
      seenRow.add(k);
      if (rows.length >= LIMITS.maxComponents) {
        truncated.add('components');
        break;
      }
      // the default export of a Next.js route file is a page or a layout (the folder convention decides; the content cannot)
      const next = c.kind === 'react-component' && c.isDefault ? nextKind(f.path) : null;
      rows.push({
        name: c.name,
        kind: next ?? c.kind,
        framework: next ? 'next' : c.framework,
        path: f.path,
        line: c.line,
        project: f.project,
        exported: c.exported,
        props: c.props,
        hooks: c.hooks,
        dependencies: deps,
        styleDeps: style,
        assets,
        platforms,
      });
    }
  }

  // ---- name resolution ----------------------------------------------------------------------------------------------------------
  const findIn = (
    file: string,
    name: string,
    depth = 0,
    seen = new Set<string>(),
  ): { path: string; c: ComponentFact } | null => {
    if (seen.has(file) || depth > 3) return null;
    seen.add(file);
    const c = compsOf.get(file)?.find((x) => x.name === name);
    if (c) return { path: file, c };
    for (const e of edges.get(file) ?? []) {
      if (!byPath.get(file)?.facts.reexports.some((r) => r.line === e.line)) continue;
      const hit = findIn(e.to, name, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  };
  const defaultIn = (
    file: string,
    depth = 0,
    seen = new Set<string>(),
  ): { path: string; c: ComponentFact } | null => {
    if (seen.has(file) || depth > 3) return null;
    seen.add(file);
    const c = compsOf.get(file)?.find((x) => x.isDefault);
    if (c) return { path: file, c };
    for (const e of edges.get(file) ?? []) {
      const hit = defaultIn(e.to, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  };
  const resolveName = (
    f: AssembleFile,
    name: string,
  ): { path: string; c: ComponentFact } | null => {
    const same = compsOf.get(f.path)?.find((c) => c.name === name);
    if (same) return { path: f.path, c: same };
    if (f.facts.lang === 'dart') {
      for (const e of edges.get(f.path) ?? []) {
        const hit = findIn(e.to, name);
        if (hit) return hit;
      }
      return null;
    }
    for (const imp of f.facts.imports) {
      for (const n of imp.names) {
        let local = n;
        let imported = n;
        let isDefault = false;
        if (n.startsWith('ns:')) continue;
        if (n.startsWith('default:')) {
          isDefault = true;
          local = n.slice(8);
          imported = local;
        } else if (n.includes('=')) {
          const [l, i] = n.split('=') as [string, string];
          local = l;
          imported = i;
        }
        if (local !== name) continue;
        const to = resolveImport(f, imp);
        if (!to) continue;
        const hit = isDefault ? defaultIn(to) : findIn(to, imported);
        if (hit) return hit;
      }
    }
    return null;
  };

  // ---- relationships ------------------------------------------------------------------------------------------------------------
  const rels: RelationshipRow[] = [];
  const seenRel = new Set<string>();
  const add = (r: RelationshipRow) => {
    const k = `${r.fromKind}|${r.fromRef}|${r.toKind}|${r.toRef}|${r.relation}`;
    if (seenRel.has(k)) return;
    if (rels.length >= LIMITS.maxRelationships) {
      truncated.add('relationships');
      return;
    }
    seenRel.add(k);
    rels.push(r);
  };
  const ref = (p: string, n: string) => `${p}#${n}`;
  const used = new Set<string>();
  for (const f of sorted) {
    for (const c of f.facts.components) {
      for (const child of c.children) {
        const t = resolveName(f, child);
        if (t && !(t.path === f.path && t.c.name === c.name)) {
          add({
            fromKind: 'component',
            fromRef: ref(f.path, c.name),
            toKind: 'component',
            toRef: ref(t.path, t.c.name),
            relation: 'renders',
            evidence: { path: f.path, line: c.line },
          });
          used.add(ref(t.path, t.c.name));
        }
      }
      for (const l of c.links) {
        const t = resolveName(f, l.target);
        if (t && !(t.path === f.path && t.c.name === c.name)) {
          add({
            fromKind: 'component',
            fromRef: ref(f.path, c.name),
            toKind: 'component',
            toRef: ref(t.path, t.c.name),
            relation: l.relation,
            evidence: { path: f.path, line: c.line },
          });
          used.add(ref(t.path, t.c.name));
        }
      }
    }
    for (const r of f.facts.routeRefs) {
      const t = resolveName(f, r.target);
      if (t) {
        add({
          fromKind: 'route',
          fromRef: r.path,
          toKind: 'component',
          toRef: ref(t.path, t.c.name),
          relation: 'routes_to',
          evidence: { path: f.path, line: r.line },
        });
        used.add(ref(t.path, t.c.name));
      }
    }
  }
  for (const r of routes) {
    if (r.kind !== 'next-app-page' && r.kind !== 'next-pages-page') continue;
    const d = defaultIn(r.file);
    if (d) {
      add({
        fromKind: 'route',
        fromRef: r.path,
        toKind: 'component',
        toRef: ref(d.path, d.c.name),
        relation: 'route_renders',
        evidence: { path: r.file },
      });
      used.add(ref(d.path, d.c.name));
    }
  }
  for (const f of sorted)
    for (const e of edges.get(f.path) ?? [])
      add({
        fromKind: 'file',
        fromRef: f.path,
        toKind: 'file',
        toRef: e.to,
        relation: 'imports',
        evidence: { path: f.path, line: e.line },
      });

  return {
    components: rows,
    relationships: rels,
    architecture: architecture(
      sorted,
      projects,
      routes,
      edges,
      rows,
      used,
      unresolved,
      internalImports,
      truncated,
    ),
  };
}

function architecture(
  files: AssembleFile[],
  projects: AssembleProject[],
  routes: AssembleRoute[],
  edges: Map<string, { to: string; line: number }[]>,
  rows: ComponentRow[],
  used: Set<string>,
  unresolved: number,
  internalImports: number,
  truncated: Set<string>,
): ArchitectureSummary {
  const skipped: Record<string, number> = {};
  for (const f of files)
    if (f.facts.skipped) skipped[f.facts.skipped] = (skipped[f.facts.skipped] ?? 0) + 1;
  const rootOf = (p: string) => files.find((f) => f.path === p)?.project ?? '.';
  const rel = (root: string, p: string) => (root === '.' ? p : p.slice(root.length + 1));

  // layers: first-level folders under the source root of each project
  const layerCount = new Map<string, { project: string; name: string; files: number }>();
  for (const f of files) {
    const r = rel(f.project, f.path).split('/');
    const src = ['src', 'lib', 'app'].includes(r[0]!) && r.length > 2 ? 1 : 0;
    const dir = r.length - 1 > src ? r[src]! : null;
    if (!dir) continue;
    const k = `${f.project}|${dir}`;
    const cur =
      layerCount.get(k) ?? layerCount.set(k, { project: f.project, name: dir, files: 0 }).get(k)!;
    cur.files++;
  }
  const layers = [...layerCount.values()]
    .map((l) => ({ ...l, role: roleOf(l.name) }))
    .sort((a, b) => cmp(a.project + a.name, b.project + b.name));

  // modules: the first two folders (or one) of each file, with weighted dependencies
  const moduleOf = (p: string): string => {
    const r = rel(rootOf(p), p).split('/');
    r.pop();
    return r.length === 0
      ? '.'
      : r.slice(0, ['src', 'lib', 'app'].includes(r[0]!) && r.length > 1 ? 2 : 1).join('/');
  };
  const mods = new Map<string, { project: string; files: number; deps: Map<string, number> }>();
  for (const f of files) {
    const k = `${f.project}|${moduleOf(f.path)}`;
    (mods.get(k) ?? mods.set(k, { project: f.project, files: 0, deps: new Map() }).get(k)!).files++;
  }
  for (const f of files)
    for (const e of edges.get(f.path) ?? []) {
      const a = `${f.project}|${moduleOf(f.path)}`;
      const b = `${rootOf(e.to)}|${moduleOf(e.to)}`;
      if (a !== b) mods.get(a)!.deps.set(b, (mods.get(a)!.deps.get(b) ?? 0) + 1);
    }
  const modules = [...mods.entries()]
    .map(([k, v]) => ({
      name: k.split('|')[1]!,
      project: v.project,
      files: v.files,
      dependsOn: [...v.deps.entries()]
        .map(([t, w]) => ({ module: t.split('|')[1]!, weight: w }))
        .sort((x, y) => y.weight - x.weight || cmp(x.module, y.module))
        .slice(0, 10),
    }))
    .sort((a, b) => cmp(a.project + a.name, b.project + b.name))
    .slice(0, 200);

  // cycles: strongly connected components of the file graph (iterative Tarjan)
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: { files: string[]; size: number }[] = [];
  let counter = 0;
  for (const start of files.map((f) => f.path)) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const out = edges.get(top.v) ?? [];
      if (top.i < out.length) {
        const w = out[top.i++]!.to;
        if (!idx.has(w)) {
          idx.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
      } else {
        work.pop();
        if (work.length)
          low.set(
            work[work.length - 1]!.v,
            Math.min(low.get(work[work.length - 1]!.v)!, low.get(top.v)!),
          );
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          if (comp.length > 1)
            cycles.push({ files: comp.sort(cmp).slice(0, 8), size: comp.length });
        }
      }
    }
  }
  cycles.sort((a, b) => b.size - a.size || cmp(a.files[0]!, b.files[0]!));
  if (cycles.length > 20) truncated.add('cycles');

  // reachability from entry points, route files and framework special files
  const roots = new Set<string>();
  for (const p of projects) for (const e of p.entryPoints) if (edges.has(e)) roots.add(e);
  for (const r of routes) if (edges.has(r.file)) roots.add(r.file);
  for (const f of files) if (SPECIAL_ENTRY.test(f.path)) roots.add(f.path);
  for (const p of projects)
    if (p.kind === 'library')
      for (const f of files)
        if (f.project === p.root && /(?:^|\/)(?:src\/)?index\.(?:ts|tsx|js|jsx)$/.test(f.path))
          roots.add(f.path);
  let entryReachability: ArchitectureSummary['entryReachability'] = null;
  if (roots.size > 0) {
    const seen = new Set<string>(roots);
    const q = [...roots];
    while (q.length)
      for (const e of edges.get(q.pop()!) ?? [])
        if (!seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
    const un = files
      .filter(
        (f) =>
          !seen.has(f.path) &&
          !f.facts.skipped &&
          f.facts.components.length + f.facts.exports.length > 0,
      )
      .map((f) => f.path)
      .sort(cmp);
    entryReachability = {
      roots: roots.size,
      analysedFiles: files.length,
      unreachable: un.length,
      sample: un.slice(0, 10),
    };
  }
  const publicSurface = projects
    .filter((p) => p.kind === 'library')
    .flatMap((p) =>
      files
        .filter(
          (f) => f.project === p.root && /(?:^|\/)(?:src\/)?index\.(?:ts|tsx|js|jsx)$/.test(f.path),
        )
        .map((f) => ({
          project: p.root,
          file: f.path,
          exports: [
            ...new Set([
              ...f.facts.exports,
              ...f.facts.components.filter((c) => c.exported).map((c) => c.name),
            ]),
          ]
            .sort()
            .slice(0, 50),
        })),
    )
    .filter((s) => s.exports.length > 0)
    .sort((a, b) => cmp(a.file, b.file));
  const orphans = rows
    .filter((c) => c.exported && !NON_ORPHAN.has(c.kind) && !used.has(`${c.path}#${c.name}`))
    .map((c) => ({ name: c.name, path: c.path }))
    .sort((a, b) => cmp(a.path + a.name, b.path + b.name))
    .slice(0, 30);
  return {
    layers: layers.slice(0, 100),
    modules,
    cycles: cycles.slice(0, 20),
    entryReachability,
    publicSurface: publicSurface.slice(0, 20),
    orphanComponents: orphans,
    stats: {
      files: files.length,
      skipped,
      internalImports,
      unresolvedImports: unresolved,
      truncated: [...truncated].sort(cmp),
    },
  };
}

/** Manifest schema 2 = the S-K2b manifest plus components and architecture (manifests are append-only, so this is a second row). */
export function buildManifestV2(
  v1: Record<string, unknown>,
  result: AssembleResult,
): Record<string, unknown> {
  const names = [...new Set(result.components.map((c) => c.name))].sort(cmp).slice(0, 500);
  return {
    ...v1,
    schemaVersion: '2',
    components: names,
    componentIndex: result.components.slice(0, 300).map((c) => ({
      name: c.name,
      kind: c.kind,
      framework: c.framework,
      path: c.path,
      line: c.line,
      props: c.props.length,
    })),
    componentStats: {
      total: result.components.length,
      relationships: result.relationships.length,
      analyzerVersion: COMPONENT_ANALYZER_VERSION,
    },
    architecture: result.architecture,
  };
}
