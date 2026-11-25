import { createHash } from 'node:crypto';
import { scanForSecrets } from '@nuzm/domain';

/**
 * P3-S05 static analysis gates for GENERATED full-stack application code (acceptance F2). Pure: it reads a file map and returns findings; nothing is executed.
 * Findings carry the rule, the file and the line, NEVER the matched text (a secret must not be copied into a finding, a log or a repair prompt).
 *
 * Gates (each is independent; a report passes only when no blocker remains):
 *   secrets              no secret-shaped literal, no committed `.env`, no connection string with a password, no literal session secret
 *   forbidden-apis       no dynamic code (`eval`, `new Function`, `vm`), no process spawning, no remote import, no `innerHTML`-style sinks
 *   dependency-policy    allowlisted packages only, exact-or-range registry specs (no git/url/file/link), no lifecycle scripts, lockfile integrity
 *   sql-injection        no query text built by interpolation/concatenation from anything but a quoted identifier or a placeholder list
 *   route-auth           every route a developer adds is authenticated by default and checks a permission; public routes are an explicit allowlist; no second HTTP server
 *   platform-integrity   the platform-authored files (the engine, auth, the probe) are byte-identical to the template, so a generated app cannot weaken them or forge a probe result
 *
 * The platform template is trusted (pinned by hash through `platformFiles`); model-authored files are analysed strictly. A model cannot opt a file out of analysis.
 */
export type GateId =
  | 'secrets'
  | 'forbidden-apis'
  | 'dependency-policy'
  | 'sql-injection'
  | 'route-auth'
  | 'platform-integrity';
export const GATE_IDS: readonly GateId[] = [
  'secrets',
  'forbidden-apis',
  'dependency-policy',
  'sql-injection',
  'route-auth',
  'platform-integrity',
];
export interface GateFinding {
  gate: GateId;
  /** `blocker` fails the report; `warning` is recorded and shown to the repair loop but does not fail it. */
  severity: 'blocker' | 'warning';
  rule: string;
  file: string;
  line: number | null;
  /** A fixed sentence for the rule: never quotes the source. */
  message: string;
}
export interface GateReport {
  ok: boolean;
  stage: GateStage;
  filesScanned: number;
  findings: GateFinding[];
  gates: Record<GateId, { status: 'pass' | 'fail'; blockers: number; warnings: number }>;
  /** sha256 over the scanned file paths and contents: the evidence record binds the report to exactly these bytes. */
  inputDigest: string;
}
/** `generated` = right after generation (a lockfile does not exist yet: it is created in the sandbox through the package mirror); `locked` = before build/deploy (the lockfile must exist and verify). */
export type GateStage = 'generated' | 'locked';

export interface GateOptions {
  stage?: GateStage;
  /** Platform-authored files and the sha256 they must have (from the template). Paths not listed here are model-authored. */
  platformFiles?: ReadonlyMap<string, string> | Record<string, string>;
  /** Runtime and development dependency allowlists. Defaults: `pg`; `typescript`, `@types/node`, `@types/pg`. */
  allowedDependencies?: readonly string[];
  allowedDevDependencies?: readonly string[];
  /** Route paths (after the API base path) a developer-added route may expose WITHOUT authentication. Defaults to none. */
  publicRouteAllowlist?: readonly string[];
  /** Registry hosts a lockfile `resolved` URL may point at. Default: registry.npmjs.org only; set the mirror host when installs go through the sandbox mirror. */
  registryHosts?: readonly string[];
  /** Extra canary strings (platform secrets planted by qualification) that must not appear anywhere. */
  canaries?: readonly string[];
}

