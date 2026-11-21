import type { DependencyFact } from './types';
import { entries, lines, lineOf, obj, parseJson, safeText, str } from './util';

/** Parsers of the manifest formats. Text in, plain data out; never evaluates anything. */
export interface NodeManifest {
  name: string | null;
  version: string | null;
  private: boolean;
  main: string | null;
  bin: boolean;
  hasExports: boolean;
  types: string | null;
  type: string | null;
  engines: Record<string, string>;
  packageManager: string | null;
  workspaces: string[];
  scripts: { name: string; command: string }[];
  deps: DependencyFact[];
}
const SCRIPT_ALLOW = new Set([
  'dev',
  'start',
  'build',
  'test',
  'lint',
  'typecheck',
  'format',
  'e2e',
  'generate',
  'migrate',
  'serve',
  'preview',
  'prepare',
  'postinstall',
  'preinstall',
  'start:dev',
  'start:prod',
  'build:prod',
  'test:e2e',
  'test:unit',
  'db:migrate',
  'storybook',
]);

export function parsePackageJson(text: string | null): NodeManifest | null {
  const j = parseJson(text);
  if (!j || !text) return null;
  const deps: DependencyFact[] = [];
  for (const [field, kind] of [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ] as const)
    for (const [name, range] of entries(j[field])) {
      if (name.length > 214) continue;
      deps.push({
        name,
        range: typeof range === 'string' ? safeText(range, 120) : null,
        resolved: null,
        kind,
        ecosystem: 'npm',
        line: lineOf(text, `"${name}"`),
      });
    }
  const ws = Array.isArray(j.workspaces)
    ? j.workspaces
    : Array.isArray(obj(j.workspaces).packages)
      ? (obj(j.workspaces).packages as unknown[])
      : [];
  const engines: Record<string, string> = {};
  for (const [k, v] of entries(j.engines))
    if (typeof v === 'string') engines[safeText(k, 40)] = safeText(v, 60);
  return {
    name: str(j.name, 214),
    version: str(j.version, 60),
    private: j.private === true,
    main: str(j.main, 200) ?? str(j.module, 200),
    bin: typeof j.bin === 'string' || Object.keys(obj(j.bin)).length > 0,
    hasExports: j.exports !== undefined,
    types: str(j.types, 200) ?? str(j.typings, 200),
    type: str(j.type, 20),
    engines,
    packageManager: str(j.packageManager, 80),
    workspaces: ws
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 50)
      .map((x) => safeText(x, 120)),
    scripts: entries(j.scripts)
      .filter(([k, v]) => typeof v === 'string' && (SCRIPT_ALLOW.has(k) || k.length <= 24))
      .slice(0, 60)
      .map(([k, v]) => ({ name: safeText(k, 40), command: safeText(v, 200) })),
    deps: deps.slice(0, 5000),
  };
}

