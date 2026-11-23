import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { analyzeProject } from './analyze';
import type { ProjectManifest } from './types';
import * as fx from './testing/fixtures';
import { asInput, type Tree } from './testing/fixtures';

vi.setConfig({ testTimeout: 60_000 });
const run = (t: Tree, over?: Parameters<typeof asInput>[1]) => analyzeProject(asInput(t, over));
const det = (m: ProjectManifest, id: string, root = '.') =>
  m.projects.find((p) => p.root === root)?.detections.find((d) => d.id === id);
const paths = (m: ProjectManifest, id: string) => (det(m, id)?.evidence ?? []).map((e) => e.path);

describe('positive fixtures', () => {
  it('Next.js (app router): version from the lockfile, evidence, routes from the file convention, capabilities', async () => {
    const m = await run(fx.nextApp());
    const next = det(m, 'nextjs')!;
    expect(next).toMatchObject({
      name: 'Next.js',
      version: '15.0.3',
      versionSource: 'lockfile',
      level: 'high',
    });
    expect(next.evidence.map((e) => `${e.kind}:${e.path}`)).toEqual(
      expect.arrayContaining([
        'dependency:package.json',
        'config:next.config.mjs',
        'directory:app',
      ]),
    );
    expect(next.evidence.find((e) => e.kind === 'dependency')).toMatchObject({
      detail: 'next@^15.0.1',
      line: expect.any(Number),
    });
    expect(det(m, 'react')).toMatchObject({ version: '19.0.0', versionSource: 'lockfile' });
    expect(det(m, 'typescript')).toMatchObject({
      category: 'language',
      version: '5.4.0',
      versionSource: 'declared',
    });
    expect(det(m, 'tailwindcss')!.evidence.map((e) => e.path)).toContain('tailwind.config.ts');
    expect(m.frameworks).toEqual(['nextjs', 'nodejs', 'react']);
    expect(m.packageManagers).toEqual(['npm']);
    expect(m.routes.map((r) => `${r.kind} ${r.methods.join('|')} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'next-app-page GET /',
        'next-app-page GET /about',
        'next-app-page GET /[locale]/dashboard',
        'next-app-page GET /blog/[...slug]',
        'next-route-handler GET|POST /api/users',
      ]),
    );
    expect(m.routes.some((r) => r.path.includes('(marketing)') || r.path.includes('@modal'))).toBe(
      false,
    ); // groups and slots are not URL segments
    expect(m.routes.find((r) => r.path === '/[locale]/dashboard')!.dynamic).toBe(true);
    expect(m.capabilities.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'http-api',
        'internationalization',
        'request-middleware',
        'styling-system',
      ]),
    );
    const p = m.projects[0]!;
    expect(p).toMatchObject({ kind: 'application', packageManager: { name: 'npm' } });
    expect(p.roles.map((r) => r.role)).toEqual(['backend', 'frontend']); // route handlers make it full-stack
    expect(p.build.scripts.map((s) => s.name)).toEqual(['build', 'dev', 'start']);
    expect(p.build.typescript).toMatchObject({
      path: 'tsconfig.json',
      strict: true,
      target: 'ES2022',
    }); // comments and trailing commas are tolerated
    expect(p.entryPoints.map((e) => e.path)).toContain('app/layout.tsx');
    expect(m.ambiguities).toEqual([]);
  });
  it('Next.js (pages router) with a declared-only version', async () => {
    const m = await run(fx.nextPages());
    expect(det(m, 'nextjs')).toMatchObject({ version: '13.5.6', versionSource: 'declared' });
    expect(m.routes.map((r) => `${r.kind} ${r.path}`)).toEqual([
      'next-pages-page /',
      'next-pages-api /api/hello',
      'next-pages-page /blog',
      'next-pages-page /blog/[slug]',
    ]);
    expect(m.routes.every((r) => !r.file.includes('_app') && !r.file.includes('_document'))).toBe(
      true,
    );
  });
  it('NestJS: modules, controllers, routes with the global prefix, guards, swagger, docker', async () => {
    const m = await run(fx.nestApp());
    expect(det(m, 'nestjs')).toMatchObject({ version: '10.3.0', level: 'high' });
    expect(paths(m, 'nestjs')).toEqual(
      expect.arrayContaining(['package.json', 'nest-cli.json', 'src/main.ts']),
    );
    expect(det(m, 'nodejs')).toMatchObject({ version: '20', category: 'runtime', level: 'high' });
    expect(m.modules).toEqual(['AppModule', 'UsersModule']);
    expect(m.routes.map((r) => `${r.methods[0]} ${r.path}`).sort()).toEqual([
      'DELETE /api/users/:id/avatar',
      'GET /api/users',
      'GET /api/users/:id',
      'POST /api/users',
    ]);
    expect(m.routes.every((r) => r.file === 'src/users/users.controller.ts' && r.line)).toBe(true);
    expect(m.routes.some((r) => r.path.includes('ignored'))).toBe(false); // spec files are not analysed
    expect(m.capabilities.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'api-documentation',
        'authentication',
        'authorization-guards',
        'containerization',
        'database-access',
      ]),
    );
    expect(m.projects[0]!.build.docker).toEqual([
      { path: 'Dockerfile', baseImages: ['node:20-alpine', 'node:20-alpine'] },
    ]);
    expect(m.projects[0]!.roles.map((r) => r.role)).toEqual(['backend']);
    expect(m.packageManagers).toEqual([]); // no lockfile or packageManager field: nothing is guessed
  });
  it('Flutter: SDK dependency, Dart, platforms, state management, screens and routes', async () => {
    const m = await run(fx.flutterApp());
    expect(det(m, 'flutter')).toMatchObject({ level: 'high' });
    expect(det(m, 'dart')).toMatchObject({ category: 'language', version: '3.3.0' });
    expect(det(m, 'go-router')).toMatchObject({ version: '13.2.4', versionSource: 'lockfile' });
    expect(det(m, 'flutter-bloc')).toBeTruthy();
    expect(det(m, 'provider')).toBeTruthy();
    expect(m.packageManagers).toEqual(['pub']);
    expect(m.projects[0]!.build.flutter).toEqual({
      sdkConstraint: '>=3.3.0 <4.0.0',
      platforms: ['android', 'ios', 'web'],
      usesMaterialDesign: true,
      assets: 2,
    });
    expect(m.routes.map((r) => r.path)).toEqual(['/', '/workouts/:id']);
    expect(m.routes[1]).toMatchObject({
      kind: 'flutter-route',
      dynamic: true,
      file: 'lib/router.dart',
    });
    expect(m.screens.map((s) => s.name)).toEqual(['HomeScreen', 'WorkoutPage']);
    expect(m.screens.map((s) => s.name)).not.toContain('PrimaryButton'); // a widget that is not a screen
    expect(m.projects[0]!.roles.map((r) => r.role)).toEqual(['mobile']);
    expect(m.capabilities.map((c) => c.name)).toEqual(
      expect.arrayContaining(['state-management', 'internationalization']),
    );
    expect(m.frameworks).toEqual(['flutter']);
    expect(m.languages).toContain('dart');
  });
  it('plain Dart package: Dart, not Flutter', async () => {
    const m = await run(fx.dartCli());
    expect(det(m, 'dart')).toBeTruthy();
    expect(det(m, 'flutter')).toBeUndefined();
    expect(m.frameworks).toEqual([]);
    expect(m.projects[0]!.roles.map((r) => r.role)).toEqual(['library']);
  });
  it('pnpm + Turborepo full stack: workspace members, per-project frameworks, pnpm lock versions, application boundaries', async () => {
    const m = await run(fx.pnpmFullstack());
    expect(m.workspaces).toEqual([
      {
        tool: 'pnpm',
        root: '.',
        patterns: ['apps/*', 'packages/*'],
        members: ['apps/api', 'apps/web', 'packages/ui'],
        evidence: [{ kind: 'workspace', path: 'pnpm-workspace.yaml' }],
      },
    ]);
    expect(m.projects.map((p) => `${p.root}:${p.kind}`)).toEqual([
      '.:tooling-root',
      'apps/api:application',
      'apps/web:application',
      'packages/ui:library',
    ]);
    expect(det(m, 'nextjs', 'apps/web')).toMatchObject({
      version: '15.0.2',
      versionSource: 'lockfile',
    }); // the peer suffix of the pnpm lock is stripped
    expect(det(m, 'nestjs', 'apps/api')).toMatchObject({ version: '10.4.1' });
    expect(det(m, 'nextjs', 'apps/api')).toBeUndefined(); // frameworks do not leak across applications
    expect(m.projects[0]!.packageManager).toMatchObject({ name: 'pnpm', version: '9.1.0' });
    expect(m.frameworks).toEqual(expect.arrayContaining(['nestjs', 'nextjs']));
    expect(m.routes.some((r) => r.project === 'apps/api' && r.path === '/health')).toBe(true);
    expect(m.routes.some((r) => r.project === 'apps/web' && r.path === '/about')).toBe(true);
  });
  it('React (Vite SPA), Express (yarn.lock), Django and Laravel', async () => {
    const r = await run(fx.reactVite());
    expect(det(r, 'react')).toBeTruthy();
    expect(det(r, 'vite')).toBeTruthy();
    expect(r.projects[0]!.roles.map((x) => x.role)).toEqual(['frontend']);
    const e = await run(fx.expressApi());
    expect(det(e, 'express')).toMatchObject({ version: '4.19.2', versionSource: 'lockfile' });
    expect(e.packageManagers).toEqual(['yarn']);
    expect(det(e, 'nodejs')!.confidence).toBeGreaterThanOrEqual(0.5);
    const d = await run(fx.djangoApp());
    expect(det(d, 'django')).toMatchObject({
      evidence: expect.arrayContaining([expect.objectContaining({ path: 'manage.py' })]),
    });
    expect(d.packageManagers).toEqual(['pip']);
    const l = await run(fx.laravelApp());
    expect(det(l, 'laravel')).toBeTruthy();
    expect(l.packageManagers).toEqual(['composer']);
  });
});

describe('negative fixtures: no evidence, no detection', () => {
  it('a README or docs that merely mention frameworks detect nothing', async () => {
    const m = await run(fx.readmeOnly());
    expect(m.frameworks).toEqual([]);
    expect(m.projects[0]!.detections.map((d) => d.id)).toEqual(['nodejs']);
    expect(det(m, 'nodejs')).toMatchObject({ confidence: 0.15, level: 'low' });
    expect(det(m, 'nodejs')!.notes[0]).toMatch(/tooling/);
    expect(m.capabilities).toEqual([]);
  });
  it('an empty package.json, no manifest at all, and a Flutter-shaped folder without a pubspec', async () => {
    expect((await run(fx.emptyPackageJson())).frameworks).toEqual([]);
    const none = await run(fx.noManifest());
    expect(none.projects).toEqual([]);
    expect(none.ambiguities.map((a) => a.code)).toEqual(['no_manifest']);
    expect(none.languages).toEqual(['python']);
    const lay = await run(fx.flutterLayoutOnly());
    expect(lay.frameworks).toEqual([]);
    expect(lay.projects).toEqual([]);
  });
  it('a framework found only in devDependencies is reported with its weaker confidence and an ambiguity', async () => {
    const m = await run(fx.nextDevOnly());
    expect(det(m, 'nextjs')!.confidence).toBeLessThan(0.5);
    expect(det(m, 'nextjs')!.notes).toContain('declared only as a development dependency');
    expect(m.frameworks).toEqual([]); // below 0.5 it is not a package framework
    expect(m.ambiguities.map((a) => a.code)).toContain('framework_dev_dependency_only');
  });
  it('a Dart package with Flutter-like folders but no Flutter SDK stays Dart', async () => {
    const m = await run(fx.dartFlutterLayoutNoSdk());
    expect(det(m, 'flutter')).toBeUndefined();
    expect(m.ambiguities.map((a) => a.code)).toContain('flutter_layout_without_sdk');
  });
  it("examples inside a library do not become the library's frameworks", async () => {
    const m = await run(fx.vendoredExamples());
    expect(m.projects.map((p) => `${p.root}:${p.kind}`)).toEqual([
      '.:library',
      'examples/next-demo:example',
    ]);
    expect(m.frameworks).toEqual([]);
    expect(m.ambiguities.map((a) => a.code)).toContain('examples_excluded');
    expect(det(m, 'nextjs', 'examples/next-demo')).toBeTruthy(); // still listed, with its own evidence
  });
});

describe('ambiguous projects are reported, not guessed', () => {
  it('Next without routes, conflicting UI frameworks, two lockfiles, only-example packages', async () => {
    expect((await run(fx.nextNoRoutes())).ambiguities.map((a) => a.code)).toEqual([
      'next_without_routes',
    ]);
    const c = await run(fx.conflicting());
    expect(c.ambiguities.map((a) => a.code)).toContain('conflicting_frameworks');
    expect(c.ambiguities.find((a) => a.code === 'conflicting_frameworks')!.detail).toMatch(
      /nextjs, vue/,
    );
    const l = await run(fx.twoLocks());
    expect(l.ambiguities.find((a) => a.code === 'multiple_package_managers')!.paths).toEqual([
      'package-lock.json',
      'pnpm-lock.yaml',
    ]);
    const only = await run(fx.onlyExamples());
    expect(only.ambiguities.map((a) => a.code)).toContain('only_example_paths');
    expect(only.frameworks).toContain('nextjs'); // reported, because nothing else exists
  });
  it('Nest without a main.ts, and Flutter with unreadable (not stored) sources', async () => {
    const t = fx.nestApp();
    delete t['src/main.ts'];
    expect((await run(t)).ambiguities.map((a) => a.code)).toContain('nest_without_main');
    const f = fx.flutterApp();
    const m = await run(f, { unstored: Object.keys(f).filter((k) => k.endsWith('.dart')) });
    expect(det(m, 'flutter')).toBeTruthy(); // the manifest is enough
    expect(m.routes).toEqual([]); // and nothing is invented about routes
    expect(m.screens).toEqual([]);
  });
});

describe('static, bounded and deterministic', () => {
  it('the same package in any file order gives byte-identical output', async () => {
    const t = fx.pnpmFullstack();
    const keys = Object.keys(t);
    const shuffled: Tree = {};
    for (const k of [...keys].reverse()) shuffled[k] = t[k]!;
    expect(JSON.stringify(await run(shuffled))).toBe(JSON.stringify(await run(t)));
  });
  it('never executes configuration or source: config files are text', async () => {
    (globalThis as Record<string, unknown>).__detect_pwned = undefined;
    const t = fx.nextApp();
    t['next.config.mjs'] = 'globalThis.__detect_pwned = 1; export default {};\n';
    t['package.json'] = t['package.json']!.replace(
      '"scripts": {',
      '"scripts": {"postinstall": "node -e \\"globalThis.__detect_pwned=2\\"",',
    );
    const m = await run(t);
    expect((globalThis as Record<string, unknown>).__detect_pwned).toBeUndefined();
    expect(det(m, 'nextjs')).toBeTruthy();
  });
  it('reads only what it needs: manifests, configs, route-bearing sources; never unstored files', async () => {
    const reads: string[] = [];
    const t = fx.nextApp();
    t['assets/photo.bin'] = 'x';
    await run(t, { reads, unstored: ['next.config.mjs'] });
    expect(reads).not.toContain('assets/photo.bin');
    expect(reads).not.toContain('next.config.mjs');
    expect(reads).toContain('package.json');
  });
  it('oversized and unreadable files are skipped and counted; a throwing reader does not crash the analysis', async () => {
    const t = fx.nextApp();
    t['package.json'] =
      '{"name":"x","dependencies":{"next":"^15"},"pad":"' + 'a'.repeat(600_000) + '"}';
    const m = await run(t);
    expect(m.stats.skippedLarge).toBe(1);
    expect(m.projects[0]!.detections.map((d) => d.id)).toEqual(['typescript']); // only what the file NAMES prove (tsconfig.json exists)
    const input = asInput(fx.nextApp());
    const out = await analyzeProject({
      ...input,
      read: async () => {
        throw new Error('store down');
      },
    });
    expect(out.projects[0]!.detections.some((d) => d.id === 'nextjs')).toBe(false);
  });
  it('budgets: reads, bytes and time are capped and the cut is reported', async () => {
    const files: Tree = {};
    for (let i = 0; i < 60; i++)
      files[`pkg${i}/package.json`] = JSON.stringify({
        name: `p${i}`,
        dependencies: { next: '^15' },
      });
    expect((await analyzeProject(asInput(files), { maxFilesRead: 10 })).stats).toMatchObject({
      filesRead: 10,
      truncated: expect.arrayContaining(['files_read']),
    });
    expect((await analyzeProject(asInput(files), { maxProjects: 5 })).projects).toHaveLength(5);
    let t = 0;
    const slow = await analyzeProject(asInput(files), { now: () => (t += 50), maxMillis: 120 });
    expect(slow.stats.truncated).toContain('time');
    const many = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`app/r${i}/page.tsx`, 'x']),
    ) as Tree;
    many['package.json'] = JSON.stringify({ dependencies: { next: '1' } });
    const big = await analyzeProject(asInput(many), { maxRoutes: 100 });
    expect(big.routes).toHaveLength(100);
    expect(big.stats.truncated).toContain('routes');
  });
});

describe('hostile input', () => {
  it('survives prototype-pollution keys, deep JSON, huge dependency lists and invalid JSON', async () => {
    const proto =
      '{"name":"x","__proto__":{"polluted":true},"dependencies":{"__proto__":"1","constructor":"2","next":"^15"},"scripts":{"__proto__":"x"}}';
    const m = await run({ 'package.json': proto });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(det(m, 'nextjs')).toBeTruthy();
    const deep = '{"a":'.repeat(200) + '1' + '}'.repeat(200);
    expect((await run({ 'package.json': deep })).projects[0]!.detections).toEqual([]);
    expect((await run({ 'package.json': '{{{{ not json' })).frameworks).toEqual([]);
    const huge = JSON.stringify({
      dependencies: Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => [`dep-${i}`, '^1']),
      ),
    });
    const hm = await run({ 'package.json': huge.length < 500_000 ? huge : '{}' });
    expect(hm.projects[0]!.dependencyCount).toBeLessThanOrEqual(5000);
    expect(hm.projects[0]!.dependencies.length).toBeLessThanOrEqual(400);
  });
  it('line-based scans are linear: a megabyte line or a million @Controller( tokens cannot stall them', async () => {
    const t = fx.nestApp();
    t['src/evil.controller.ts'] = '@Controller('.repeat(80_000) + '\n' + 'x'.repeat(400_000);
    t['src/evil2.module.ts'] = "@Get('" + 'a'.repeat(300_000);
    const t0 = Date.now();
    const m = await run(t);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(det(m, 'nestjs')).toBeTruthy();
  });
  it('route and name text from source is restricted to a safe alphabet; control and bidi characters never reach the manifest', async () => {
    const t = fx.nestApp();
    t['src/x.controller.ts'] =
      "@Controller('a‮b')\nexport class X {\n  @Get('ok\u0000')\n  a() {}\n  @Get('fine/:id')\n  b() {}\n}\n";
    t['package.json'] = JSON.stringify({
      name: 'evil‮\u0000name',
      dependencies: { '@nestjs/core': '^10' },
    });
    const m = await run(t);
    const text = JSON.stringify(m);
    // eslint-disable-next-line no-control-regex -- asserting that control characters never survive
    expect(text).not.toMatch(/[\u0000-\u001f‮]/);
    // a controller prefix with a bidi character makes every route under it "(invalid)" rather than a spoofed path
    expect(m.routes.filter((r) => r.file === 'src/x.controller.ts').map((r) => r.path)).toEqual([
      '/api/(invalid)',
      '/api/(invalid)',
    ]);
    expect(m.projects[0]!.name).not.toContain('‮');
  });
  it('paths with odd characters, empty trees and a thousand manifests do not crash', async () => {
    expect((await analyzeProject({ files: [], read: async () => null })).projects).toEqual([]);
    const odd: Tree = {
      'a b/c\\d/package.json': '{"dependencies":{"next":"1"}}',
      '../x/package.json': '{}',
      '/abs/package.json': '{}',
      '/package.json': '{}',
      'p/ünï/package.json': '{}',
    };
    await expect(run(odd)).resolves.toBeTruthy();
  });
  it('the manifest stays small however large the package is', async () => {
    const t = fx.pnpmFullstack();
    for (let i = 0; i < 400; i++)
      t[`packages/lib${i}/package.json`] = JSON.stringify({
        name: `l${i}`,
        main: 'x',
        dependencies: { lodash: '^4', react: '^18' },
      });
    const m = await run(t);
    expect(JSON.stringify(m).length).toBeLessThan(1_500_000);
  });
  it('fuzz: any package.json content gives a bounded, JSON-serialisable manifest and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.json({ maxDepth: 4 }),
          fc.constant(
            '{"dependencies":{"next":null,"react":{},"vue":[1]},"scripts":{"a":5},"workspaces":[1,"a/*"],"engines":7}',
          ),
        ),
        async (text) => {
          const m = await run({ 'package.json': text, 'app/page.tsx': 'x' });
          const s = JSON.stringify(m);
          expect(s.length).toBeLessThan(200_000);
          expect(JSON.parse(s)).toEqual(m);
          for (const p of m.projects)
            for (const d of p.detections) expect(d.evidence.length).toBeGreaterThan(0); // no detection without evidence
        },
      ),
      { numRuns: 300 },
    );
  });
  it('every detection in every fixture has evidence, a level that matches its confidence, and bounded evidence', async () => {
    const trees = [
      fx.nextApp(),
      fx.nextPages(),
      fx.nestApp(),
      fx.flutterApp(),
      fx.dartCli(),
      fx.pnpmFullstack(),
      fx.reactVite(),
      fx.expressApi(),
      fx.djangoApp(),
      fx.laravelApp(),
      fx.readmeOnly(),
      fx.vendoredExamples(),
    ];
    for (const t of trees) {
      const m = await run(t);
      for (const p of m.projects)
        for (const d of p.detections) {
          expect(d.evidence.length).toBeGreaterThan(0);
          expect(d.evidence.length).toBeLessThanOrEqual(8);
          expect(d.level).toBe(
            d.confidence >= 0.8 ? 'high' : d.confidence >= 0.5 ? 'medium' : 'low',
          );
          expect(d.confidence).toBeLessThanOrEqual(0.99);
          for (const e of d.evidence)
            expect(
              Object.keys(t).some(
                (k) => k === e.path || k.startsWith(`${e.path}/`) || e.path === '.',
              ),
            ).toBe(true); // evidence points at real paths
        }
      for (const c of m.capabilities) expect(c.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('golden manifests (the whole output is pinned: any change to detection must be a conscious, reviewed change)', () => {
  const cases: [string, () => Tree][] = [
    ['next-app', fx.nextApp],
    ['nest-app', fx.nestApp],
    ['flutter-app', fx.flutterApp],
    ['pnpm-fullstack', fx.pnpmFullstack],
    ['readme-only', fx.readmeOnly],
    ['vendored-examples', fx.vendoredExamples],
  ];
  it.each(cases)('%s', async (name, make) => {
    await expect(`${JSON.stringify(await run(make()), null, 2)}\n`).toMatchFileSnapshot(
      `./golden/${name}.json`,
    );
  });
});
