import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
 * S-K4 on a real PostgreSQL under the real `nuzm_worker` role: VALIDATE -> EXTRACT -> DETECT -> COMPONENTS -> DESIGN. Design tokens, theme variants, the Design DNA and the
 * schema-3 manifest are written in one transaction; configuration files are parsed, never executed; limits, cancellation and every guard of the database are exercised.
 */
const { buildZip } = knowledgeArchiveTesting;
let env: TestEnv;
let dir: string;
let store: FsObjectStore;
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

const GLOBALS = `@tailwind base;
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --border: 214.3 31.8% 91.4%;
  --radius: 0.5rem;
  --font-sans: Cairo, sans-serif;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}
[data-theme='ocean'] { --primary: 199 89% 48%; }
body { background: hsl(var(--background)); color: hsl(var(--foreground)); direction: rtl; border-color: hsl(var(--border)); }
`;
const NEXT: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'shop',
    dependencies: { next: '^15', react: '^19', tailwindcss: '^3' },
  }),
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  'tailwind.config.ts': `import type { Config } from 'tailwindcss';
export default {
  darkMode: 'class',
  theme: { extend: { colors: { primary: 'hsl(var(--primary))', plugin: require('x') }, fontFamily: { sans: ['Cairo', 'sans-serif'] }, spacing: { 4: '1rem', 8: '2rem', 16: '4rem' } } },
  plugins: [],
} satisfies Config;
`,
  'src/app/globals.css': GLOBALS,
  'src/app/layout.tsx':
    'export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }',
  'src/app/login/page.tsx': 'export default function Login() { return <form />; }',
  'src/components/sidebar.tsx': 'export function Sidebar() { return <nav />; }',
  'src/components/header.tsx': 'export function Header() { return <header />; }',
};
const FLUTTER: Record<string, string> = {
  'pubspec.yaml':
    'name: gym\nenvironment:\n  sdk: ">=3.3.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n',
  'lib/main.dart':
    'void main() { runApp(const App()); }\nclass App extends StatelessWidget { const App({super.key}); Widget build(BuildContext c) => MaterialApp(theme: lightTheme); }',
  'lib/theme/app_theme.dart': `class AppColors {
  static const Color primary = Color(0xFF1E88E5);
  static const background = Color(0xFFFAFAFA);
}
final lightTheme = ThemeData(useMaterial3: true, fontFamily: 'Cairo', colorScheme: ColorScheme.light(primary: AppColors.primary));
final darkTheme = ThemeData.dark().copyWith(colorScheme: ColorScheme.dark(primary: Color(0xFF90CAF9)));
`,
  'lib/screens/home_screen.dart':
    'class HomeScreen extends StatelessWidget { const HomeScreen({super.key}); Widget build(BuildContext c) => Text("x"); }',
};

beforeAll(async () => {
  env = await createEnv();
  dir = mkdtempSync(join(tmpdir(), 'nuzm-design-'));
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
    design: true,
    parser: shared,
    ...opts,
  });
const Scripted = scriptedSandbox(() => shared);
const DESIGN_KINDS = new Set(['css', 'tokens-json', 'theme-config', 'dart-theme']);

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
  else
    await env.sql(
      `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, visibility, source_kind, status, data_region) VALUES ($1,NULL,$2,$2,'THEME','WEB','PLATFORM_PRIVATE','upload','QUARANTINED','sa-central')`,
      [rid, `r-${rid.slice(-8)}`],
    );
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
const tokens = async (vid: string) =>
  env.sql(
    `SELECT category, name, value, source_path, mode, line, origin, dynamic, resolved_value FROM knowledge.theme_tokens WHERE version_id = $1 ORDER BY source_path, mode, name`,
    [vid],
  );
const variants = async (vid: string) =>
  (
    await env.sql(
      `SELECT kind, name, descriptor FROM knowledge.theme_variants WHERE version_id = $1 ORDER BY kind, name`,
      [vid],
    )
  ).map((v) => `${v.kind}:${v.name}`);
