import { LOCK_FILES, lockOfFile, type Lock } from './lock';
import {
  parseComposer,
  parseGemfile,
  parseGoMod,
  parsePackageJson,
  parsePubspec,
  parsePyproject,
  parseRequirements,
  parseYamlPackageList,
  type NodeManifest,
  type PubManifest,
} from './manifests';
import {
  dartDetections,
  dependencyCapabilities,
  nestDetection,
  nextDetection,
  nodeDetection,
  simpleDetections,
  typescriptDetection,
  type Ctx,
} from './rules';
import {
  handlerMethods,
  newFlutterScan,
  newNestScan,
  nextRoutes,
  scanDartFile,
  scanNestFile,
} from './routes';
import {
  ANALYZER_VERSION,
  type Ambiguity,
  type BuildInfo,
  type ManifestCapability,
  type DependencyFact,
  type Detection,
  type DetectInput,
  type DetectOptions,
  type Evidence,
  type ModuleFact,
  type PackageManagerInfo,
  type ProjectInfo,
  type ProjectKind,
  type ProjectManifest,
  type Role,
  type RouteFact,
  type WorkspaceInfo,
} from './types';
import {
  basename,
  dirname,
  ev,
  globToRegExp,
  join,
  levelOf,
  lines,
  obj,
  parseJson,
  parseJsonc,
  rel,
  round,
  safeText,
  sortEvidence,
  str,
} from './util';

const MANIFEST_NAMES = new Set([
  'package.json',
  'pubspec.yaml',
  'composer.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Gemfile',
]);
const EXAMPLE_SEGMENT =
  /^(?:examples?|fixtures?|samples?|demos?|playgrounds?|__tests__|tests?|e2e|docs?|templates?)$/i;
