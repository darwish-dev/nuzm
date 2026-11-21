import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  analyzeDart,
  assemble,
  buildManifestV2,
  aliasesOf,
  emptyFacts,
  resolveTs,
  resolveDart,
  type AssembleFile,
  type AssembleProject,
  type ComponentFact,
  type FileFacts,
} from './index';

vi.setConfig({ testTimeout: 60_000 });

const HOME = `import 'package:flutter/material.dart';
import 'package:gym_app/widgets/primary_button.dart';
import '../models/user.dart';

/// class Documented extends StatelessWidget {}  (a comment, not a class)
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.title, this.count = 0, this.onTap});
  final String title;
  final int count;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Column(children: [PrimaryButton(label: 'go'), const UserTile(), Text("class Fake extends StatelessWidget {")]),
    );
  }
}

class CounterPage extends StatefulWidget {
  const CounterPage(this.start, {Key? key}) : super(key: key);
  final int start;
  @override
  State<CounterPage> createState() => _CounterPageState();
}
class _CounterPageState extends State<CounterPage> {
  @override
  Widget build(BuildContext context) => Center(child: StatsCard(value: 1));
}
class CartBloc extends Bloc<CartEvent, CartState> {}
class Plain { }
final cartProvider = StateNotifierProvider<CartNotifier, int>((ref) => CartNotifier());
`;
const ROUTER = `import 'package:go_router/go_router.dart';
import 'features/home/home_screen.dart';
final router = GoRouter(routes: [
  GoRoute(
    path: '/',
    builder: (context, state) => const HomeScreen(title: 'x'),
  ),
  GoRoute(path: '/cart', builder: (c, s) { return CartScreen(); }),
]);
`;

describe('Dart lexical analyzer', () => {
  it('reads widgets, state, state holders, providers, props with types and requiredness, children, imports', () => {
    const f = analyzeDart(HOME);
    expect(f.components.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'flutter-widget:HomeScreen',
      'flutter-stateful-widget:CounterPage',
      'flutter-state:_CounterPageState',
      'flutter-state-holder:CartBloc',
      'flutter-provider:cartProvider',
    ]);
    const home = f.components[0]!;
    expect(home.props).toEqual([
      { name: 'title', type: 'String', required: true },
      { name: 'count', type: 'int', required: false },
      { name: 'onTap', type: 'VoidCallback?', required: false },
    ]);
    expect(home.children).toEqual(
      expect.arrayContaining(['PrimaryButton', 'UserTile', 'Scaffold', 'Column']),
    );
    expect(home.children).not.toContain('Fake'); // a widget name inside a string is not a widget
    expect(home.line).toBe(6);
    expect(home.exported).toBe(true);
    // the State's build is folded into the StatefulWidget it belongs to
    const counter = f.components[1]!;
    expect(counter.props).toEqual([{ name: 'start', type: 'int', required: true }]);
    expect(counter.children).toContain('StatsCard');
    expect(f.components[2]!).toMatchObject({
      exported: false,
      links: [{ relation: 'state_of', target: 'CounterPage' }],
    });
    expect(f.imports.map((i) => `${i.kind}:${i.spec}`)).toEqual([
      'dart-package:package:flutter/material.dart',
      'dart-package:package:gym_app/widgets/primary_button.dart',
      'dart-relative:../models/user.dart',
    ]);
    expect(f.exports).toEqual(['CartBloc', 'CounterPage', 'HomeScreen', 'cartProvider']);
  });
  it('commented-out classes, strings, plain classes and abstract bases produce nothing', () => {
    const f = analyzeDart(
      "// class A extends StatelessWidget {}\n/* class B extends StatefulWidget {\n/* nested */ } */\nconst s = 'class C extends StatelessWidget {}';\nclass Plain {}\nabstract class Base { void x() {} }\nclass D extends Base {}\n",
    );
    expect(f.components).toEqual([]);
  });
  it('links GoRoute paths to the screen they build', () => {
    const f = analyzeDart(ROUTER);
    expect(f.routeRefs).toEqual([
      { path: '/', target: 'HomeScreen', line: 6 },
      { path: '/cart', target: 'CartScreen', line: 8 },
    ]);
  });
  it('detects ThemeData and records generic Consumer/Hook widgets', () => {
    const f = analyzeDart(
      "final t = ThemeData(useMaterial3: true);\nclass A extends ConsumerWidget { const A({super.key}); Widget build(c, ref) => Text('x'); }\nclass B extends HookConsumerWidget {}\n",
    );
    expect(f.hasTheme).toBe(true);
    expect(f.components.map((c) => c.name)).toEqual(['A', 'B']);
  });
  it('hostile: a minified single line, NUL bytes, deep nesting, unterminated strings and 20 000 classes stay bounded and fast', () => {
    expect(analyzeDart('class A extends StatelessWidget {}' + ' '.repeat(10_000)).skipped).toBe(
      'minified',
    );
    expect(analyzeDart('class A extends StatelessWidget {}\u0000').skipped).toBe('parse_error');
    const t0 = Date.now();
    analyzeDart(
      'class A extends StatelessWidget {' + '{'.repeat(200_000) + '}'.repeat(200_000) + '}',
    );
    analyzeDart(
      "class A extends StatelessWidget { final x = 'unterminated\nclass B extends StatelessWidget {}",
    );
    const many = analyzeDart('class W0 extends StatelessWidget {}\n'.repeat(20_000));
    expect(many.components.length).toBeLessThanOrEqual(200);
    expect(many.truncated).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('names are identifiers only; __proto__ is just a name and pollutes nothing', () => {
    const f = analyzeDart(
      'class __proto__ extends StatelessWidget {}\nclass constructor extends StatelessWidget {}\n',
    );
    expect(f.components.map((c) => c.name)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      Object.keys(
        assemble(
          [{ path: 'lib/a.dart', project: '.', facts: f }],
          [
            {
              root: '.',
              name: 'x',
              kind: 'application',
              aliases: [],
              dartPackage: 'x',
              entryPoints: [],
              platforms: [],
            },
          ],
          [],
        ),
      ),
    ).toEqual(['components', 'relationships', 'architecture']);
  });
  it('fuzz: arbitrary text never throws and stays bounded', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (s) => {
        const f = analyzeDart(s);
        expect(f.components.length).toBeLessThanOrEqual(200);
        expect(JSON.stringify(f).length).toBeLessThan(150_000);
      }),
      { numRuns: 400 },
    );
  });
});

