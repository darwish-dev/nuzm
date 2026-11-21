import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@nuzm/platform';
import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import { FsObjectStore } from '@nuzm/adapter-knowledge-store';
import { knowledgeArchiveTesting } from '@nuzm/domain';
import { KnowledgeIngestService, type IngestServiceOptions } from './ingest-service';
import { ThreadParserSandbox } from './ast/parser-sandbox';
import { scriptedSandbox } from './ast/scripted-sandbox.testing';
import type { ParseOutcome } from './ast/sandbox-protocol';

/**
 * S-K2c on a real PostgreSQL under the real `nuzm_worker` role: VALIDATE -> EXTRACT -> DETECT -> COMPONENTS, with components, relationships, the schema-2 manifest and
 * the per-file cache written in one transaction; hostile sources inside the package; incrementality across versions; every guard of the database.
 */
const { buildZip } = knowledgeArchiveTesting;
let env: TestEnv;
let dir: string;
let store: FsObjectStore;
// one pool of real parser threads shared by the suite (starting a thread from source takes seconds); tests of the stage's own lifecycle opt out with `parser: undefined`
let shared: ThreadParserSandbox;
const UPLOADER = '00000000-0000-7000-8000-0000000000f1';
const MIT =
  'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const zipOf = (tree: Record<string, string>) =>
  buildZip(
    Object.entries({ LICENSE: MIT, ...tree }).map(([name, data]) => ({
      name,
      data: Buffer.from(data),
    })),
  );

const NEXT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '^15', react: '^19' } }),
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  'src/app/layout.tsx':
    'export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }',
  'src/app/page.tsx':
    "import { Card } from '@/components';\nimport Button from '@/components/button';\nexport default function Home() { return <Card><Button label=\"buy\" /></Card>; }",
  'src/app/api/items/route.ts': 'export async function GET() { return Response.json([]); }',
  'src/components/index.ts': "export * from './card';",
  'src/components/card.tsx':
    "import { Icon } from './icon';\nexport function Card({ children }: { children?: React.ReactNode }) { return <section><Icon />{children}</section>; }",
  'src/components/icon.tsx': 'export const Icon = () => <svg />;',
  'src/components/button.tsx':
    'interface P { label: string; primary?: boolean }\nconst Button = ({ label, primary = false }: P) => <button>{label}</button>;\nexport default Button;',
  'src/components/unused.tsx': 'export const Unused = () => <i />;',
  'src/lib/util.ts': 'export const x = 1;',
};
const NEST: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'api',
    dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' },
  }),
  'src/main.ts': 'const app = await NestFactory.create(AppModule);',
  'src/app.module.ts':
    "import { UsersModule } from './users/users.module';\n@Module({ imports: [UsersModule] })\nexport class AppModule {}",
  'src/users/users.module.ts':
    "import { UsersController } from './users.controller';\nimport { UsersService } from './users.service';\n@Module({ controllers: [UsersController], providers: [UsersService] })\nexport class UsersModule {}",
  'src/users/users.controller.ts':
    "import { UsersService } from './users.service';\n@Controller('users')\nexport class UsersController { constructor(private readonly users: UsersService) {} @Get() list() {} }",
  'src/users/users.service.ts': '@Injectable()\nexport class UsersService {}',
};
const FLUTTER: Record<string, string> = {
  'pubspec.yaml':
    'name: gym\nenvironment:\n  sdk: ">=3.3.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^13.0.0\n',
  'lib/main.dart':
    "import 'package:gym/screens/home_screen.dart';\nimport 'package:gym/router.dart';\nvoid main() { runApp(const App()); }\nclass App extends StatelessWidget { const App({super.key}); Widget build(BuildContext c) => MaterialApp.router(routerConfig: router); }",
  'lib/router.dart':
    "import 'package:gym/screens/home_screen.dart';\nfinal router = GoRouter(routes: [GoRoute(path: '/', builder: (c, s) => const HomeScreen())]);",
  'lib/screens/home_screen.dart':
    "import 'package:gym/widgets/tile.dart';\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key, required this.title});\n  final String title;\n  Widget build(BuildContext c) => Column(children: [Tile(label: title)]);\n}",
  'lib/widgets/tile.dart':
    'class Tile extends StatelessWidget { const Tile({super.key, required this.label}); final String label; Widget build(BuildContext c) => Text(label); }',
};