const MAX_DEPTH = 8;
const D = {
  maxReadBytes: 512 * 1024,
  maxTotalReadBytes: 24 * 1024 * 1024,
  maxFilesRead: 4000,
  maxRoutes: 1500,
  maxProjects: 200,
  maxMillis: 60_000,
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Static, deterministic analysis of an ingested package: frameworks with versions and evidence, package managers, projects and workspaces, build configuration,
 * dependencies, routes, screens, modules and capabilities. The same inputs always produce the same manifest (everything is sorted; there are no timestamps).
 * Nothing is executed or imported: configuration files such as next.config.js are read as text.
 */
export async function analyzeProject(
  input: DetectInput,
  opts: DetectOptions = {},
): Promise<ProjectManifest> {
  const o = { ...D, ...opts };
  const now = opts.now ?? Date.now;
  const deadline = now() + o.maxMillis;
  const truncated = new Set<string>();
  const stats = {
    filesConsidered: input.files.length,
    filesRead: 0,
    bytesRead: 0,
    truncated: [] as string[],
    skippedLarge: 0,
  };
  const byPath = new Map(input.files.map((f) => [f.path, f] as const));
  const paths = [...byPath.keys()].sort(cmp);
  const cache = new Map<string, string | null>();
  const timeUp = () => {
    if (now() > deadline) truncated.add('time');
    return now() > deadline;
  };
  const read = async (p: string): Promise<string | null> => {
    if (cache.has(p)) return cache.get(p)!;
    const f = byPath.get(p);
    let text: string | null = null;
    if (f?.stored) {
      if (f.bytes > o.maxReadBytes) stats.skippedLarge++;
      else if (stats.filesRead >= o.maxFilesRead) truncated.add('files_read');
      else if (stats.bytesRead + f.bytes > o.maxTotalReadBytes) truncated.add('bytes_read');
      else if (!timeUp()) {
        stats.filesRead++;
        stats.bytesRead += f.bytes;
        try {
          text = await input.read(p, o.maxReadBytes);
        } catch {
          text = null;
        }
      }
    }
    cache.set(p, text);
    return text;
  };

  // ---- languages ----------------------------------------------------------------------------------------------------------------
  const lang = new Map<string, { files: number; bytes: number }>();
  for (const f of input.files)
    if (f.language)
      lang.set(f.language, {
        files: (lang.get(f.language)?.files ?? 0) + 1,
        bytes: (lang.get(f.language)?.bytes ?? 0) + f.bytes,
      });
  const DATA_LANGS = new Set([
    'json',
    'yaml',
    'toml',
    'markdown',
    'xml',
    'ini',
    'text',
    'gradle',
    'properties',
    'plist',
  ]);
  const languageStats = [...lang.entries()]
    .filter(([name]) => !DATA_LANGS.has(name))
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.bytes - a.bytes || cmp(a.name, b.name));

  // ---- project roots ------------------------------------------------------------------------------------------------------------
  const rootSet = new Set<string>();
  for (const p of paths)
    if (MANIFEST_NAMES.has(basename(p)) && p.split('/').length <= MAX_DEPTH)
      rootSet.add(dirname(p));
  let roots = [...rootSet].sort(cmp);
  if (roots.length > o.maxProjects) {
    roots = roots.slice(0, o.maxProjects);
    truncated.add('projects');
  }
  const rootIn = new Set(roots);
  const ownerOf = (p: string): string | null => {
    for (let d = dirname(p); ; d = dirname(d)) {
      if (rootIn.has(d)) return d;
      if (d === '.') return null;
    }
  };
  const owned = new Map<string, string[]>(roots.map((r) => [r, []]));
  for (const p of paths) owned.get(ownerOf(p) ?? '')?.push(p);

  // ---- lockfiles (read lazily, by nearest directory) ----------------------------------------------------------------------------
  const lockCache = new Map<string, { path: string; lock: Lock } | null>();
  async function lockFor(
    root: string,
    eco: 'node' | 'pub',
  ): Promise<{ dir: string; path: string; lock: Lock } | null> {
    for (let d = root; ; d = dirname(d)) {
      const key = `${d}|${eco}`;
      if (!lockCache.has(key)) {
        let hit: { path: string; lock: Lock } | null = null;
        for (const name of eco === 'pub'
          ? ['pubspec.lock']
          : LOCK_FILES.filter((n) => n !== 'pubspec.lock')) {
          const p = join(d, name);
          if (!byPath.has(p)) continue;
          const lock = lockOfFile(name, await read(p));
          if (lock) {
            hit = { path: p, lock };
            break;
          }
        }
        lockCache.set(key, hit);
      }
      const h = lockCache.get(key);
      if (h) return { dir: d, ...h };
      if (d === '.') return null;
    }
  }

  const projects: ProjectInfo[] = [];
  const routes: RouteFact[] = [];
  const screens: ModuleFact[] = [];
  const moduleFacts: ModuleFact[] = [];
  const ambiguities: Ambiguity[] = [];
  const caps: { cap: ManifestCapability; project: string; example: boolean }[] = [];
  const allDeps: (DependencyFact & { path: string; example: boolean })[] = [];
  const projectNode = new Map<string, NodeManifest>();

  for (const root of roots) {
    if (timeUp()) break;
    const own = owned.get(root)!;
    const relOwn = own.map((p) => ({ p, r: rel(root, p) ?? p }));
    const fileRe = (re: RegExp) => relOwn.find((x) => re.test(x.r))?.p ?? null;
    const dirNames = new Set<string>();
    for (const x of relOwn) {
      const parts = x.r.split('/');
      for (let i = 0; i < parts.length - 1; i++) dirNames.add(parts.slice(0, i + 1).join('/'));
    }
    const dirHit = (name: string) => (dirNames.has(name) ? join(root, name) : null);

    const nodePath = byPath.has(join(root, 'package.json')) ? join(root, 'package.json') : null;
    const pubPath = byPath.has(join(root, 'pubspec.yaml')) ? join(root, 'pubspec.yaml') : null;
    const node: NodeManifest | null = nodePath ? parsePackageJson(await read(nodePath)) : null;
    const pub: PubManifest | null = pubPath ? parsePubspec(await read(pubPath)) : null;
    if (node) projectNode.set(root, node);
    const depsList: (DependencyFact & { path: string })[] = [];
    const ecosystems: string[] = [];
    if (node) {
      ecosystems.push('npm');
      depsList.push(...node.deps.map((d) => ({ ...d, path: nodePath! })));
    }
    if (pub) {
      ecosystems.push('pub');
      depsList.push(...pub.deps.map((d) => ({ ...d, path: pubPath! })));
    }
    const reqPath = byPath.has(join(root, 'requirements.txt'))
      ? join(root, 'requirements.txt')
      : null;
    const pyPath = byPath.has(join(root, 'pyproject.toml')) ? join(root, 'pyproject.toml') : null;
    let poetry = false;
    if (reqPath) {
      ecosystems.push('pip');
      depsList.push(
        ...parseRequirements(await read(reqPath)).map((d) => ({ ...d, path: reqPath })),
      );
    }
    if (pyPath) {
      const py = parsePyproject(await read(pyPath));
      poetry = py.poetry;
      if (!ecosystems.includes('pip')) ecosystems.push('pip');
      depsList.push(...py.deps.map((d) => ({ ...d, path: pyPath })));
    }
    const compPath = byPath.has(join(root, 'composer.json')) ? join(root, 'composer.json') : null;
    if (compPath) {
      const c = parseComposer(await read(compPath));
      if (c) {
        ecosystems.push('composer');
        depsList.push(...c.deps.map((d) => ({ ...d, path: compPath })));
      }
    }
    const goPath = byPath.has(join(root, 'go.mod')) ? join(root, 'go.mod') : null;
    if (goPath) {
      ecosystems.push('go');
      depsList.push(...parseGoMod(await read(goPath)).deps.map((d) => ({ ...d, path: goPath })));
    }
    const gemPath = byPath.has(join(root, 'Gemfile')) ? join(root, 'Gemfile') : null;
    if (gemPath) {
      ecosystems.push('gem');
      depsList.push(...parseGemfile(await read(gemPath)).map((d) => ({ ...d, path: gemPath })));
    }

    // resolved versions from the nearest lockfile
    let nodeLock: Awaited<ReturnType<typeof lockFor>> = null;
    if (node) {
      nodeLock = await lockFor(root, 'node');
      if (nodeLock) {
        const importer = rel(nodeLock.dir, root) ?? '.';
        for (const d of depsList)
          if (d.ecosystem === 'npm')
            d.resolved = nodeLock.lock.resolve(importer === '' ? '.' : importer, d.name, d.range);
      }
    }
    const pubLock = pub ? await lockFor(root, 'pub') : null;
    if (pubLock)
      for (const d of depsList)
        if (d.ecosystem === 'pub') d.resolved = pubLock.lock.resolve('.', d.name, d.range);

    const dedup = new Map<string, DependencyFact & { path: string }>();
    for (const d of depsList) {
      const k = `${d.ecosystem}:${d.name}`;
      const cur = dedup.get(k);
      if (!cur || (cur.kind !== 'runtime' && d.kind === 'runtime')) dedup.set(k, d);
    }
    const ctx: Ctx = {
      root,
      files: own,
      file: fileRe,
      dir: dirHit,
      dep: (eco, name) => dedup.get(`${eco}:${name}`),
      nodePath,
      pubPath,
      scriptsText: node ? node.scripts.map((s) => s.command).join('\n') : '',
    };

    // ---- routes, modules, screens ----------------------------------------------------------------------------------------------
    const detections: Detection[] = [];
    const entryPoints: Evidence[] = [];
    const exampleProject = root.split('/').some((s) => EXAMPLE_SEGMENT.test(s));
    let nextInfo: ReturnType<typeof nextRoutes> | null = null;
    if (ctx.dep('npm', 'next')) {
      nextInfo = nextRoutes(
        root,
        relOwn.map((x) => x.r),
        (r) => join(root, r),
      );
      for (const f of nextInfo.handlerFiles) {
        const t = await read(join(root, f));
        const methods = t ? handlerMethods(t) : [];
        for (const rt of nextInfo.routes) if (rt.file === join(root, f)) rt.methods = methods;
      }
      routes.push(...nextInfo.routes);
      const layout =
        fileRe(/^(?:src\/)?app\/layout\.(?:tsx|ts|jsx|js)$/) ??
        fileRe(/^(?:src\/)?pages\/_app\.(?:tsx|ts|jsx|js)$/);
      if (layout) entryPoints.push(ev('file', layout, 'root layout'));
    }
    const nest = newNestScan();
    let nestMain: string | null = null;
    if (ctx.dep('npm', '@nestjs/core') || ctx.dep('npm', '@nestjs/common')) {
      const cands = relOwn
        .filter(
          (x) =>
            /\.(?:controller|module|gateway|resolver)\.ts$/.test(x.r) || x.r.endsWith('main.ts'),
        )
        .filter((x) => !/\.(?:spec|e2e-spec)\.ts$/.test(x.r))
        .slice(0, 600);
      for (const x of cands) {
        const t = await read(x.p);
        if (t) {
          const before = nest.hasMain;
          scanNestFile(root, x.p, t, nest);
          if (!before && nest.hasMain) nestMain = x.p;
        }
      }
      // routes carry the global prefix when main.ts sets one
      if (nest.globalPrefix)
        for (const r of nest.routes)
          r.path = `/${[nest.globalPrefix, ...r.path.split('/')]
            .flatMap((s) => s.split('/'))
            .filter(Boolean)
            .join('/')}`;
      routes.push(...nest.routes);
      moduleFacts.push(...nest.modules);
      if (nestMain) entryPoints.push(ev('file', nestMain, 'NestFactory.create'));
    }
    const flutter = newFlutterScan();
    let dartFiles = 0;
    if (pub) {
      const dart = relOwn.filter((x) => x.r.endsWith('.dart'));
      dartFiles = dart.filter((x) => x.r.startsWith('lib/')).length;
      if (pub.isFlutterSdk) {
        for (const x of dart.filter((d) => d.r.startsWith('lib/')).slice(0, 800)) {
          const t = await read(x.p);
          if (t) scanDartFile(root, x.p, t, flutter);
        }
        routes.push(...flutter.routes);
        screens.push(...flutter.screens);
        const main = fileRe(/^lib\/main\.dart$/);
        if (main) entryPoints.push(ev('file', main, 'lib/main.dart'));
      }
    }
    const platformDirs = ['android', 'ios', 'web', 'macos', 'linux', 'windows'].filter((d) =>
      dirNames.has(d),
    );

    // ---- detections -------------------------------------------------------------------------------------------------------------
    detections.push(...simpleDetections(ctx));
    const hasApp = !!nextInfo?.hasAppDir;
    const hasPages = !!nextInfo?.hasPagesDir;
    const nextSample = hasApp
      ? (dirHit('app') ?? dirHit('src/app'))
      : hasPages
        ? (dirHit('pages') ?? dirHit('src/pages'))
        : null;
    const nx = nextDetection(ctx, { hasApp, hasPages, sample: nextSample });
    if (nx) detections.push(nx);
    const ns = nestDetection(ctx, { hasMain: nestMain, modules: nest.modules.length });
    if (ns) detections.push(ns);
    const serverFw = detections.find(
      (d) =>
        ['express', 'fastify', 'koa', 'hono', 'nestjs', 'nextjs'].includes(d.id) &&
        d.confidence >= 0.5,
    );
    const nd = node
      ? nodeDetection(ctx, node, serverFw ? (serverFw.evidence[0] ?? null) : null)
      : null;
    if (nd) detections.push(nd);
    const ts = typescriptDetection(ctx);
    if (ts) detections.push(ts);
    if (pub)
      detections.push(
        ...dartDetections(ctx, {
          sdk: pub.sdkConstraint,
          flutterSdk: pub.isFlutterSdk,
          hasFlutterSection: pub.hasFlutterSection,
          platforms: platformDirs,
          usesMain: fileRe(/^lib\/main\.dart$/),
          dartFiles,
        }),
      );
    if (poetry && !detections.some((d) => d.id === 'django')) void 0;
    detections.sort((a, b) => b.confidence - a.confidence || cmp(a.id, b.id));

    // ---- ambiguities local to the project ----------------------------------------------------------------------------------------
    const has = (id: string) => detections.some((d) => d.id === id && d.confidence >= 0.5);
    const amb = (code: string, detail: string, p: string[]) =>
      ambiguities.push({ code, detail, paths: p.slice(0, 6) });
    const where = nodePath ?? pubPath ?? root;
    if (nx && !hasApp && !hasPages)
      amb('next_without_routes', 'next is declared but no app/ or pages/ route files were found', [
        where,
      ]);
    if (ns && !nestMain)
      amb(
        'nest_without_main',
        'NestJS is declared but no main.ts with NestFactory.create was found',
        [where],
      );
    for (const id of ['nextjs', 'react', 'nestjs']) {
      const d = detections.find((x) => x.id === id);
      if (d && d.notes.some((n) => n.includes('development dependency')))
        amb(
          'framework_dev_dependency_only',
          `${d.name} is declared only as a development dependency`,
          [where],
        );
    }
    const uiFw = ['nextjs', 'vue', 'nuxt', 'angular', 'svelte', 'react-native'].filter(has);
    if (uiFw.length > 1)
      amb(
        'conflicting_frameworks',
        `several application frameworks in one project: ${uiFw.join(', ')}`,
        [where],
      );
    if (ecosystems.includes('npm') && ecosystems.includes('pub'))
      amb('mixed_ecosystems', 'both package.json and pubspec.yaml in one directory', [
        nodePath!,
        pubPath!,
      ]);
    if (!pub && platformDirs.length >= 2 && fileRe(/^lib\/main\.dart$/))
      amb(
        'flutter_layout_without_sdk',
        'a Flutter-style layout (lib/main.dart and platform folders) without a pubspec.yaml',
        [join(root, 'lib/main.dart')],
      );
    if (pub && !pub.isFlutterSdk && platformDirs.length >= 2 && fileRe(/^lib\/main\.dart$/))
      amb(
        'flutter_layout_without_sdk',
        'Flutter-style folders exist but pubspec.yaml does not depend on the Flutter SDK; classified as a plain Dart package',
        [pubPath!],
      );
    const locks = new Set<string>();
    for (const n of LOCK_FILES) if (n !== 'pubspec.lock' && byPath.has(join(root, n))) locks.add(n);
    if (locks.size > 1)
      amb(
        'multiple_package_managers',
        `several lockfiles in one directory: ${[...locks].sort().join(', ')}`,
        [...locks].sort().map((n) => join(root, n)),
      );

    // ---- package manager --------------------------------------------------------------------------------------------------------
    let pm: PackageManagerInfo | null = null;
    if (node) {
      const field = node.packageManager
        ? /^(npm|pnpm|yarn|bun)@?([\w.+-]*)/.exec(node.packageManager)
        : null;
      if (field)
        pm = {
          name: field[1] as 'npm' | 'pnpm' | 'yarn' | 'bun',
          version: field[2] || null,
          confidence: 0.95,
          evidence: [ev('manifest', nodePath!, `packageManager ${node.packageManager}`)],
        };
      else if (nodeLock) {
        const n = basename(nodeLock.path);
        pm = {
          name:
            n.startsWith('package-lock') || n.startsWith('npm-')
              ? 'npm'
              : n === 'yarn.lock'
                ? 'yarn'
                : 'pnpm',
          version: null,
          confidence: 0.85,
          evidence: [ev('lockfile', nodeLock.path)],
        };
      } else if (byPath.has(join(root, 'bun.lockb')) || byPath.has(join(root, 'bun.lock')))
        pm = {
          name: 'bun',
          version: null,
          confidence: 0.85,
          evidence: [
            ev(
              'lockfile',
              byPath.has(join(root, 'bun.lock')) ? join(root, 'bun.lock') : join(root, 'bun.lockb'),
            ),
          ],
        };
      else if (byPath.has(join(root, 'pnpm-workspace.yaml')))
        pm = {
          name: 'pnpm',
          version: null,
          confidence: 0.7,
          evidence: [ev('workspace', join(root, 'pnpm-workspace.yaml'))],
        };
    } else if (pub)
      pm = { name: 'pub', version: null, confidence: 0.95, evidence: [ev('manifest', pubPath!)] };
    else if (compPath)
      pm = {
        name: 'composer',
        version: null,
        confidence: 0.9,
        evidence: [ev('manifest', compPath)],
      };
    else if (poetry || byPath.has(join(root, 'poetry.lock')))
      pm = {
        name: 'poetry',
        version: null,
        confidence: 0.85,
        evidence: [ev('manifest', pyPath ?? join(root, 'poetry.lock'))],
      };
    else if (byPath.has(join(root, 'Pipfile')))
      pm = {
        name: 'pipenv',
        version: null,
        confidence: 0.85,
        evidence: [ev('manifest', join(root, 'Pipfile'))],
      };
    else if (reqPath || pyPath)
      pm = {
        name: 'pip',
        version: null,
        confidence: 0.7,
        evidence: [ev('manifest', reqPath ?? pyPath!)],
      };
    else if (goPath)
      pm = { name: 'go', version: null, confidence: 0.9, evidence: [ev('manifest', goPath)] };
    else if (gemPath)
      pm = {
        name: 'bundler',
        version: null,
        confidence: 0.85,
        evidence: [ev('manifest', gemPath)],
      };

    // ---- roles, kind ------------------------------------------------------------------------------------------------------------
    const roles: { role: Role; evidence: Evidence[] }[] = [];
    const addRole = (role: Role, e: Evidence[]) => {
      if (e.length) roles.push({ role, evidence: sortEvidence(e, 4) });
    };
    const evOf = (id: string) =>
      detections.find((d) => d.id === id && d.confidence >= 0.5)?.evidence.slice(0, 2) ?? [];
    addRole(
      'frontend',
      ['nextjs', 'vue', 'nuxt', 'angular', 'svelte']
        .flatMap(evOf)
        .concat(has('react') && ctx.dep('npm', 'react-dom') ? evOf('react') : []),
    );
    addRole(
      'backend',
      [
        'nestjs',
        'express',
        'fastify',
        'koa',
        'hono',
        'django',
        'flask',
        'fastapi',
        'laravel',
        'dart-frog',
        'shelf',
        'serverpod',
      ]
        .flatMap(evOf)
        .concat(
          nextInfo?.routes.some(
            (r) => r.kind === 'next-route-handler' || r.kind === 'next-pages-api',
          )
            ? [
                ev(
                  'file',
                  nextInfo.routes.find(
                    (r) => r.kind === 'next-route-handler' || r.kind === 'next-pages-api',
                  )!.file,
                  'API route handlers',
                ),
              ]
            : [],
        ),
    );
    addRole('mobile', ['flutter', 'react-native', 'expo'].flatMap(evOf));
    if (node?.bin) addRole('cli', [ev('manifest', nodePath!, 'bin')]);
    const hasAppRole = roles.length > 0;
    if (!hasAppRole && node && (node.main || node.hasExports || node.types))
      addRole('library', [
        ev(
          'manifest',
          nodePath!,
          node.main ? `main ${node.main}` : node.types ? 'types' : 'exports',
        ),
      ]);
    if (!hasAppRole && pub && !pub.isFlutterSdk && dartFiles > 0 && !roles.length)
      addRole('library', [ev('manifest', pubPath!, 'Dart package')]);
    const isWorkspaceRoot =
      !!node?.workspaces.length ||
      byPath.has(join(root, 'pnpm-workspace.yaml')) ||
      byPath.has(join(root, 'melos.yaml')) ||
      byPath.has(join(root, 'lerna.json')) ||
      byPath.has(join(root, 'nx.json')) ||
      byPath.has(join(root, 'turbo.json'));
    const appRole = roles.some((r) => ['frontend', 'backend', 'mobile', 'cli'].includes(r.role));
    const kind: ProjectKind = exampleProject
      ? 'example'
      : isWorkspaceRoot && !appRole
        ? 'tooling-root'
        : appRole
          ? 'application'
          : 'library';
    if (kind === 'tooling-root' && roles.length === 0)
      addRole('tooling', [ev('workspace', nodePath ?? pubPath ?? root)]);

    // ---- build configuration ----------------------------------------------------------------------------------------------------
    const build: BuildInfo = { scripts: [], configFiles: [], typescript: null, docker: [], ci: [] };
    if (node)
      build.scripts = node.scripts
        .filter((s) =>
          /^(dev|start|build|test|lint|typecheck|format|e2e|generate|migrate|serve|preview|prepare|start:\w+|build:\w+|test:\w+|db:\w+)$/.test(
            s.name,
          ),
        )
        .sort((a, b) => cmp(a.name, b.name))
        .slice(0, 20);
    build.configFiles = relOwn
      .filter((x) =>
        /^(?:next|nuxt|vite|webpack|rollup|svelte|tailwind|postcss|babel|jest|vitest|playwright|eslint|prettier|drizzle|metro)\.config\.(?:js|cjs|mjs|ts)$|^(?:nest-cli|angular|tsconfig|turbo|nx|lerna|vercel|netlify|app)\.json$|^(?:\.eslintrc(?:\.\w+)?|\.prettierrc(?:\.\w+)?|\.babelrc|\.nvmrc|\.node-version|analysis_options\.yaml|melos\.yaml|pnpm-workspace\.yaml|docker-compose\.ya?ml|Dockerfile|firebase\.json|prisma\/schema\.prisma)$/.test(
          x.r,
        ),
      )
      .map((x) => x.p)
      .sort(cmp)
      .slice(0, 30);
    const tsPath = fileRe(/^tsconfig\.json$/);
    if (tsPath) {
      const j = parseJsonc(await read(tsPath));
      const co = obj(j?.compilerOptions);
      build.typescript = {
        path: tsPath,
        strict: typeof co.strict === 'boolean' ? co.strict : null,
        target: str(co.target, 20),
        module: str(co.module, 20),
      };
    }
    const dockerPath = fileRe(/^Dockerfile$/);
    if (dockerPath) {
      const t = await read(dockerPath);
      const bases: string[] = [];
      if (t)
        for (const [, l] of lines(t, 500)) {
          const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(l);
          if (m && bases.length < 6) bases.push(safeText(m[1], 80));
        }
      build.docker.push({ path: dockerPath, baseImages: bases });
    }
    if (root === '.')
      build.ci = relOwn
        .filter(
          (x) =>
            /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(x.r) ||
            x.r === '.gitlab-ci.yml' ||
            x.r === 'Jenkinsfile',
        )
        .map((x) => x.p)
        .sort(cmp)
        .slice(0, 10);
    if (pub?.isFlutterSdk)
      build.flutter = {
        sdkConstraint: pub.sdkConstraint,
        platforms: platformDirs,
        usesMaterialDesign: pub.usesMaterialDesign,
        assets: pub.assets,
      };

    // ---- capabilities of this project ---------------------------------------------------------------------------------------------
    const pc = dependencyCapabilities([...dedup.values()]);
    if (nextInfo?.localeSegment)
      pc.push({
        name: 'internationalization',
        confidence: 0.85,
        evidence: [ev('file', nextInfo.localeSegment, 'locale route segment')],
      });
    if (nextInfo?.middleware)
      pc.push({
        name: 'request-middleware',
        confidence: 0.9,
        evidence: [ev('file', nextInfo.middleware)],
      });
    if (
      routes.some(
        (r) =>
          r.project === root &&
          (r.kind === 'next-route-handler' ||
            r.kind === 'next-pages-api' ||
            r.kind === 'nest-controller-route'),
      )
    ) {
      const r = routes.find(
        (x) =>
          x.project === root &&
          (x.kind === 'next-route-handler' ||
            x.kind === 'next-pages-api' ||
            x.kind === 'nest-controller-route'),
      )!;
      pc.push({
        name: 'http-api',
        confidence: 0.9,
        evidence: [ev('file', r.file, r.path, r.line)],
      });
    }
    if (nest.swagger)
      pc.push({
        name: 'api-documentation',
        confidence: 0.85,
        evidence: [ev('source', nestMain ?? root, 'SwaggerModule.setup')],
      });
    if (nest.guards > 0)
      pc.push({
        name: 'authorization-guards',
        confidence: 0.7,
        evidence: [
          ev(
            'source',
            nest.modules.find((m) => m.kind === 'nest-controller')?.file ?? root,
            '@UseGuards',
          ),
        ],
      });
    if (build.docker.length)
      pc.push({
        name: 'containerization',
        confidence: 0.9,
        evidence: [ev('file', build.docker[0]!.path)],
      });
    if (build.ci.length)
      pc.push({
        name: 'continuous-integration',
        confidence: 0.9,
        evidence: [ev('file', build.ci[0]!)],
      });
    for (const c of pc) caps.push({ cap: c, project: root, example: kind === 'example' });
    for (const d of dedup.values()) allDeps.push({ ...d, example: kind === 'example' });

    projects.push({
      root,
      name: node?.name ?? pub?.name ?? null,
      kind,
      roles: roles.sort((a, b) => cmp(a.role, b.role)),
      ecosystems: ecosystems.sort(cmp),
      detections,
      packageManager: pm,
      entryPoints: sortEvidence(entryPoints, 6),
      build,
      dependencyCount: dedup.size,
      dependencies: [...dedup.values()]
        .sort((a, b) => cmp(a.ecosystem + a.name, b.ecosystem + b.name))
        .slice(0, 400)
        .map(({ path: _p, ...d }) => d),
    });
  }

  // ---- workspaces ---------------------------------------------------------------------------------------------------------------
  const workspaces: WorkspaceInfo[] = [];
  const members = (root: string, patterns: string[]) => {
    const res = patterns
      .filter((p) => !p.startsWith('!'))
      .map((p) => globToRegExp(root === '.' ? p : `${root}/${p}`));
    const neg = patterns
      .filter((p) => p.startsWith('!'))
      .map((p) => globToRegExp(root === '.' ? p.slice(1) : `${root}/${p.slice(1)}`));
    return roots
      .filter((r) => r !== root && res.some((re) => re.test(r)) && !neg.some((re) => re.test(r)))
      .sort(cmp);
  };
  for (const root of roots) {
    const n = projectNode.get(root);
    const add = (tool: WorkspaceInfo['tool'], patterns: string[], file: string) =>
      workspaces.push({
        tool,
        root,
        patterns,
        members: members(root, patterns),
        evidence: [ev('workspace', file)],
      });
    const pnpmWs = join(root, 'pnpm-workspace.yaml');
    if (byPath.has(pnpmWs)) add('pnpm', parseYamlPackageList(await read(pnpmWs)), pnpmWs);
    else if (n?.workspaces.length)
      add(
        projects.find((p) => p.root === root)?.packageManager?.name === 'yarn' ? 'yarn' : 'npm',
        n.workspaces,
        join(root, 'package.json'),
      );
    const lerna = join(root, 'lerna.json');
    if (byPath.has(lerna)) {
      const j = parseJson(await read(lerna));
      add(
        'lerna',
        Array.isArray(j?.packages)
          ? (j!.packages as unknown[])
              .filter((x): x is string => typeof x === 'string')
              .slice(0, 30)
          : ['packages/*'],
        lerna,
      );
    }
    const melos = join(root, 'melos.yaml');
    if (byPath.has(melos)) add('melos', parseYamlPackageList(await read(melos)), melos);
    if (byPath.has(join(root, 'nx.json')))
      add('nx', ['apps/*', 'libs/*', 'packages/*'], join(root, 'nx.json'));
    if (byPath.has(join(root, 'turbo.json')) && !workspaces.some((w) => w.root === root))
      add('turbo', ['apps/*', 'packages/*'], join(root, 'turbo.json'));
  }
  const wsRoots = new Set(workspaces.map((w) => w.root));
  for (const top of ['apps', 'packages', 'services', 'libs']) {
    const m = roots.filter((r) => dirname(r) === top || dirname(r) === `${dirname(top)}/${top}`);
    const base = roots.find((r) => r === '.' || dirname(r) === '.');
    if (
      m.length >= 2 &&
      !workspaces.some((w) => w.members.length && m.every((x) => w.members.includes(x)))
    ) {
      const parent = '.';
      if (!wsRoots.has(parent))
        workspaces.push({
          tool: 'convention',
          root: parent,
          patterns: [`${top}/*`],
          members: m.sort(cmp),
          evidence: m.slice(0, 3).map((x) => ev('directory', x)),
        });
      void base;
    }
  }
  workspaces.sort((a, b) => cmp(a.root + a.tool, b.root + b.tool));

  // ---- aggregation --------------------------------------------------------------------------------------------------------------
  let pool = projects.filter((p) => p.kind !== 'example');
  if (pool.length === 0 && projects.length > 0) {
    pool = projects;
    ambiguities.push({
      code: 'only_example_paths',
      detail:
        'every project lives under an example, test or docs directory; they are reported as the package content',
      paths: projects.slice(0, 4).map((p) => p.root),
    });
  } else if (
    projects.some((p) => p.kind === 'example') &&
    projects.some((p) => p.kind !== 'example')
  ) {
    ambiguities.push({
      code: 'examples_excluded',
      detail:
        'projects under example, test or docs directories are listed but not counted in the package frameworks',
      paths: projects
        .filter((p) => p.kind === 'example')
        .slice(0, 4)
        .map((p) => p.root),
    });
  }
  const fwBest = new Map<string, Detection>();
  for (const p of pool)
    for (const d of p.detections)
      if (
        (d.category === 'framework' || d.category === 'runtime') &&
        d.confidence >= 0.5 &&
        (fwBest.get(d.id)?.confidence ?? 0) < d.confidence
      )
        fwBest.set(d.id, d);
  const frameworks = [...fwBest.keys()].sort(cmp);
  const langNames = new Set<string>();
  for (const p of pool)
    for (const d of p.detections)
      if (d.category === 'language' && d.confidence >= 0.5) langNames.add(d.id);
  for (const l of languageStats.slice(0, 8)) if (l.bytes > 0) langNames.add(l.name);
  const capAgg = new Map<string, ManifestCapability>();
  for (const { cap, example } of caps) {
    if (example && pool.some((p) => p.kind !== 'example')) continue;
    const cur = capAgg.get(cap.name);
    capAgg.set(
      cap.name,
      cur
        ? {
            name: cur.name,
            confidence: Math.max(cur.confidence, cap.confidence),
            evidence: sortEvidence([...cur.evidence, ...cap.evidence], 6),
          }
        : cap,
    );
  }
  if (languageStats.length && projects.length === 0)
    ambiguities.push({
      code: 'no_manifest',
      detail:
        'no package.json, pubspec.yaml or other supported manifest was found; nothing can be detected without evidence',
      paths: [],
    });
  const pms = [
    ...new Set(
      projects
        .map((p) => p.packageManager?.name)
        .filter((x): x is PackageManagerInfo['name'] => !!x),
    ),
  ].sort(cmp);
  routes.sort(
    (a, b) =>
      cmp(a.project, b.project) ||
      cmp(a.path, b.path) ||
      cmp(a.kind, b.kind) ||
      cmp(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  if (routes.length > o.maxRoutes) {
    routes.length = o.maxRoutes;
    truncated.add('routes');
  }
  void levelOf;
  void round;
  const nameList = (xs: ModuleFact[]) => [...new Set(xs.map((x) => x.name))].sort(cmp);
  stats.truncated = [...truncated].sort(cmp);
  const byFile = (a: ModuleFact, b: ModuleFact) =>
    cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0);
  return {
    schemaVersion: '1',
    analyzer: { id: 'project-detect', version: ANALYZER_VERSION },
    frameworks,
    languages: [...langNames].sort(cmp),
    languageStats,
    packageManagers: pms,
    modules: nameList(moduleFacts.filter((m) => m.kind === 'nest-module')),
    components: [],
    capabilities: [...capAgg.values()].sort((a, b) => cmp(a.name, b.name)),
    projects,
    workspaces,
    routes,
    screens: screens.sort(byFile).slice(0, 500),
    moduleFacts: moduleFacts.sort(byFile).slice(0, 1000),
    ambiguities: ambiguities.sort((a, b) => cmp(a.code + a.paths.join(), b.code + b.paths.join())),
    stats,
  };
}
void allDepsUnused;
function allDepsUnused() {
  return null;
}