describe('import resolution', () => {
  const files = new Set([
    'src/a.ts',
    'src/b/index.ts',
    'src/c.tsx',
    'lib/models/user.dart',
    'lib/widgets/x.dart',
  ]);
  it('relative TS imports with extension candidates, index files and .js-to-.ts; nothing outside the package', () => {
    expect(resolveTs('src/x.ts', './a', files, [])).toBe('src/a.ts');
    expect(resolveTs('src/x.ts', './b', files, [])).toBe('src/b/index.ts');
    expect(resolveTs('src/x.ts', './c.js', files, [])).toBe('src/c.tsx');
    expect(resolveTs('src/x.ts', '../../../etc/passwd', files, [])).toBeNull();
    expect(resolveTs('src/x.ts', 'react', files, [])).toBeNull();
  });
  it('tsconfig paths and baseUrl aliases', () => {
    const al = aliasesOf('.', {
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '~lib': ['src/a'] } },
    });
    expect(resolveTs('src/x.ts', '@/b', files, al)).toBe('src/b/index.ts');
    expect(resolveTs('src/x.ts', '~lib', files, al)).toBe('src/a.ts');
    expect(
      aliasesOf('apps/web', { compilerOptions: { paths: { '@/*': ['./src/*'] } } })[0]!.targets,
    ).toEqual(['apps/web/src']);
    expect(aliasesOf('.', null)).toEqual([]);
  });
  it('Dart package: and relative imports resolve only inside the package', () => {
    expect(
      resolveDart('lib/main.dart', 'package:gym/models/user.dart', files, {
        name: 'gym',
        root: '.',
      }),
    ).toBe('lib/models/user.dart');
    expect(
      resolveDart('lib/main.dart', 'package:other/models/user.dart', files, {
        name: 'gym',
        root: '.',
      }),
    ).toBeNull();
    expect(resolveDart('lib/widgets/y.dart', 'x.dart', files, { name: 'gym', root: '.' })).toBe(
      'lib/widgets/x.dart',
    );
  });
});

const comp = (name: string, over: Partial<ComponentFact> = {}): ComponentFact => ({
  name,
  kind: 'react-component',
  framework: 'react',
  line: 1,
  exported: true,
  isDefault: false,
  props: [],
  hooks: [],
  children: [],
  decorators: [],
  links: [],
  ...over,
});
const ts = (over: Partial<FileFacts>): FileFacts => ({ ...emptyFacts('ts'), ...over });
const PROJ: AssembleProject = {
  root: '.',
  name: 'x',
  kind: 'application',
  aliases: aliasesOf('.', { compilerOptions: { paths: { '@/*': ['src/*'] } } }),
  dartPackage: null,
  entryPoints: [],
  platforms: [],
};