beforeAll(async () => {
  env = await createEnv();
  dir = mkdtempSync(join(tmpdir(), 'nuzm-comp-'));
  store = new FsObjectStore(dir);
  shared = new ThreadParserSandbox({ threads: 2, startupTimeoutMs: 60_000 });
});
afterAll(async () => {
  await shared.close();
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});
const service = (opts: IngestServiceOptions = {}, s: FsObjectStore = store) =>
  new KnowledgeIngestService(env.worker, s, {
    heartbeatMs: 50,
    detect: true,
    components: true,
    parser: shared,
    ...opts,
  });

async function submit(bytes: Buffer, resourceId?: string) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await store.put(`archives/${sha}`, bytes, { ifAbsent: true });
  const rid = resourceId ?? uuidv7();
  const vid = uuidv7();
  let seq = 1;
  if (resourceId)
    seq =
      Number(
        (
          await env.sql(
            `SELECT max(seq)::int AS m FROM knowledge.resource_versions WHERE resource_id = $1`,
            [rid],
          )
        )[0]!.m,
      ) + 1;
  else {
    await env.sql(
      `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, visibility, source_kind, status, data_region) VALUES ($1,NULL,$2,$2,'THEME','WEB','PLATFORM_PRIVATE','upload','QUARANTINED','sa-central')`,
      [rid, `r-${rid.slice(-8)}`],
    );
  }
  await env.sql(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, created_by) VALUES ($1,$2,NULL,$3,'QUARANTINED',$4,$5,$6,$7)`,
    [vid, rid, seq, sha, bytes.length, `archives/${sha}`, UPLOADER],
  );
  await env.sql(`UPDATE knowledge.resources SET current_version_id = $2 WHERE id = $1`, [rid, vid]);
  await env.sql(
    `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
    [uuidv7(), vid],
  );
  return { rid, vid };
}
const state = async (vid: string) =>
  (
    await env.sql(
      `SELECT state, state_reason, ingest_summary FROM knowledge.resource_versions WHERE id = $1`,
      [vid],
    )
  )[0]!;
const jobs = async (vid: string) =>
  (
    await env.sql(
      `SELECT kind, state FROM knowledge.processing_jobs WHERE version_id = $1 ORDER BY created_at`,
      [vid],
    )
  ).map((j) => `${j.kind}:${j.state}`);
const comps = async (vid: string) =>
  env.sql(
    `SELECT name, kind, framework, path, props, dependencies, style_deps, platforms, reuse_allowed FROM knowledge.resource_components WHERE version_id = $1 ORDER BY path, name`,
    [vid],
  );
const rels = async (vid: string, relation?: string) =>
  (
    await env.sql(
      `SELECT from_kind, from_ref, to_kind, to_ref, relation FROM knowledge.resource_relationships WHERE version_id = $1 ${relation ? `AND relation = '${relation}'` : ''} ORDER BY from_ref, to_ref`,
      [vid],
    )
  ).map((r) => `${r.relation}:${r.from_ref}->${r.to_ref}`);