const manifest = async (vid: string, schema: string) =>
  (
    await env.sql(
      `SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1 AND schema_version = $2`,
      [vid, schema],
    )
  )[0]?.manifest as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
const dnaOf = async (vid: string) =>
  (
    await env.sql(
      `SELECT result FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'design-dna'`,
      [vid],
    )
  )[0]?.result as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
const designRows = async (vid: string) =>
  Number(
    (
      await env.sql(
        `SELECT count(*)::int n FROM knowledge.analysis_results WHERE version_id = $1 AND analyzer = 'design-file'`,
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
const fail = (reason: 'timeout' | 'memory' | 'crashed'): ParseOutcome<never> => ({
  ok: false,
  reason,
  ms: 1,
});

describe('the DESIGN stage', () => {
  it('Next.js + Tailwind: tokens by mode with references resolved, roles with evidence and contrast, variants, schema-3 manifest; only then review', async () => {
    const s = await submit(zipOf(NEXT));
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(await jobs(s.vid)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
      'DETECT:SUCCEEDED',
      'COMPONENTS:SUCCEEDED',
      'DESIGN:SUCCEEDED',
    ]);
    const t = await tokens(s.vid);
    const get = (name: string, mode: string, path = 'src/app/globals.css') =>
      t.find((x) => x.name === name && x.mode === mode && x.source_path === path);
    expect(get('--primary', 'base')).toMatchObject({
      category: 'color',
      value: '221.2 83.2% 53.3%',
      origin: 'css-var',
      line: 5,
      dynamic: false,
    });
    expect(get('--background', 'dark')!.value).toBe('222.2 84% 4.9%');
    expect(get('--primary', 'theme-ocean')).toBeTruthy();
    expect(get('colors.primary', 'base', 'tailwind.config.ts')).toMatchObject({
      origin: 'tailwind-config',
      value: 'hsl(var(--primary))',
      resolved_value: 'hsl(221.2 83.2% 53.3%)',
    });
    // a plugin's computed colour is a dynamic entry with NO value
    expect(get('colors.plugin', 'base', 'tailwind.config.ts')).toMatchObject({
      dynamic: true,
      value: null,
      resolved_value: null,
    });
    expect(await variants(s.vid)).toEqual(
      expect.arrayContaining([
        'color-scheme:dark',
        'color-scheme:theme-ocean',
        'layout:RootLayout',
        'sidebar:Sidebar',
        'header:Header',
        'page-template:Login',
      ]),
    );
    const dna = await dnaOf(s.vid);
    const p = dna!.projects[0];
    expect(p.modes).toEqual(['base', 'dark', 'theme-ocean']);
    const base = p.palette.find((x: { mode: string }) => x.mode === 'base');
    const role = (n: string) => base.roles.find((r: { role: string }) => r.role === n);
    expect(role('background')).toMatchObject({
      token: '--background',
      hex: '#ffffff',
      via: 'name+usage',
    });
    expect(role('primary').evidence).toEqual({ path: 'src/app/globals.css', line: 5 });
    expect(
      p.contrast.find(
        (c: { mode: string; pair: string }) => c.mode === 'base' && c.pair === 'text/background',
      ).ratio,
    ).toBeGreaterThan(15);
    expect(p.traits).toMatchObject({ darkMode: true, rtl: true, arabicFont: true, tailwind: true });
    expect(p.dynamic).toEqual([{ name: 'colors.plugin', path: 'tailwind.config.ts', line: 4 }]);
    // schema 1, 2 and 3 side by side (append-only); 3 carries the summary
    expect(
      (
        await env.sql(
          `SELECT schema_version FROM knowledge.resource_manifests WHERE version_id = $1 ORDER BY schema_version`,
          [s.vid],
        )
      ).map((r) => r.schema_version),
    ).toEqual(['1', '2', '3']);
    expect((await manifest(s.vid, '3'))!.design).toMatchObject({
      darkMode: true,
      multiTheme: true,
      rtl: true,
    });
    expect((await manifest(s.vid, '3'))!.components).toBeDefined(); // the schema-2 content is kept
    expect((await state(s.vid)).ingest_summary).toMatchObject({
      design: { tokens: t.length, projects: 1 },
    });
    expect(await logCodes(s.vid)).toEqual(
      expect.arrayContaining(['info:design.begin', 'info:design.done']),
    );
  });

  it('Flutter: colours, schemes and fonts from theme code with the brightness they belong to', async () => {
    const s = await submit(zipOf(FLUTTER));
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const t = await tokens(s.vid);
    expect(t.find((x) => x.name === 'AppColors.primary')).toMatchObject({
      value: '#1e88e5',
      origin: 'flutter-theme',
      category: 'color',
    });
    expect(t.some((x) => x.mode === 'dark' && x.value === '#90caf9')).toBe(true);
    expect(t.find((x) => x.name === 'fontFamily')!.value).toBe('Cairo');
    expect(await variants(s.vid)).toContain('screen:HomeScreen');
    const dna = await dnaOf(s.vid);
    expect(dna!.projects[0].traits).toMatchObject({ material3: true, arabicFont: true });
  });

  it('flags: without DESIGN the flow ends after COMPONENTS; DESIGN without COMPONENTS is not claimed', async () => {
    const a = await submit(zipOf(NEXT));
    await service({ design: false }).drain();
    expect(await jobs(a.vid)).not.toContain('DESIGN:SUCCEEDED');
    expect(await state(a.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(await tokens(a.vid)).toEqual([]);
    expect(await manifest(a.vid, '3')).toBeUndefined();
    const b = await submit(zipOf(NEXT));
    await service({ components: false }).drain();
    expect(await jobs(b.vid)).not.toContain('DESIGN:QUEUED');
    expect(await state(b.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
  });

  it('quarantined and rejected packages never reach DESIGN', async () => {
    const secret = await submit(
      zipOf({ ...NEXT, 'src/leak.ts': `export const k = "${'AKIA' + 'QWERTYUIOPASDFGH'}";` }),
    );
    const traversal = await submit(buildZip([{ name: '../evil', data: Buffer.from('x') }]));
    await service().drain();
    for (const x of [secret, traversal]) {
      expect((await jobs(x.vid)).join()).not.toMatch(/DESIGN/);
      expect(await tokens(x.vid)).toEqual([]);
      expect(await dnaOf(x.vid)).toBeUndefined();
    }
  });

  it('incremental: a new version of the same resource re-parses only the changed file; an identical version parses none', async () => {
    const one = await submit(zipOf(NEXT));
    await service().drain();
    const total = await designRows(one.vid);
    expect(total).toBe(2); // globals.css and tailwind.config.ts
    const two = await submit(
      zipOf({ ...NEXT, 'src/app/globals.css': GLOBALS.replace('0.5rem', '0.75rem') }),
      one.rid,
    );
    await service().drain();
    expect(await state(two.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(await designRows(two.vid)).toBe(1);
    expect((await state(two.vid)).ingest_summary).toMatchObject({ design: { filesReused: 1 } });
    expect((await tokens(two.vid)).find((x) => x.name === '--radius')!.value).toBe('0.75rem');
    const three = await submit(
      zipOf({ ...NEXT, 'src/app/globals.css': GLOBALS.replace('0.5rem', '0.75rem') }),
      one.rid,
    );
    await service().drain();
    expect(await designRows(three.vid)).toBe(0);
    expect(JSON.stringify(await tokens(three.vid))).toBe(JSON.stringify(await tokens(two.vid)));
    expect(JSON.stringify(await dnaOf(three.vid))).toBe(JSON.stringify(await dnaOf(two.vid)));
  });

  it('never executes anything: a configuration that would leave a marker is only parsed', async () => {
    const marker = join(dir, 'design-executed.marker');
    const s = await submit(
      zipOf({
        ...NEXT,
        'tailwind.config.ts': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
export default { theme: { extend: { colors: { a: (() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); return '#fff'; })() } } } };`,
        'src/theme/tokens.js': `process.exit(7); module.exports = { colors: { brand: '#ff0066' } };`,
      }),
    );
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(existsSync(marker)).toBe(false);
    const t = await tokens(s.vid);
    expect(t.find((x) => x.name === 'colors.a')).toMatchObject({ dynamic: true, value: null });
  });

  it('hostile design inputs inside the package: minified CSS, NUL bytes, deep JSON and CSS, thousands of custom properties, odd names', async () => {
    const s = await submit(
      zipOf({
        ...NEXT,
        'src/min.css': `a{${'x:1;'.repeat(2000)}}`,
        'src/nulbyte.css': ':root{--x:#fff}\u0000',
        'src/deep.scss': 'a{\n'.repeat(20_000) + '}\n'.repeat(20_000),
        'src/many.css': `:root{${Array.from({ length: 4000 }, (_, i) => `--v${i}:${i}px;`).join('\n')}}`,
        'src/odd.css': ':root{--__proto__:#111;--constructor:#222;--a b:#333}',
        'design/tokens.json': '{"a":'.repeat(1500) + '"#fff"' + '}'.repeat(1500),
        'design/theme.json': '{ not json',
      }),
    );
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const dna = await dnaOf(s.vid);
    expect(dna!.stats.skipped).toMatchObject({ minified: 1, parse_error: expect.any(Number) });
    const t = await tokens(s.vid);
    expect(t.filter((x) => x.source_path === 'src/many.css')).toHaveLength(800);
    expect(t.map((x) => x.name)).toEqual(expect.arrayContaining(['--__proto__', '--constructor']));
    expect(t.every((x) => x.value === null || String(x.value).length <= 400)).toBe(true);
  });

  it('a file stopped at the parser limits is skipped and reported, never cached, never guessed', async () => {
    const s = await submit(zipOf(NEXT));
    const sb = new Scripted((p) => (p.endsWith('globals.css') ? fail('timeout') : null));
    await service({ parser: sb }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect((await dnaOf(s.vid))!.stats.skipped).toMatchObject({ timeout: 1 });
    expect((await tokens(s.vid)).some((x) => x.source_path === 'src/app/globals.css')).toBe(false);
    expect(await logCodes(s.vid)).toContain('warn:design.parser_limits');
    expect(await designRows(s.vid)).toBe(1); // only tailwind.config.ts was cached
    // the next version re-parses the file that hit a limit, and now it succeeds
    const again = await submit(zipOf(NEXT), s.rid);
    await service().drain();
    expect(await designRows(again.vid)).toBe(1);
    expect((await tokens(again.vid)).some((x) => x.source_path === 'src/app/globals.css')).toBe(
      true,
    );
  });

  it('a sandbox that cannot start retries the job and writes nothing; cancellation terminates the parse in flight and writes nothing', async () => {
    const a = await submit(zipOf(NEXT));
    await service({
      parser: new Scripted((_p, kind) => (DESIGN_KINDS.has(kind) ? 'unavailable' : null)),
    }).drain();
    expect(await jobs(a.vid)).toContain('DESIGN:QUEUED');
    expect(await state(a.vid)).toMatchObject({ state: 'ANALYZING' });
    expect(await tokens(a.vid)).toEqual([]);
    expect(await manifest(a.vid, '3')).toBeUndefined();
    expect(await logCodes(a.vid)).toContain('warn:job.retry');
    await env.sql(
      `UPDATE knowledge.processing_jobs SET run_after = now() WHERE version_id = $1 AND kind = 'DESIGN'`,
      [a.vid],
    );
    await service().drain();
    expect(await state(a.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });

    const b = await submit(zipOf(NEXT));
    for (let i = 0; i < 4; i++) await service().runOnce(); // VALIDATE .. COMPONENTS
    const sb = new Scripted((_p, kind) => (DESIGN_KINDS.has(kind) ? 'hang' : null));
    const running = service({ parser: sb }).runOnce();
    setTimeout(
      () =>
        void env.sql(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE version_id = $1 AND kind = 'DESIGN'`,
          [b.vid],
        ),
      300,
    );
    await running;
    expect(sb.aborted).toBe(true);
    expect(await jobs(b.vid)).toContain('DESIGN:CANCELLED');
    expect(await state(b.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await tokens(b.vid)).toEqual([]);
    expect(await variants(b.vid)).toEqual([]);
    expect(await manifest(b.vid, '3')).toBeUndefined();
    expect(await dnaOf(b.vid)).toBeUndefined();
    expect(await designRows(b.vid)).toBe(0);
  });

  it('with no sandbox injected the stage creates its own threads and closes them', async () => {
    const close = vi.spyOn(ThreadParserSandbox.prototype, 'close');
    try {
      const s = await submit(zipOf(NEXT));
      await service({
        parser: undefined,
        sandbox: { threads: 1, startupTimeoutMs: 60_000 },
      }).drain();
      expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
      expect((await tokens(s.vid)).length).toBeGreaterThan(10);
      expect(close).toHaveBeenCalledTimes(2); // COMPONENTS and DESIGN each own one
    } finally {
      close.mockRestore();
    }
  });
});

describe('what the worker role may write for design', () => {
  it('tokens and variants only for a version being analysed, platform rows only, never changed or deleted, with natural keys', async () => {
    const s = await submit(zipOf(NEXT));
    await service({ design: false }).drain(); // AWAITING_REVIEW
    const w = (q: string, p: unknown[] = []) =>
      env.worker.withKnowledgeWorker((c) => c.query(q, p));
    const tok = (org: string | null = null, name = 'x') =>
      w(
        `INSERT INTO knowledge.theme_tokens (id, version_id, org_id, category, name, value, source_path, mode, line, origin, dynamic) VALUES ($1,$2,$3,'color',$4,'#fff','a.css','base',1,'css-var',false)`,
        [uuidv7(), s.vid, org, name],
      );
    const variant = () =>
      w(
        `INSERT INTO knowledge.theme_variants (id, version_id, org_id, kind, name, descriptor) VALUES ($1,$2,NULL,'layout','L','{}')`,
        [uuidv7(), s.vid],
      );
    await expect(tok()).rejects.toThrow(/being analysed/);
    await expect(variant()).rejects.toThrow(/being analysed/);
    for (const to of ['QUARANTINED', 'VALIDATING', 'ANALYZING'])
      await env.sql(`UPDATE knowledge.resource_versions SET state = $2 WHERE id = $1`, [s.vid, to]);
    await expect(tok('00000000-0000-7000-8000-00000000000a')).rejects.toThrow(/row-level security/);
    await tok();
    await variant();
    await expect(tok()).rejects.toThrow(/duplicate|unique/);
    await expect(variant()).rejects.toThrow(/duplicate|unique/);
    for (const q of [
      `UPDATE knowledge.theme_tokens SET value = '#000' WHERE version_id = $1`,
      `DELETE FROM knowledge.theme_tokens WHERE version_id = $1`,
      `UPDATE knowledge.theme_variants SET name = 'M' WHERE version_id = $1`,
      `DELETE FROM knowledge.theme_variants WHERE version_id = $1`,
    ])
      await expect(w(q, [s.vid])).rejects.toThrow(/permission denied/);
    // a value is required unless the token is dynamic; a mode and an origin are bounded
    await expect(
      w(
        `INSERT INTO knowledge.theme_tokens (id, version_id, org_id, category, name, value, source_path, mode, origin, dynamic) VALUES ($1,$2,NULL,'color','n',NULL,'a.css','base','css-var',false)`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/value_required|check/);
    await expect(
      w(
        `INSERT INTO knowledge.theme_tokens (id, version_id, org_id, category, name, value, source_path, mode, origin, dynamic) VALUES ($1,$2,NULL,'color','n','#fff','a.css','base','made-up',false)`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/origin|check/);
  });
});