export const DEFAULT_ALLOWED_DEPENDENCIES = ['pg'] as const;
export const DEFAULT_ALLOWED_DEV_DEPENDENCIES = ['typescript', '@types/node', '@types/pg'] as const;
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepare',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'dependencies',
]);

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const isSource = (p: string): boolean => /\.(?:ts|tsx|js|mjs|cjs|jsx)$/.test(p);
const isServerSource = (p: string): boolean => isSource(p) && !p.startsWith('public/');
const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};
const MESSAGES: Record<string, string> = {
  secret_pattern: 'A secret-shaped value is present in the file.',
  env_file_committed:
    'A real environment file is part of the project (only `.env.example` is allowed).',
  secret_key_file: 'A credential/key file is part of the project.',
  session_secret_literal:
    'A session/signing secret is written as a literal instead of read from the environment.',
  canary: 'A platform canary string is present.',
  eval: 'Dynamic code evaluation (`eval`) is forbidden.',
  new_function: 'Dynamic code construction (`new Function`) is forbidden.',
  vm_module: 'The `vm` module is forbidden.',
  child_process: 'Spawning processes (`child_process`) is forbidden in application code.',
  worker_threads: 'Worker threads are not part of the application profile.',
  remote_import: 'Importing code from a URL is forbidden.',
  process_binding: 'Reaching into process internals is forbidden.',
  inner_html:
    'An HTML injection sink (`innerHTML`/`outerHTML`/`document.write`/`insertAdjacentHTML`) is used.',
  dependency_not_allowed: 'A dependency outside the allowlist is declared.',
  dependency_spec_not_registry:
    'A dependency points at git, a URL, a file path or a tarball instead of a registry version.',
  dependency_spec_unbounded: 'A dependency uses `*`, `latest` or an empty version.',
  lifecycle_script: 'A package lifecycle script (install/publish hooks) is declared.',
  package_json_invalid: 'package.json is missing or is not valid JSON.',
  package_overrides:
    'package.json `overrides`/`resolutions` can swap transitive packages and are forbidden.',
  lockfile_missing: 'A package-lock.json is required before build or deploy.',
  lockfile_invalid: 'package-lock.json is not valid JSON or has an unsupported version.',
  lockfile_unlisted_package:
    'The lockfile contains a package that is not a (transitive) dependency of an allowed package.',
  lockfile_no_integrity: 'A lockfile entry has no integrity hash.',
  lockfile_registry_host: 'A lockfile entry resolves from a host outside the allowed registries.',
  lockfile_install_script: 'A locked package declares install scripts.',
  sql_interpolation:
    'A SQL text is built by interpolation or concatenation of a value; use placeholders.',
  sql_template_literal:
    'A SQL template literal interpolates an expression that is not a quoted identifier or a placeholder list.',
  route_public: 'A route is registered without authentication and is not in the public allowlist.',
  route_arity: 'A route registration is not statically analysable (spread or dynamic arguments).',
  route_no_authorization:
    'An authenticated route does not check a permission or role (`can`/`need`/`isAdmin`).',
  route_no_user: 'A route handler never reads the authenticated user.',
  raw_http_server: 'A second HTTP server or framework bypasses the authenticated router.',
  platform_file_modified: 'A platform-authored file differs from the template.',
  platform_file_missing: 'A platform-authored file is missing.',
};