const manifest2 = async (vid: string) =>
  (
    await env.sql(
      `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1 AND schema_version = '2'`,
      [vid],
    )
  )[0]?.manifest as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('the COMPONENTS stage', () => {
  it('Next.js: components with props, aliases and barrels resolved, routes linked to pages, architecture, schema-2 manifest; only then review', async () => {
    const s = await submit(zipOf(NEXT));
    for (let i = 0; i < 3; i++) await service().runOnce(); // VALIDATE, EXTRACT, DETECT
    expect(await state(s.vid)).toMatchObject({ state: 'ANALYZING' });
    expect(await jobs(s.vid)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
      'DETECT:SUCCEEDED',
      'COMPONENTS:QUEUED',
    ]);
    expect(await comps(s.vid)).toHaveLength(0);
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const c = await comps(s.vid);
    expect(c.map((x) => `${x.kind}:${x.name}`).sort()).toEqual(
      [
        'react-component:Button',
        'react-component:Card',
        'react-component:Home',
        'react-component:Icon',
        'react-component:RootLayout',
        'react-component:Unused',
      ]
        .sort()
        .map((x) =>
          x
            .replace('react-component:Home', 'next-page:Home')
            .replace('react-component:RootLayout', 'next-layout:RootLayout'),
        )
        .sort(),
    );
    expect(c.every((x) => x.reuse_allowed === false)).toBe(true);
    expect(c.find((x) => x.name === 'Button')!.props).toEqual([
      { name: 'label', type: 'string', required: true },
      { name: 'primary', type: 'boolean', required: false },
    ]);
    const r = await rels(s.vid);
    expect(r).toEqual(
      expect.arrayContaining([
        'renders:src/app/page.tsx#Home->src/components/card.tsx#Card', // alias @/components -> barrel -> card.tsx
        'renders:src/app/page.tsx#Home->src/components/button.tsx#Button', // default import
        'renders:src/components/card.tsx#Card->src/components/icon.tsx#Icon',
        'route_renders:/->src/app/page.tsx#Home',
        'imports:src/app/page.tsx->src/components/index.ts',
      ]),
    );
    const m = (await manifest2(s.vid))!;
    expect(m).toMatchObject({
      schemaVersion: '2',
      frameworks: expect.arrayContaining(['nextjs']),
      componentStats: { total: 6 },
    });
    expect(m.components).toEqual(['Button', 'Card', 'Home', 'Icon', 'RootLayout', 'Unused']);
    expect(m.architecture.orphanComponents).toEqual([
      { name: 'Unused', path: 'src/components/unused.tsx' },
    ]);
    expect(
      m.architecture.layers.map((l: { name: string; role: string }) => `${l.name}:${l.role}`),
    ).toEqual(['app:presentation', 'components:ui', 'lib:shared']);
    expect(m.architecture.cycles).toEqual([]);
    // the previous (schema 1) manifest is untouched; the API serves the newest
    expect(
      (
        await env.sql(
          `SELECT schema_version FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY schema_version`,
          [s.vid],
        )
      ).map((x) => x.schema_version),
    ).toEqual(['1', '2']);
    expect(await jobs(s.vid)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
      'DETECT:SUCCEEDED',
      'COMPONENTS:SUCCEEDED',
    ]);
    const logs = (
      await env.sql(`SELECT code FROM knowledge.processing_logs WHERE version_id = $1`, [s.vid])
    ).map((l) => l.code);
    expect(logs).toEqual(expect.arrayContaining(['components.begin', 'components.done']));
  });
  it('NestJS: modules, controllers, providers and their links from decorators', async () => {
    const s = await submit(zipOf(NEST));
    await service().drain();
    expect((await comps(s.vid)).map((x) => `${x.kind}:${x.name}`).sort()).toEqual([
      'nest-controller:UsersController',
      'nest-module:AppModule',
      'nest-module:UsersModule',
      'nest-provider:UsersService',
    ]);
    expect(await rels(s.vid)).toEqual(
      expect.arrayContaining([
        'imports:src/app.module.ts#AppModule->src/users/users.module.ts#UsersModule',
        'declares:src/users/users.module.ts#UsersModule->src/users/users.controller.ts#UsersController',
        'declares:src/users/users.module.ts#UsersModule->src/users/users.service.ts#UsersService',
        'injects:src/users/users.controller.ts#UsersController->src/users/users.service.ts#UsersService',
      ]),
    );
  });
  it('Flutter: widgets, props, children across package imports, GoRoute to screen, platforms from the manifest', async () => {
    const s = await submit(
      zipOf({ ...FLUTTER, 'android/app/build.gradle': 'x', 'ios/Runner/Info.plist': 'x' }),
    );
    await service().drain();
    const c = await comps(s.vid);
    expect(c.map((x) => `${x.kind}:${x.name}`).sort()).toEqual([
      'flutter-widget:App',
      'flutter-widget:HomeScreen',
      'flutter-widget:Tile',
    ]);
    expect(c.find((x) => x.name === 'Tile')).toMatchObject({
      platforms: ['android', 'ios'],
      props: [{ name: 'label', type: 'String', required: true }],
    });
    expect(await rels(s.vid)).toEqual(
      expect.arrayContaining([
        'renders:lib/screens/home_screen.dart#HomeScreen->lib/widgets/tile.dart#Tile',
        'routes_to:/->lib/screens/home_screen.dart#HomeScreen',
      ]),
    );
  });
  it('flags: without COMPONENTS the flow ends after DETECT; COMPONENTS without DETECT is not claimed', async () => {
    const s = await submit(zipOf(NEXT));
    await service({ components: false }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(await jobs(s.vid)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
      'DETECT:SUCCEEDED',
    ]);
    expect(await manifest2(s.vid)).toBeUndefined();
    const t = await submit(zipOf(NEXT));
    await service({ detect: false, components: true }).drain();
    expect(await state(t.vid)).toMatchObject({ state: 'AWAITING_REVIEW' }); // S-K2a flow
    expect(await jobs(t.vid)).toEqual(['VALIDATE:SUCCEEDED', 'EXTRACT:SUCCEEDED']);
  });
  it('quarantined and rejected packages never reach COMPONENTS', async () => {
    const q = await submit(
      zipOf({ ...NEXT, 'src/leak.ts': `export const k = "${'AKIA' + 'QWERTYUIOPASDFGH'}";` }),
    );
    const h = await submit(buildZip([{ name: '../evil', data: Buffer.from('x') }]));
    await service().drain();
    expect(await state(q.vid)).toMatchObject({
      state: 'QUARANTINED',
      state_reason: 'secrets_found',
    });
    expect(await jobs(q.vid)).toEqual(['VALIDATE:SUCCEEDED', 'EXTRACT:SUCCEEDED']);
    expect(await state(h.vid)).toMatchObject({ state: 'FAILED' });
    expect(await comps(q.vid)).toEqual([]);
  });
  it('incremental: a new version of the same resource re-parses only the changed file; unchanged versions reuse everything', async () => {
    const one = await submit(zipOf(NEXT));
    await service().drain();
    const total = (
      await env.sql(
        `SELECT count(*)::int n FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'ast-file'`,
        [one.vid],
      )
    )[0]!.n as number;
    expect(total).toBeGreaterThan(5);
    const changed = {
      ...NEXT,
      'src/components/icon.tsx': 'export const Icon = () => <svg width="2" />;',
    };
    const two = await submit(zipOf(changed), one.rid);
    await service().drain();
    expect(await state(two.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const fresh = (
      await env.sql(
        `SELECT count(*)::int n FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'ast-file'`,
        [two.vid],
      )
    )[0]!.n as number;
    expect(fresh).toBe(1); // only the changed file was parsed and cached
    expect((await state(two.vid)).ingest_summary).toMatchObject({
      components: { filesReused: total - 1 },
    });
    expect(await comps(two.vid)).toHaveLength((await comps(one.vid)).length);
    // identical content in a third version: nothing parsed at all
    const three = await submit(zipOf(changed), one.rid);
    await service().drain();
    expect(
      (
        await env.sql(
          `SELECT count(*)::int n FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'ast-file'`,
          [three.vid],
        )
      )[0]!.n,
    ).toBe(0);
    expect(JSON.stringify(await rels(three.vid))).toBe(JSON.stringify(await rels(two.vid)));
  });
  it('hostile sources inside the package: minified bundles, NUL bytes, deep nesting, a thousand components, invalid syntax, odd names', async () => {
    const tree: Record<string, string> = {
      ...NEXT,
      'src/min.js': 'var a=' + '1+'.repeat(4000) + '1;',
      'src/nulbyte.tsx': 'export function Nul() { return <div/> }\u0000',
      'src/deep.tsx': `export function Deep() { return ${'(\n'.repeat(15_000)}<div/>${')\n'.repeat(15_000)}; }`,
      'src/many.tsx': Array.from(
        { length: 800 },
        (_, i) => `export const M${i} = () => <i/>;`,
      ).join('\n'),
      'src/broken.tsx': 'export function ( { return <div> ',
      'src/names.tsx':
        'export function __proto__() { return <div/> }\nexport function Constructor() { return <b/> }',
      'src/generated.d.ts': 'export declare const Skipped: () => any;',
      'src/Foo.test.tsx': 'export const TestOnly = () => <i/>;',
      'dist/out.js': 'export const Built = () => 1;',
    };
    const s = await submit(zipOf(tree));
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const c = await comps(s.vid);
    expect(c.some((x) => x.name === 'Skipped' || x.name === 'TestOnly' || x.name === 'Built')).toBe(
      false,
    );
    expect(c.filter((x) => x.path === 'src/many.tsx')).toHaveLength(200); // capped per file
    expect(c.some((x) => x.name === 'Constructor')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const sk = (await manifest2(s.vid))!.architecture.stats.skipped;
    expect(sk.minified).toBeGreaterThanOrEqual(1);
    expect(sk.parse_error).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await manifest2(s.vid)).length).toBeLessThan(1_000_000);
  });
  it('never executes anything: a source file and a config that would leave a marker are only parsed', async () => {
    (globalThis as Record<string, unknown>).__comp_pwned = undefined;
    const s = await submit(
      zipOf({
        ...NEXT,
        'src/evil.tsx':
          "globalThis.__comp_pwned = 1; require('fs').writeFileSync('/tmp/comp-pwned','x'); export function Evil() { return <div/> }",
        'next.config.mjs': 'globalThis.__comp_pwned = 2; export default {};',
      }),
    );
    await service().drain();
    expect((globalThis as Record<string, unknown>).__comp_pwned).toBeUndefined();
    expect((await comps(s.vid)).some((x) => x.name === 'Evil')).toBe(true);
  });
  it('cancellation while analysing stops the stage and writes nothing (no components, no manifest, no cache rows)', async () => {
    const big = { ...NEXT } as Record<string, string>;
    for (let i = 0; i < 60; i++) big[`src/gen/c${i}.tsx`] = `export const G${i} = () => <i/>;`;
    const s = await submit(zipOf(big));
    for (let i = 0; i < 3; i++) await service().runOnce();
    class Slow extends FsObjectStore {
      override async read(k: string) {
        await new Promise((r) => setTimeout(r, 30));
        return super.read(k);
      }
    }
    const running = service({}, new Slow(dir)).runOnce();
    setTimeout(
      () =>
        void env.sql(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE version_id = $1 AND kind = 'COMPONENTS'`,
          [s.vid],
        ),
      250,
    );
    await running;
    expect(await jobs(s.vid)).toContain('COMPONENTS:CANCELLED');
    expect(await state(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await comps(s.vid)).toEqual([]);
    expect(await manifest2(s.vid)).toBeUndefined();
    expect(
      (
        await env.sql(
          `SELECT 1 FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer LIKE 'ast-%'`,
          [s.vid],
        )
      ).length,
    ).toBe(0);
  });
});

const Scripted = scriptedSandbox(() => shared);
const fail = (reason: 'timeout' | 'memory' | 'crashed'): ParseOutcome => ({
  ok: false,
  reason,
  ms: 1,
});
const astRows = async (vid: string) =>
  Number(
    (
      await env.sql(
        `SELECT count(*)::int n FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'ast-file'`,
        [vid],
      )
    )[0]!.n,
  );
const logCodes = async (vid: string) =>
  (
    await env.sql(
      `SELECT code, level FROM knowledge.processing_logs WHERE version_id = $1 ORDER BY created_at`,
      [vid],
    )
  ).map((r) => `${r.level}:${r.code}`);

describe('the parser sandbox inside the COMPONENTS stage', () => {
  it('with no sandbox injected the stage creates its own threads, completes, and closes them', async () => {
    const close = vi.spyOn(ThreadParserSandbox.prototype, 'close');
    try {
      const s = await submit(zipOf(NEXT));
      await service({
        parser: undefined,
        sandbox: { threads: 1, startupTimeoutMs: 60_000 },
      }).drain();
      expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
      expect((await comps(s.vid)).map((c) => c.name)).toContain('Card');
      expect(await logCodes(s.vid)).toContain('info:components.parser');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it('a file stopped at the limits is reported as skipped, never guessed, never cached; the rest of the package is analysed', async () => {
    const s = await submit(zipOf(NEXT));
    const sb = new Scripted((p) =>
      p.endsWith('unused.tsx') ? fail('timeout') : p.endsWith('icon.tsx') ? fail('memory') : null,
    );
    await service({ parser: sb }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const names = (await comps(s.vid)).map((c) => c.name);
    expect(names).toContain('Card');
    expect(names).not.toContain('Unused');
    expect(names).not.toContain('Icon');
    const m = await manifest2(s.vid);
    expect(m!.architecture.stats.skipped).toMatchObject({ timeout: 1, memory: 1 });
    expect(await logCodes(s.vid)).toContain('warn:components.parser_limits');
    // results of failed files are not cached: only files that were really analysed (or deterministically skipped) are
    const clean = await submit(zipOf(NEXT));
    await service().drain();
    expect(await astRows(s.vid)).toBe((await astRows(clean.vid)) - 2);
    // a later run over the same content re-parses exactly the two files that hit limits, and now they succeed
    const again = await submit(zipOf(NEXT), s.rid);
    await service().drain();
    expect(await astRows(again.vid)).toBe(2);
    expect((await comps(again.vid)).map((c) => c.name)).toContain('Unused');
  });

  it('too many sandbox failures stop further parsing: the remaining files are skipped as "deadline" and the package still reaches review', async () => {
    const s = await submit(zipOf(NEXT));
    const sb = new Scripted(() => fail('crashed'));
    await service({ parser: sb, parserMaxFailures: 2 }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const skipped = (await manifest2(s.vid))!.architecture.stats.skipped as Record<string, number>;
    expect(skipped.crashed).toBeGreaterThanOrEqual(2);
    expect(skipped.crashed! + (skipped.deadline ?? 0)).toBeGreaterThanOrEqual(8);
    expect(skipped.deadline).toBeGreaterThan(0);
    expect(sb.calls.length).toBeLessThan(skipped.crashed! + skipped.deadline!);
    expect(await astRows(s.vid)).toBe(0);
    expect(await comps(s.vid)).toEqual([]);
  });

  it('the wall-clock budget of the parsing phase is enforced: once spent, no further file is sent to a thread', async () => {
    const s = await submit(zipOf(NEXT));
    const sb = new Scripted(() => null);
    await service({ parser: sb, parserBudgetMs: 0 }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(sb.calls).toEqual([]);
    const skipped = (await manifest2(s.vid))!.architecture.stats.skipped as Record<string, number>;
    expect(skipped.deadline).toBeGreaterThanOrEqual(8);
    expect(await comps(s.vid)).toEqual([]);
    expect(await astRows(s.vid)).toBe(0);
  });

  it('a sandbox that cannot start is infrastructure trouble: the job is retried, nothing is written', async () => {
    const s = await submit(zipOf(NEXT));
    await service({ parser: new Scripted(() => 'unavailable') }).drain();
    expect(await jobs(s.vid)).toContain('COMPONENTS:QUEUED');
    expect(await state(s.vid)).toMatchObject({ state: 'ANALYZING' });
    expect(await comps(s.vid)).toEqual([]);
    expect(await manifest2(s.vid)).toBeUndefined();
    expect(await astRows(s.vid)).toBe(0);
    expect(await logCodes(s.vid)).toContain('warn:job.retry');
    // the retry (after the back-off) succeeds on a healthy sandbox
    await env.sql(
      `UPDATE knowledge.processing_jobs SET run_after = now() WHERE version_id = $1 AND kind = 'COMPONENTS'`,
      [s.vid],
    );
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
  });

  it('cancellation terminates a parse that is in flight and writes nothing', async () => {
    const s = await submit(zipOf(NEXT));
    for (let i = 0; i < 3; i++) await service().runOnce(); // VALIDATE, EXTRACT, DETECT
    const sb = new Scripted(() => 'hang');
    const running = service({ parser: sb }).runOnce();
    setTimeout(
      () =>
        void env.sql(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE version_id = $1 AND kind = 'COMPONENTS'`,
          [s.vid],
        ),
      300,
    );
    await running;
    expect(sb.aborted).toBe(true); // the in-flight parse was aborted, not waited for
    expect(await jobs(s.vid)).toContain('COMPONENTS:CANCELLED');
    expect(await state(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await comps(s.vid)).toEqual([]);
    expect(await manifest2(s.vid)).toBeUndefined();
    expect(await astRows(s.vid)).toBe(0);
  });

  it('the stage closes the threads it created when it fails or is cancelled', async () => {
    const close = vi.spyOn(ThreadParserSandbox.prototype, 'close');
    try {
      const s = await submit(zipOf(NEXT));
      for (let i = 0; i < 3; i++) await service().runOnce();
      class Missing extends FsObjectStore {
        override async read(): Promise<Buffer> {
          throw new Error('the store is down');
        }
      }
      await service({ parser: undefined, sandbox: { threads: 1 } }, new Missing(dir)).runOnce();
      expect(close).toHaveBeenCalledTimes(1);
      expect(await comps(s.vid)).toEqual([]);
    } finally {
      close.mockRestore();
    }
  });
});