export interface PubManifest {
  name: string | null;
  version: string | null;
  deps: DependencyFact[];
  isFlutterSdk: boolean;
  sdkConstraint: string | null;
  flutterConstraint: string | null;
  usesMaterialDesign: boolean | null;
  assets: number;
  fonts: number;
  hasFlutterSection: boolean;
}
/** `pubspec.yaml` by indentation: top-level sections and one level of entries. Enough for dependencies, environment and the flutter section. */
export function parsePubspec(text: string | null): PubManifest | null {
  if (!text) return null;
  const out: PubManifest = {
    name: null,
    version: null,
    deps: [],
    isFlutterSdk: false,
    sdkConstraint: null,
    flutterConstraint: null,
    usesMaterialDesign: null,
    assets: 0,
    fonts: 0,
    hasFlutterSection: false,
  };
  let section = '';
  let cur: { name: string; range: string | null; kind: 'runtime' | 'dev'; line: number } | null =
    null;
  const flush = () => {
    if (cur)
      out.deps.push({
        name: cur.name,
        range: cur.range,
        resolved: null,
        kind: cur.kind,
        ecosystem: 'pub',
        line: cur.line,
      });
    cur = null;
  };
  let sub = '';
  for (const [n, raw] of lines(text, 20_000)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.replace(/\s+#.*$/, '').trim();
    if (indent === 0) {
      flush();
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(t);
      if (!m) continue;
      section = m[1]!;
      sub = '';
      const v = m[2]!.replace(/^["']|["']$/g, '');
      if (section === 'name') out.name = safeText(v, 100) || null;
      if (section === 'version') out.version = safeText(v, 60) || null;
      if (section === 'flutter') out.hasFlutterSection = true;
      continue;
    }
    if (section === 'dependencies' || section === 'dev_dependencies') {
      if (indent <= 2) {
        flush();
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(t);
        if (m) {
          const v = m[2]!.replace(/^["']|["']$/g, '');
          cur = {
            name: m[1]!,
            range: v ? safeText(v, 80) : null,
            kind: section === 'dependencies' ? 'runtime' : 'dev',
            line: n,
          };
        }
      } else if (cur) {
        if (/^sdk:\s*flutter/.test(t) && cur.name === 'flutter') out.isFlutterSdk = true;
        if (/^sdk:/.test(t)) cur.range = `sdk:${safeText(t.slice(4), 20)}`;
        else if (/^git:/.test(t)) cur.range = 'git';
        else if (/^path:/.test(t)) cur.range = 'path';
        else if (/^version:/.test(t))
          cur.range = safeText(t.slice(8).replace(/^["']|["']$/g, ''), 80);
      }
    } else if (section === 'environment' && indent <= 2) {
      const m = /^(sdk|flutter):\s*(.*)$/.exec(t);
      if (m) {
        const v = safeText(m[2]!.replace(/^["']|["']$/g, ''), 60);
        if (m[1] === 'sdk') out.sdkConstraint = v;
        else out.flutterConstraint = v;
      }
    } else if (section === 'flutter') {
      if (indent <= 2) {
        sub = t.replace(/:.*$/, '');
        const m = /^uses-material-design:\s*(true|false)/.exec(t);
        if (m) out.usesMaterialDesign = m[1] === 'true';
      } else if (t.startsWith('- ')) {
        if (sub === 'assets') out.assets++;
        if (sub === 'fonts') out.fonts++;
      }
    }
  }
  flush();
  out.deps = out.deps.slice(0, 3000);
  if (out.deps.some((d) => d.name === 'flutter' && d.range === 'sdk:flutter'))
    out.isFlutterSdk = true;
  return out;
}

export function parseRequirements(text: string | null): DependencyFact[] {
  const out: DependencyFact[] = [];
  if (!text) return out;
  for (const [n, raw] of lines(text, 5000)) {
    const l = raw.split('#')[0]!.trim();
    if (!l || l.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(l);
    if (m)
      out.push({
        name: m[1]!.toLowerCase(),
        range: m[2] ? safeText(m[2], 80) : null,
        resolved: null,
        kind: 'runtime',
        ecosystem: 'pip',
        line: n,
      });
  }
  return out.slice(0, 3000);
}
export function parsePyproject(text: string | null): { deps: DependencyFact[]; poetry: boolean } {
  const deps: DependencyFact[] = [];
  if (!text) return { deps, poetry: false };
  let sec = '';
  for (const [n, raw] of lines(text, 5000)) {
    const l = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(l);
    if (h) {
      sec = h[1]!;
      continue;
    }
    if (sec === 'tool.poetry.dependencies' || sec === 'tool.poetry.group.dev.dependencies') {
      const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(l);
      if (m && m[1]!.toLowerCase() !== 'python')
        deps.push({
          name: m[1]!.toLowerCase(),
          range: safeText(m[2]!.replace(/^["']|["']$/g, ''), 80),
          resolved: null,
          kind: sec.includes('dev') ? 'dev' : 'runtime',
          ecosystem: 'pip',
          line: n,
        });
    } else if (sec === 'project' && /^dependencies\s*=/.test(l)) {
      for (const m of l.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*([^"']*)["']/g))
        deps.push({
          name: m[1]!.toLowerCase(),
          range: m[2]!.trim() || null,
          resolved: null,
          kind: 'runtime',
          ecosystem: 'pip',
          line: n,
        });
    }
  }
  return { deps: deps.slice(0, 3000), poetry: /\[tool\.poetry\]/.test(text) };
}
export function parseComposer(
  text: string | null,
): { name: string | null; deps: DependencyFact[] } | null {
  const j = parseJson(text);
  if (!j || !text) return null;
  const deps: DependencyFact[] = [];
  for (const [field, kind] of [
    ['require', 'runtime'],
    ['require-dev', 'dev'],
  ] as const)
    for (const [name, range] of entries(j[field]))
      if (name !== 'php' && !name.startsWith('ext-'))
        deps.push({
          name,
          range: typeof range === 'string' ? safeText(range, 80) : null,
          resolved: null,
          kind,
          ecosystem: 'composer',
          line: lineOf(text, `"${name}"`),
        });
  return { name: str(j.name, 200), deps: deps.slice(0, 3000) };
}
export function parseGoMod(text: string | null): { module: string | null; deps: DependencyFact[] } {
  const deps: DependencyFact[] = [];
  let module: string | null = null;
  if (!text) return { module, deps };
  for (const [n, l] of lines(text, 5000)) {
    const mm = /^module\s+(\S+)/.exec(l);
    if (mm) module = safeText(mm[1], 200);
    const m = /^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+(v[\w.+-]+)/.exec(l);
    if (m)
      deps.push({
        name: m[1]!,
        range: m[2]!,
        resolved: m[2]!,
        kind: 'runtime',
        ecosystem: 'go',
        line: n,
      });
  }
  return { module, deps: deps.slice(0, 3000) };
}
export function parseGemfile(text: string | null): DependencyFact[] {
  const out: DependencyFact[] = [];
  if (!text) return out;
  for (const [n, l] of lines(text, 5000)) {
    const m = /^\s*gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(l);
    if (m)
      out.push({
        name: m[1]!,
        range: m[2] ?? null,
        resolved: null,
        kind: 'runtime',
        ecosystem: 'gem',
        line: n,
      });
  }
  return out.slice(0, 3000);
}
/** `pnpm-workspace.yaml`, `melos.yaml`: the `packages:` list. */
export function parseYamlPackageList(text: string | null, key = 'packages'): string[] {
  const out: string[] = [];
  if (!text) return out;
  let inList = false;
  for (const [, raw] of lines(text, 2000)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (indent === 0) {
      inList = t === `${key}:`;
      continue;
    }
    if (inList && t.startsWith('- '))
      out.push(
        safeText(
          t
            .slice(2)
            .replace(/\s+#.*$/, '')
            .replace(/^["']|["']$/g, ''),
          120,
        ),
      );
  }
  return out.slice(0, 50);
}