describe('assembly: components, relationships, architecture', () => {
  const files: AssembleFile[] = [
    {
      path: 'src/app/page.tsx',
      project: '.',
      facts: ts({
        components: [comp('Home', { isDefault: true, children: ['Card', 'Button', 'Missing'] })],
        imports: [
          {
            spec: '@/components',
            kind: 'package',
            names: ['Card'],
            line: 1,
            style: false,
            asset: false,
          },
          {
            spec: '../components/button',
            kind: 'relative',
            names: ['default:Button'],
            line: 2,
            style: false,
            asset: false,
          },
          {
            spec: './home.module.css',
            kind: 'relative',
            names: [],
            line: 3,
            style: true,
            asset: false,
          },
          { spec: 'react', kind: 'package', names: [], line: 4, style: false, asset: false },
        ],
      }),
    },
    {
      path: 'src/components/index.ts',
      project: '.',
      facts: ts({ reexports: [{ spec: './card', line: 1 }] }),
    },
    {
      path: 'src/components/card.tsx',
      project: '.',
      facts: ts({
        components: [comp('Card', { children: ['Icon'] })],
        imports: [
          {
            spec: './icon',
            kind: 'relative',
            names: ['Icon=Glyph'],
            line: 1,
            style: false,
            asset: false,
          },
        ],
      }),
    },
    {
      path: 'src/components/icon.tsx',
      project: '.',
      facts: ts({ components: [comp('Glyph')], exports: ['Glyph'] }),
    },
    {
      path: 'src/components/button.tsx',
      project: '.',
      facts: ts({
        components: [comp('PrimaryButton', { isDefault: true })],
        imports: [
          { spec: '../app/page', kind: 'relative', names: [], line: 1, style: false, asset: false },
        ],
      }),
    },
    {
      path: 'src/components/orphan.tsx',
      project: '.',
      facts: ts({ components: [comp('Unused')] }),
    },
  ];
  const routes = [{ kind: 'next-app-page', path: '/', file: 'src/app/page.tsx', project: '.' }];
  const r = assemble(files, [PROJ], routes);

  it('builds component rows with dependencies, styles and platform', () => {
    expect(r.components.map((c) => c.name)).toEqual([
      'Home',
      'PrimaryButton',
      'Card',
      'Glyph',
      'Unused',
    ]);
    const home = r.components.find((c) => c.name === 'Home')!;
    expect(home).toMatchObject({
      dependencies: ['react'],
      styleDeps: ['./home.module.css'],
      platforms: ['web'],
      project: '.',
    });
  });
  it('resolves renders through aliases, barrel re-exports, renamed and default imports; unknown children are not invented', () => {
    const renders = r.relationships
      .filter((x) => x.relation === 'renders')
      .map((x) => `${x.fromRef} -> ${x.toRef}`);
    expect(renders).toEqual(
      expect.arrayContaining([
        'src/app/page.tsx#Home -> src/components/card.tsx#Card',
        'src/app/page.tsx#Home -> src/components/button.tsx#PrimaryButton',
        'src/components/card.tsx#Card -> src/components/icon.tsx#Glyph',
      ]),
    );
    expect(renders.some((x) => x.includes('Missing'))).toBe(false);
    expect(r.relationships.find((x) => x.relation === 'route_renders')).toMatchObject({
      fromRef: '/',
      toRef: 'src/app/page.tsx#Home',
    });
    expect(r.relationships.filter((x) => x.relation === 'imports').length).toBeGreaterThan(3);
  });
  it('architecture: layers, modules with weighted dependencies, cycles, reachability, orphans', () => {
    const a = r.architecture;
    expect(a.layers.map((l) => `${l.name}:${l.role}`)).toEqual([
      'app:presentation',
      'components:ui',
    ]);
    expect(
      a.modules.find((m) => m.name === 'src/components')!.dependsOn.map((d) => d.module),
    ).toEqual(['src/app']);
    expect(a.cycles).toEqual([
      { files: ['src/app/page.tsx', 'src/components/button.tsx'], size: 2 },
    ]); // page -> button -> page
    expect(a.entryReachability).toMatchObject({ roots: 1 });
    expect(a.entryReachability!.sample).toEqual(['src/components/orphan.tsx']);
    expect(a.orphanComponents).toEqual([{ name: 'Unused', path: 'src/components/orphan.tsx' }]);
    expect(a.stats).toMatchObject({ files: 6, unresolvedImports: 0 });
  });
  it('is deterministic whatever the input order, and the manifest v2 keeps v1 and adds components and architecture', () => {
    const shuffled = assemble([...files].reverse(), [PROJ], routes);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(r));
    const v2 = buildManifestV2({ schemaVersion: '1', frameworks: ['nextjs'], capabilities: [] }, r);
    expect(v2).toMatchObject({
      schemaVersion: '2',
      frameworks: ['nextjs'],
      components: ['Card', 'Glyph', 'Home', 'PrimaryButton', 'Unused'],
      componentStats: { total: 5 },
    });
    expect(JSON.stringify(v2).length).toBeLessThan(200_000);
  });
  it('Flutter: widget children resolve through relative and package imports; GoRoute links screens; platforms come from the project', () => {
    const home = analyzeDart(HOME);
    const btn = analyzeDart(
      'class PrimaryButton extends StatelessWidget { const PrimaryButton({super.key, required this.label}); final String label; Widget build(c) => Text(label); }',
    );
    const user = analyzeDart(
      'class UserTile extends StatelessWidget { Widget build(c) => ListTile(); }',
    );
    const router = analyzeDart(ROUTER);
    const d: AssembleProject = {
      root: '.',
      name: 'x',
      kind: 'application',
      aliases: [],
      dartPackage: 'gym_app',
      entryPoints: ['lib/main.dart'],
      platforms: ['android', 'ios'],
    };
    const out = assemble(
      [
        { path: 'lib/main.dart', project: '.', facts: analyzeDart('void main() {}') },
        {
          path: 'lib/features/home/home_screen.dart',
          project: '.',
          facts: {
            ...home,
            imports: [
              ...home.imports.filter((i) => i.kind === 'dart-package'),
              {
                spec: '../../models/user.dart',
                kind: 'dart-relative',
                names: [],
                line: 3,
                style: false,
                asset: false,
              },
            ],
          },
        },
        { path: 'lib/widgets/primary_button.dart', project: '.', facts: btn },
        { path: 'lib/models/user.dart', project: '.', facts: user },
        { path: 'lib/router.dart', project: '.', facts: router },
      ],
      [d],
      [],
    );
    const rel = out.relationships.map((x) => `${x.relation}:${x.fromRef}->${x.toRef}`);
    expect(rel).toEqual(
      expect.arrayContaining([
        'renders:lib/features/home/home_screen.dart#HomeScreen->lib/widgets/primary_button.dart#PrimaryButton',
        'renders:lib/features/home/home_screen.dart#HomeScreen->lib/models/user.dart#UserTile',
      ]),
    );
    expect(out.components.find((c) => c.name === 'PrimaryButton')).toMatchObject({
      platforms: ['android', 'ios'],
      props: [{ name: 'label', type: 'String', required: true }],
    });
    expect(out.architecture.stats.internalImports).toBeGreaterThan(0);
  });
  it('caps rows and relationships and says so', () => {
    const many: AssembleFile[] = Array.from({ length: 5200 }, (_, i) => ({
      path: `src/f${i}.tsx`,
      project: '.',
      facts: ts({ components: [comp(`C${i}`)] }),
    }));
    const o = assemble(many, [PROJ], []);
    expect(o.components).toHaveLength(5000);
    expect(o.architecture.stats.truncated).toContain('components');
  });
  it('fuzz: random facts never break assembly or leave dangling references', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('a', 'b', 'c', 'd'),
            fc.array(fc.constantFrom('A', 'B', 'C', 'X'), { maxLength: 4 }),
            fc.array(fc.constantFrom('./a', './b', './c', './d', '../x', 'react', '@/a'), {
              maxLength: 4,
            }),
          ),
          { maxLength: 8 },
        ),
        (spec) => {
          const fs: AssembleFile[] = spec.map(([n, kids, imps]) => ({
            path: `src/${n}.tsx`,
            project: '.',
            facts: ts({
              components: [comp(n.toUpperCase(), { children: kids })],
              imports: imps.map((s, i) => ({
                spec: s,
                kind: s.startsWith('.') ? 'relative' : 'package',
                names: kids,
                line: i + 1,
                style: false,
                asset: false,
              })),
            }),
          }));
          const out = assemble(fs, [PROJ], []);
          const paths = new Set(fs.map((f) => f.path));
          for (const rl of out.relationships)
            if (rl.toKind === 'file') expect(paths.has(rl.toRef)).toBe(true);
          expect(out.architecture.cycles.every((c) => c.size > 1)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
