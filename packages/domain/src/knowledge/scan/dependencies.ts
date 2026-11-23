import type { DependencyRecord, ScanFinding } from './types';

const LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
];
const NETWORK_FETCH =
  /(?:curl|wget|Invoke-WebRequest|iwr|fetch\()\s|(?:^|\s)(?:bash|sh|zsh|pwsh|powershell)\s+-c\b|\|\s*(?:sh|bash)\b|(?:^|\s)(?:node|python3?|ruby|perl)\s+-e\b/;
export interface DependencyScan {
  deps: DependencyRecord[];
  findings: ScanFinding[];
}
export interface DependencyOptions {
  /** `ecosystem:name` entries a reviewer must look at (the worker passes the platform deny-list). */
  denied?: (ecosystem: string, name: string) => boolean;
}
const kindOf = (k: string): DependencyRecord['kind'] =>
  k.startsWith('dev')
    ? 'dev'
    : k.startsWith('peer')
      ? 'peer'
      : k.startsWith('optional')
        ? 'optional'
        : 'runtime';
function riskySpecifier(range: string): string | null {
  if (/^(?:git\+|git:|git@|github:|gitlab:|bitbucket:|ssh:)/i.test(range)) return 'git';
  if (/^https?:\/\//i.test(range)) return 'url';
  if (/^(?:file:|link:|portal:|\.\.?\/|\/)/.test(range)) return 'path';
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(range)) return 'git';
  return null;
}

export function scanManifest(
  path: string,
  text: string,
  opts: DependencyOptions = {},
): DependencyScan {
  const base = path.split('/').pop() ?? path;
  const out: DependencyScan = { deps: [], findings: [] };
  const add = (
    ecosystem: DependencyRecord['ecosystem'],
    name: string,
    range: string | null,
    kind: DependencyRecord['kind'],
    license: string | null = null,
  ) => {
    if (!name || name.length > 214) return;
    let risk: DependencyRecord['risk'] = 'none';
    const rs = range ? riskySpecifier(range) : null;
    if (rs) {
      risk = 'high';
      out.findings.push({
        scanner: 'dependencies',
        code: `dependency_${rs}_source`,
        severity: 'warn',
        path,
        line: null,
        detail: `${name} is installed from a ${rs} source instead of a registry release`,
      });
    }
    if (opts.denied?.(ecosystem, name)) {
      risk = 'high';
      out.findings.push({
        scanner: 'dependencies',
        code: 'dependency_denied',
        severity: 'block',
        path,
        line: null,
        detail: `${ecosystem}:${name} is on the platform deny-list`,
      });
    }
    out.deps.push({
      ecosystem,
      name,
      range: range && range.length <= 200 ? range : null,
      kind,
      path,
      license,
      risk,
    });
  };
  try {
    if (base === 'package.json') {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const o = j[key];
        if (o && typeof o === 'object')
          for (const [n, r] of Object.entries(o as Record<string, unknown>))
            add('npm', n, typeof r === 'string' ? r : null, kindOf(key));
      }
      const scripts =
        j.scripts && typeof j.scripts === 'object' ? (j.scripts as Record<string, unknown>) : {};
      for (const k of LIFECYCLE) {
        const v = scripts[k];
        if (typeof v !== 'string') continue;
        const net = NETWORK_FETCH.test(v);
        out.findings.push({
          scanner: 'dependencies',
          code: net ? 'lifecycle_script_network' : 'lifecycle_script',
          severity: net ? 'block' : 'warn',
          path,
          line: null,
          detail: `"${k}" runs automatically at install time${net ? ' and downloads or evaluates remote code' : ''}; it was NOT run`,
        });
      }
      if (typeof j.gypfile === 'boolean' && j.gypfile)
        out.findings.push({
          scanner: 'dependencies',
          code: 'native_build',
          severity: 'info',
          path,
          line: null,
          detail: 'the package builds native code at install time; it was NOT built',
        });
    } else if (base === 'composer.json') {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['require', 'require-dev']) {
        const o = j[key];
        if (o && typeof o === 'object')
          for (const [n, r] of Object.entries(o as Record<string, unknown>))
            if (n !== 'php' && !n.startsWith('ext-'))
              add(
                'composer',
                n,
                typeof r === 'string' ? r : null,
                key === 'require' ? 'runtime' : 'dev',
              );
      }
      const sc =
        j.scripts && typeof j.scripts === 'object'
          ? Object.keys(j.scripts as object).filter((k) =>
              /^(?:pre|post)-(?:install|update|autoload-dump)-cmd$/.test(k),
            )
          : [];
      for (const k of sc)
        out.findings.push({
          scanner: 'dependencies',
          code: 'lifecycle_script',
          severity: 'warn',
          path,
          line: null,
          detail: `Composer "${k}" runs automatically; it was NOT run`,
        });
    } else if (base === 'pubspec.yaml') {
      let section: string | null = null;
      for (const line of text.split('\n')) {
        const h = /^(dependencies|dev_dependencies|dependency_overrides):\s*$/.exec(line);
        if (h) {
          section = h[1]!;
          continue;
        }
        if (/^\S/.test(line)) section = null;
        const m = section && /^ {2}([a-z0-9_]+):\s*(.*)$/.exec(line);
        if (m && section !== 'dependency_overrides') {
          const range = (m[2] ?? '').trim();
          add(
            'pub',
            m[1]!,
            range === ''
              ? null
              : range.startsWith('{') || /^(?:sdk|git|path):/.test(range)
                ? /^git|^\{.*git/.test(range)
                  ? 'git:'
                  : range.includes('path')
                    ? 'path:'
                    : 'sdk'
                : range,
            section === 'dev_dependencies' ? 'dev' : 'runtime',
          );
        }
      }
    } else if (base === 'requirements.txt' || /^requirements[-.\w]*\.txt$/.test(base)) {
      for (const raw of text.split('\n')) {
        const line = raw.split('#')[0]!.trim();
        if (!line || line.startsWith('-')) {
          if (/^-(?:e|-editable|r|-requirement)\b/.test(line)) continue;
          if (/^--(?:index-url|extra-index-url|find-links)\b/.test(line))
            out.findings.push({
              scanner: 'dependencies',
              code: 'dependency_custom_index',
              severity: 'warn',
              path,
              line: null,
              detail: 'a custom package index is configured',
            });
          continue;
        }
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
        if (m) add('pip', m[1]!.toLowerCase(), m[3] ? m[3].trim() : null, 'runtime');
      }
    } else if (base === 'go.mod') {
      for (const m of text.matchAll(
        /^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+(v[\w.+-]+)/gm,
      ))
        add('go', m[1]!, m[2]!, 'runtime');
    } else if (base === 'Gemfile') {
      for (const m of text.matchAll(/^\s*gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?/gm))
        add('gem', m[1]!, m[2] ?? null, 'runtime');
    }
  } catch {
    out.findings.push({
      scanner: 'dependencies',
      code: 'manifest_unparseable',
      severity: 'info',
      path,
      line: null,
      detail: `${base} could not be parsed; its dependencies were not recorded`,
    });
  }
  return out;
}
export const isManifestPath = (path: string): boolean =>
  /(?:^|\/)(?:package\.json|composer\.json|pubspec\.yaml|requirements[-.\w]*\.txt|go\.mod|Gemfile)$/.test(
    path,
  );