export function runStaticGates(
  files: ReadonlyMap<string, string>,
  o: GateOptions = {},
): GateReport {
  const stage = o.stage ?? 'generated';
  const findings: GateFinding[] = [];
  const add = (
    gate: GateId,
    rule: string,
    file: string,
    line: number | null,
    severity: 'blocker' | 'warning' = 'blocker',
  ): void => {
    findings.push({ gate, severity, rule, file, line, message: MESSAGES[rule] ?? rule });
  };
  const platform = new Map<string, string>(
    o.platformFiles instanceof Map
      ? o.platformFiles
      : Object.entries((o.platformFiles as Record<string, string> | undefined) ?? {}),
  );
  const paths = [...files.keys()].sort();

  // ---------- platform-integrity ----------
  for (const [p, want] of platform) {
    const have = files.get(p);
    if (have === undefined) add('platform-integrity', 'platform_file_missing', p, null);
    else if (sha(have) !== want) add('platform-integrity', 'platform_file_modified', p, null);
  }
  const trusted = (p: string): boolean =>
    platform.has(p) && files.has(p) && sha(files.get(p) as string) === platform.get(p);

  for (const p of paths) {
    const text = files.get(p) as string;
    const base = p.split('/').pop() as string;

    // ---------- secrets (all files, including platform ones: a planted canary must never pass) ----------
    if (/^\.env(\..*)?$/i.test(base) && base !== '.env.example')
      add('secrets', 'env_file_committed', p, null);
    if (
      /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(base) ||
      /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)
    )
      add('secrets', 'secret_key_file', p, null);
    if (!trusted(p)) {
      const found = scanForSecrets(text, o.canaries ?? []);
      const documentation = /(?:^|\/)(?:\.env\.example|[^/]+\.md)$/.test(p);
      for (const f of found) {
        // documented placeholders (`.env.example`, markdown) are not secrets, and neither is an assignment from another expression (`token: res.body.token`)
        if (
          documentation &&
          (f.kind === 'connection_string' || f.kind === 'api_key_assignment') &&
          isPlaceholder(text, f.index)
        )
          continue;
        if (f.kind === 'api_key_assignment' && isReference(text, f.index)) continue;
        add('secrets', f.kind === 'canary' ? 'canary' : 'secret_pattern', p, lineOf(text, f.index));
      }
      if (isServerSource(p) || /\.json$/.test(p)) {
        const re =
          /(?:session[_-]?secret|jwt[_-]?secret|signing[_-]?key|cookie[_-]?secret)["']?\s*[:=]\s*(["'`])((?:(?!\1).){8,})\1/gi;
        for (const m of text.matchAll(re)) {
          const val = m[2] as string;
          if (/process\.env|\$\{/.test(val)) continue;
          add('secrets', 'session_secret_literal', p, lineOf(text, m.index ?? 0));
        }
      }
    } else if ((o.canaries ?? []).some((c) => c.length >= 8 && text.includes(c))) {
      add('secrets', 'canary', p, null);
    }

    if (trusted(p) || !isSource(p)) continue;
    const code = stripComments(text);

    // ---------- forbidden-apis ----------
    const hit = (rule: string, re: RegExp, gate: GateId = 'forbidden-apis'): void => {
      for (const m of code.matchAll(re)) add(gate, rule, p, lineOf(code, m.index ?? 0));
    };
    if (isServerSource(p) || p.startsWith('public/')) {
      hit('eval', /(?<![.\w$])eval\s*\(/g);
      hit('new_function', /\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\(\s*["'`]/g);
    }
    if (isServerSource(p)) {
      hit('vm_module', /(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:node:)?vm["']/g);
      hit(
        'child_process',
        /(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:node:)?child_process["']/g,
      );
      hit(
        'worker_threads',
        /(?:from\s+|require\s*\(\s*|import\s*\(\s*)["'](?:node:)?(?:worker_threads|cluster)["']/g,
      );
      hit('remote_import', /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']https?:\/\//g);
      hit('process_binding', /process\s*\.\s*(?:binding|dlopen|_linkedBinding)\s*\(/g);
    }
    hit(
      'inner_html',
      /\.\s*(?:innerHTML|outerHTML)\s*(?:\+?=)(?!=)|document\s*\.\s*write(?:ln)?\s*\(|\.insertAdjacentHTML\s*\(|dangerouslySetInnerHTML/g,
    );

    if (!isServerSource(p)) continue;

    // ---------- sql-injection ----------
    for (const call of findCalls(
      code,
      /(?<![\w$])(?:pool|client|db|tx|conn|connection|sql)\s*\.\s*query\s*\(|(?<![\w$])query\s*\(/g,
    )) {
      const first = firstArgument(call.args);
      if (first === null) continue;
      const line = lineOf(code, call.start);
      const problem = unsafeSql(first);
      if (problem) add('sql-injection', problem, p, line);
    }

    // ---------- route-auth ----------
    for (const call of findCalls(code, /(?<![\w$])(?:router|app|r)\s*\.\s*add\s*\(/g)) {
      const args = splitArguments(call.args);
      const line = lineOf(code, call.start);
      if (args.some((a) => a.trim().startsWith('...'))) {
        add('route-auth', 'route_arity', p, line);
        continue;
      }
      const isPublic = args.length >= 4 && args[3]!.trim() !== 'false';
      const pathArg = (args[1] ?? '').trim();
      if (isPublic) {
        const allowed = (o.publicRouteAllowlist ?? []).some(
          (a) => pathArg.includes(JSON.stringify(a).slice(1, -1)) || pathArg.includes(a),
        );
        if (!allowed) add('route-auth', 'route_public', p, line);
      } else {
        const handler = args[2] ?? '';
        if (!/\breq(?:uest)?\s*\.\s*user\b|\buser\b/.test(handler))
          add('route-auth', 'route_no_user', p, line);
        else if (!/\b(?:can|need|isAdmin|authorize|requireRole|hasPermission)\s*\(/.test(handler))
          add('route-auth', 'route_no_authorization', p, line);
      }
    }
    hit(
      'raw_http_server',
      /\b(?:createServer|createSecureServer)\s*\(|from\s+["'](?:express|fastify|koa|hono|@hapi\/hapi|@nestjs\/[a-z-]+|restify|polka)["']|require\s*\(\s*["'](?:express|fastify|koa|hono)["']\s*\)/g,
      'route-auth',
    );
  }

  // ---------- dependency-policy ----------
  dependencyPolicy(files, o, stage, (rule, file, line, sev) =>
    add('dependency-policy', rule, file, line, sev),
  );

  const gates = {} as GateReport['gates'];
  for (const g of GATE_IDS) {
    const mine = findings.filter((f) => f.gate === g);
    const blockers = mine.filter((f) => f.severity === 'blocker').length;
    gates[g] = {
      status: blockers === 0 ? 'pass' : 'fail',
      blockers,
      warnings: mine.length - blockers,
    };
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule),
  );
  const h = createHash('sha256');
  for (const p of paths)
    h.update(p)
      .update('\0')
      .update(sha(files.get(p) as string))
      .update('\n');
  return {
    ok: findings.every((f) => f.severity !== 'blocker'),
    stage,
    filesScanned: paths.length,
    findings,
    gates,
    inputDigest: h.digest('hex'),
  };
}

/** The text right after the key of an assignment finding: the value as written (quotes kept). */
function assignedValue(text: string, index: number): string {
  const m = /^[^:=\n]*[:=]\s*(\S[^\n]{0,120})/.exec(text.slice(index, index + 200));
  return m?.[1] ?? '';
}
/** `change-me…`, `<password>`, `example`, `synthetic`, `your-…`, `xxx…` placeholders. */
function isPlaceholder(text: string, index: number): boolean {
  const v = assignedValue(text, index);
  return (
    /^["']?(?:change-?me|<[^>]+>|\$\(|\$\{|your[-_]|x{4,}|example|synthetic|placeholder|\.\.\.)/i.test(
      v,
    ) || /:<[a-z_]*password>@/i.test(text.slice(index, index + 120))
  );
}
/** `token: second.body.token`, `secret = process.env.X`: a reference to another value, not a literal. */
function isReference(text: string, index: number): boolean {
  const v = assignedValue(text, index);
  if (/^["'`]/.test(v)) return false;
  const first = /^[^\s,;)}\]]+/.exec(v)?.[0] ?? '';
  return /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(first);
}

/** sha256 of every runtime-template file that must stay byte-identical in a generated app (the engine, auth, stores' contract, the probe). */
export function platformFileHashes(
  template: Readonly<Record<string, string>>,
  prefixes: readonly string[] = PLATFORM_OWNED_PREFIXES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(template))
    if (prefixes.some((x) => p === x || p.startsWith(x))) out[p] = sha(c);
  return out;
}
/** `src/meta.ts` and `public/meta.json` are spec-derived (they differ per app), so they are NOT platform-pinned; everything else of the template is. */
export const PLATFORM_OWNED_PREFIXES: readonly string[] = [
  'src/auth.ts',
  'src/engine.ts',
  'src/http.ts',
  'src/validation.ts',
  'src/csv.ts',
  'src/types.ts',
  'src/config.ts',
  'src/memory-store.ts',
  'src/pg-store.ts',
  'src/migrate.ts',
  'src/app.ts',
  'src/server.ts',
  'probe/',
];

// ---------------------------------------------------------------------------------------------------------------------------------------------
function dependencyPolicy(
  files: ReadonlyMap<string, string>,
  o: GateOptions,
  stage: GateStage,
  add: (rule: string, file: string, line: number | null, sev?: 'blocker' | 'warning') => void,
): void {
  const raw = files.get('package.json');
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    pkg = null;
  }
  if (!pkg || typeof pkg !== 'object') {
    add('package_json_invalid', 'package.json', null);
    return;
  }
  const allowDeps = new Set(o.allowedDependencies ?? DEFAULT_ALLOWED_DEPENDENCIES);
  const allowDev = new Set(o.allowedDevDependencies ?? DEFAULT_ALLOWED_DEV_DEPENDENCIES);
  const check = (section: string, allow: Set<string>): void => {
    const d = pkg![section];
    if (d === undefined) return;
    if (typeof d !== 'object' || d === null)
      return add('package_json_invalid', 'package.json', null);
    for (const [name, spec] of Object.entries(d as Record<string, unknown>)) {
      if (!allow.has(name)) add('dependency_not_allowed', 'package.json', null);
      const s = typeof spec === 'string' ? spec.trim() : '';
      if (
        /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:|portal:|\/|\.{1,2}\/|~\/)|\.tgz$|^[\w.-]+\/[\w.-]+$/.test(
          s,
        ) &&
        !/^[~^<>=\d]/.test(s)
      )
        add('dependency_spec_not_registry', 'package.json', null);
      else if (s === '' || s === '*' || s === 'latest' || s === 'x' || /^npm:/.test(s))
        add(
          s.startsWith('npm:') ? 'dependency_spec_not_registry' : 'dependency_spec_unbounded',
          'package.json',
          null,
        );
    }
  };
  check('dependencies', allowDeps);
  check('devDependencies', allowDev);
  for (const section of [
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
  ])
    if (pkg[section] !== undefined && Object.keys(pkg[section] as object).length > 0)
      add('dependency_not_allowed', 'package.json', null);
  if (pkg['overrides'] !== undefined || pkg['resolutions'] !== undefined)
    add('package_overrides', 'package.json', null);
  const scripts = pkg['scripts'];
  if (typeof scripts === 'object' && scripts !== null)
    for (const name of Object.keys(scripts))
      if (LIFECYCLE_SCRIPTS.has(name)) add('lifecycle_script', 'package.json', null);

  const lock = files.get('package-lock.json');
  if (lock === undefined) {
    add('lockfile_missing', 'package-lock.json', null, stage === 'locked' ? 'blocker' : 'warning');
    return;
  }
  interface Lock {
    lockfileVersion?: unknown;
    packages?: Record<string, Record<string, unknown>>;
  }
  let lj: Lock | null;
  try {
    lj = JSON.parse(lock) as Lock | null;
  } catch {
    lj = null;
  }
  if (
    !lj ||
    typeof lj !== 'object' ||
    (lj.lockfileVersion !== 3 && lj.lockfileVersion !== 2) ||
    !lj.packages ||
    typeof lj.packages !== 'object'
  )
    return add('lockfile_invalid', 'package-lock.json', null);
  // every locked package must be reachable from the root's allowed dependencies (a package smuggled into the lockfile is refused)
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const [key, entry] of Object.entries(lj.packages)) {
    if (key === '' || typeof entry !== 'object' || entry === null) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  const reach = new Set<string>();
  const queue = [
    ...Object.keys((lj.packages[''] ?? {})['dependencies'] ?? {}),
    ...Object.keys((lj.packages[''] ?? {})['devDependencies'] ?? {}),
  ];
  while (queue.length > 0) {
    const n = queue.pop() as string;
    if (reach.has(n)) continue;
    reach.add(n);
    for (const e of byName.get(n) ?? [])
      for (const sec of ['dependencies', 'optionalDependencies', 'peerDependencies'])
        if (typeof e[sec] === 'object' && e[sec] !== null)
          queue.push(...Object.keys(e[sec] as object));
  }
  for (const name of byName.keys())
    if (!reach.has(name)) add('lockfile_unlisted_package', 'package-lock.json', null);
  const hosts = new Set(o.registryHosts ?? ['registry.npmjs.org']);
  for (const [key, entry] of Object.entries(lj.packages)) {
    if (key === '') continue; // the root project
    if (typeof entry !== 'object' || entry === null) continue;
    if (entry['link'] === true) {
      add('dependency_spec_not_registry', 'package-lock.json', null);
      continue;
    }
    const resolved = entry['resolved'];
    if (typeof resolved === 'string') {
      let host: string;
      try {
        const u = new URL(resolved);
        host = u.protocol === 'https:' ? u.hostname : '';
      } catch {
        host = '';
      }
      if (!hosts.has(host)) add('lockfile_registry_host', 'package-lock.json', null);
    } else add('lockfile_registry_host', 'package-lock.json', null);
    const integrity = entry['integrity'];
    if (
      typeof integrity !== 'string' ||
      !/^sha(?:512|384|256)-[A-Za-z0-9+/=]{20,}$/.test(integrity)
    )
      add('lockfile_no_integrity', 'package-lock.json', null);
    if (entry['hasInstallScript'] === true)
      add('lockfile_install_script', 'package-lock.json', null);
  }
}

/** Removes comments and keeps string/template contents and all line breaks, so offsets and line numbers stay valid. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          // keep the interpolation intact (it may contain nested template literals)
          let depth = 0;
          do {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            out += src[i];
            i++;
          } while (i < n && depth > 0);
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Finds `name(` call sites and returns the text of the balanced argument list (strings and template literals are skipped over). */
function findCalls(code: string, opener: RegExp): { start: number; args: string }[] {
  const out: { start: number; args: string }[] = [];
  for (const m of code.matchAll(opener)) {
    const start = m.index ?? 0;
    let i = start + m[0].length;
    const begin = i;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i] as string;
      if (c === '"' || c === "'" || c === '`') {
        i = skipString(code, i);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      i++;
    }
    out.push({ start, args: code.slice(begin, depth === 0 ? i - 1 : i) });
  }
  return out;
}
function skipString(code: string, i: number): number {
  const q = code[i] as string;
  i++;
  while (i < code.length && code[i] !== q) {
    if (code[i] === '\\') {
      i += 2;
      continue;
    }
    if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
      let depth = 0;
      do {
        const c = code[i] as string;
        if (c === '"' || c === "'" || c === '`') {
          i = skipString(code, i);
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      } while (i < code.length && depth > 0);
      continue;
    }
    i++;
  }
  return i + 1;
}
/** Splits an argument list at top-level commas. */
function splitArguments(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < args.length;) {
    const c = args[i] as string;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(args, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  const tail = args.slice(last);
  if (tail.trim() !== '' || out.length > 0) out.push(tail);
  return out;
}
const firstArgument = (args: string): string | null => {
  const a = splitArguments(args)[0];
  return a === undefined ? null : a.trim();
};

/** An interpolated expression that is allowed inside SQL text: a quoted-identifier call, a placeholder list, or a number made by the code itself. */
const SAFE_INTERPOLATION =
  /^(?:q\s*\(.*\)|ident\s*\(.*\)|quoteIdent\s*\(.*\)|placeholders?\b.*|\$\{?\d+\}?|\(?\s*(?:params|vals|values)\.length\s*(?:\+\s*\d+\s*)?\)?|\w+\.map\s*\(\s*\(?\s*\w+\s*,?\s*\w*\s*\)?\s*=>\s*['"`]\$['"`]\s*\+.*|\w*(?:Cols|Columns|Placeholders|Where|Order|Clause|Set)\b)$/;
const SQL_WORD =
  /\b(?:select|insert\s+into|update|delete\s+from|create\s+table|alter\s+table|drop\s+table|with|where|from)\b/i;

function unsafeSql(arg: string): string | null {
  if (arg.startsWith('`')) {
    const end = skipString(arg, 0);
    const body = arg.slice(1, end - 1);
    for (const m of body.matchAll(/\$\{/g)) {
      let i = (m.index ?? 0) + 2;
      const start = i;
      let depth = 1;
      while (i < body.length && depth > 0) {
        const c = body[i] as string;
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      const expr = body.slice(start, i - 1).trim();
      if (!SAFE_INTERPOLATION.test(expr)) return 'sql_template_literal';
    }
    return null;
  }
  // concatenation: split at top-level `+` and require every non-literal operand to be a safe expression
  const parts = splitPlus(arg);
  if (parts.length <= 1) return null; // a bare identifier or literal: the caller built it elsewhere (analysed where built, if in this file)
  if (!parts.some((p) => /^["'`]/.test(p.trim()) && SQL_WORD.test(p))) return null;
  for (const p of parts) {
    const t = p.trim();
    if (/^["'`]/.test(t) && skipString(t, 0) === t.length) continue;
    if (!SAFE_INTERPOLATION.test(t.replace(/^\(|\)$/g, '').trim()) && !SAFE_INTERPOLATION.test(t))
      return 'sql_interpolation';
  }
  return null;
}
function splitPlus(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length;) {
    const c = s[i] as string;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '+' && depth === 0 && s[i - 1] !== '+' && s[i + 1] !== '+') {
      out.push(s.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  out.push(s.slice(last));
  return out;
}

/** One fixed sentence per rule telling the repair step WHAT to change (never quoting the code). The repair loop (P3-S03) puts this, with the file and line, in the model's repair brief. */
export const REMEDIATION: Record<string, string> = {
  secret_pattern:
    'Remove the literal; read the value from the environment (process.env) and document the variable name in .env.example.',
  env_file_committed: 'Delete the environment file; keep only .env.example with placeholders.',
  secret_key_file: 'Delete the key/credential file; secrets come from the vault by reference.',
  session_secret_literal: 'Read the signing secret from SESSION_SECRET; never write it in code.',
  canary: 'Remove the string; it is a platform canary and must never appear in generated files.',
  eval: 'Replace eval with explicit parsing or a lookup table.',
  new_function: 'Replace new Function with a normal function or a lookup table.',
  vm_module: 'Remove the vm module; do not evaluate dynamic code.',
  child_process: 'Remove process spawning; the application does not run commands.',
  worker_threads: 'Remove worker threads/cluster; the app runs as one process.',
  remote_import: 'Import only local files or declared dependencies; never a URL.',
  process_binding: 'Remove access to process internals.',
  inner_html: 'Use textContent or createElement; never assign HTML strings.',
  dependency_not_allowed:
    'Remove the dependency or ask for it to be added to the project allowlist.',
  dependency_spec_not_registry:
    'Use a registry version range (for example ^1.2.3), not git, URL, file or link specifiers.',
  dependency_spec_unbounded: 'Pin a version range instead of *, latest or an empty version.',
  lifecycle_script: 'Remove the install/publish lifecycle script from package.json.',
  package_overrides: 'Remove overrides/resolutions from package.json.',
  package_json_invalid: 'Restore a valid package.json.',
  lockfile_missing:
    'Create package-lock.json with `npm install --package-lock-only --ignore-scripts` through the package mirror.',
  lockfile_invalid: 'Regenerate package-lock.json (lockfileVersion 3).',
  lockfile_registry_host: 'Regenerate the lockfile through the allowed registry mirror.',
  lockfile_no_integrity: 'Regenerate the lockfile so every entry has an integrity hash.',
  lockfile_unlisted_package:
    'Regenerate the lockfile from package.json; it must contain only packages reachable from the declared dependencies.',
  lockfile_install_script: 'Remove the dependency whose install script runs code, or replace it.',
  sql_interpolation:
    'Use placeholders ($1, $2) and pass the values as parameters; quote identifiers only with the q() helper.',
  sql_template_literal:
    'Use placeholders ($1, $2) and pass the values as parameters; quote identifiers only with the q() helper.',
  route_public:
    'Register the route without the public flag so the router authenticates it, or ask for it to be added to the public allowlist.',
  route_arity: 'Register routes with literal arguments: (method, path, handler).',
  route_no_authorization:
    'Check the permission in the handler with need(user, entity, action) or can(...).',
  route_no_user: 'Read req.user in the handler and check what the role may do.',
  raw_http_server: 'Remove the second HTTP server/framework; add routes to the existing router.',
  platform_file_modified:
    'Restore the platform file from the template; platform files must not be edited. Put custom behaviour in a new file.',
  platform_file_missing: 'Restore the platform file from the template.',
};
export interface RepairItem {
  gate: GateId;
  rule: string;
  file: string;
  line: number | null;
  message: string;
  fix: string;
}
/** The blockers of a report as repair items (stable order, deduplicated). */
export function repairBrief(report: GateReport): RepairItem[] {
  const seen = new Set<string>();
  const out: RepairItem[] = [];
  for (const f of report.findings) {
    if (f.severity !== 'blocker') continue;
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      gate: f.gate,
      rule: f.rule,
      file: f.file,
      line: f.line,
      message: f.message,
      fix: REMEDIATION[f.rule] ?? 'Fix the reported rule.',
    });
  }
  return out;
}