describe('what the worker role may write', () => {
  it('components only for a version being analysed, never reusable, never changed or deleted, platform rows only', async () => {
    const s = await submit(zipOf(NEXT));
    await service({ components: false }).drain(); // AWAITING_REVIEW
    const w = (q: string, p: unknown[] = []) =>
      env.worker.withKnowledgeWorker((c) => c.query(q, p));
    const ins = (reuse = false, org: string | null = null) =>
      w(
        `INSERT INTO knowledge.resource_components (id, version_id, org_id, name, kind, path, reuse_allowed) VALUES ($1,$2,$3,'X','react-component','a.tsx',$4)`,
        [uuidv7(), s.vid, org, reuse],
      );
    await expect(ins()).rejects.toThrow(/being analysed/);
    await expect(
      w(
        `INSERT INTO knowledge.resource_relationships (id, version_id, org_id, from_kind, from_ref, to_kind, to_ref, relation) VALUES ($1,$2,NULL,'file','a','file','b','imports')`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/being analysed/);
    await env.sql(`UPDATE knowledge.resource_versions SET state = 'QUARANTINED' WHERE id = $1`, [
      s.vid,
    ]);
    await env.sql(`UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`, [
      s.vid,
    ]);
    await env.sql(`UPDATE knowledge.resource_versions SET state = 'ANALYZING' WHERE id = $1`, [
      s.vid,
    ]);
    await expect(ins(true)).rejects.toThrow(/row-level security/); // reuse_allowed can never be set by the worker
    await expect(ins(false, '00000000-0000-7000-8000-00000000000a')).rejects.toThrow(
      /row-level security/,
    );
    await ins();
    await expect(
      w(`UPDATE knowledge.resource_components SET reuse_allowed = true WHERE version_id = $1`, [
        s.vid,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      w(`DELETE FROM knowledge.resource_components WHERE version_id = $1`, [s.vid]),
    ).rejects.toThrow(/permission denied/);
    await expect(ins()).rejects.toThrow(/duplicate|unique/); // natural key
  });
});
