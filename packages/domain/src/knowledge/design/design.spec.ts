import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contrast, parseColor, toHex } from './color';
import { analyzeCss } from './css';
import { analyzeFlutterTheme } from './flutter';
import { analyzeTokensJson } from './tokens-json';
import { assembleDesign, colorOf, fitDna, roleKey, type DesignAssembleFile } from './assemble';
import { categoryOf, emptyDesignFacts, type DesignFileFacts } from './types';

const tok = (f: DesignFileFacts, name: string, mode?: string) =>
  f.tokens.find((t) => t.name === name && (mode === undefined || t.mode === mode));

describe('colours', () => {
  it('parses the notations themes use', () => {
    expect(toHex(parseColor('#1E88E5')!)).toBe('#1e88e5');
    expect(toHex(parseColor('#fff')!)).toBe('#ffffff');
    expect(toHex(parseColor('rgb(30 136 229)')!)).toBe('#1e88e5');
    expect(toHex(parseColor('rgba(30, 136, 229, .5)')!)).toBe('#1e88e580');
    expect(toHex(parseColor('rgb(30 136 229 / 50%)')!)).toBe('#1e88e580');
    expect(toHex(parseColor('hsl(210 100% 50%)')!)).toBe('#0080ff');
    expect(toHex(parseColor('hsl(0, 0%, 100%)')!)).toBe('#ffffff');
    expect(toHex(parseColor('oklch(1 0 0)')!)).toBe('#ffffff');
    expect(toHex(parseColor('oklch(0 0 0)')!)).toBe('#000000');
    expect(toHex(parseColor('white')!)).toBe('#ffffff');
  });
  it('refuses what it cannot evaluate instead of guessing', () => {
    for (const v of [
      'var(--x)',
      'currentColor',
      'color-mix(in srgb, red, blue)',
      'rgb(from red r g b)',
      'calc(1)',
      'hsl(var(--a) 50% 50%)',
      'rgb(1 2)',
      'nonsense',
      '',
      '#12',
      '#12345',
    ])
      expect(parseColor(v)).toBeNull();
    expect(colorOf('222 47% 11%')).not.toBeNull(); // shadcn channels
    expect(colorOf(null)).toBeNull();
  });
  it('computes the WCAG ratio and leaves transparent colours undecided', () => {
    expect(contrast(parseColor('#000')!, parseColor('#fff')!)).toBe(21);
    expect(contrast(parseColor('#fff')!, parseColor('#fff')!)).toBe(1);
    expect(contrast(parseColor('#767676')!, parseColor('#fff')!)).toBe(4.54);
    expect(contrast(parseColor('rgba(0,0,0,.5)')!, parseColor('#fff')!)).toBeNull();
  });
  it('never throws and always returns null or a bounded colour (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const c = parseColor(s);
        if (c) {
          expect(c.r).toBeGreaterThanOrEqual(0);
          expect(c.r).toBeLessThanOrEqual(255);
          expect(c.a).toBeGreaterThanOrEqual(0);
          expect(c.a).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('categories', () => {
  it('uses the name first and the value when the name says nothing', () => {
    expect(categoryOf('color-primary', '#fff')).toBe('color');
    expect(categoryOf('font-sans', 'Inter, sans-serif')).toBe('typography');
    expect(categoryOf('text-xs', '12px')).toBe('typography');
    expect(categoryOf('text-primary', '#111')).toBe('color');
    expect(categoryOf('radius-lg', '8px')).toBe('radius');
    expect(categoryOf('shadow-md', '0 1px 2px #0003')).toBe('shadow');
    expect(categoryOf('breakpoint-md', '768px')).toBe('breakpoint');
    expect(categoryOf('ease-in', 'cubic-bezier(0,0,1,1)')).toBe('motion');
    expect(categoryOf('gap-4', '1rem')).toBe('spacing');
    expect(categoryOf('x', '#abc')).toBe('color');
    expect(categoryOf('x', 'whatever')).toBe('other');
  });
});

describe('CSS reader', () => {
  const SHADCN = `
@tailwind base;
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
  --radius: 0.5rem;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}
body { background: hsl(var(--background)); color: hsl(var(--foreground)); border-color: var(--border); }
`;
  it('reads custom properties with the mode they apply to, and how they are used', () => {
    const f = analyzeCss(SHADCN, 'src/globals.css');
    expect(tok(f, '--background', 'base')).toMatchObject({
      value: '0 0% 100%',
      category: 'color',
      origin: 'css-var',
      line: 4,
    });
    expect(tok(f, '--background', 'dark')).toMatchObject({ value: '222.2 84% 4.9%' });
    expect(tok(f, '--radius', 'base')).toMatchObject({ category: 'radius', value: '0.5rem' });
    expect(f.schemes).toEqual([{ name: 'dark', selector: '.dark', line: 11, mode: 'dark' }]);
    expect(f.traits.tailwind).toBe(true);
    expect(f.usage.find((u) => u.name === '--background')).toMatchObject({ bg: 1 });
    expect(f.usage.find((u) => u.name === '--foreground')).toMatchObject({ fg: 1 });
    expect(f.usage.find((u) => u.name === '--border')).toMatchObject({ border: 1 });
  });
  it('knows media-query dark mode, named schemes, component-scoped properties and Tailwind v4 @theme', () => {
    const f = analyzeCss(
      `:root { --c: #111; }
@media (prefers-color-scheme: dark) { :root { --c: #eee; } }
[data-theme='ocean'] { --c: #08f; }
html[data-theme="dark"] { --d: #000; }
.dark .card { --card-bg: #222; }
.btn { --btn-bg: red; }
@theme { --color-brand-500: oklch(0.62 0.19 259); --font-sans: Inter, sans-serif; --spacing: 0.25rem; --breakpoint-md: 48rem; }`,
      'a.css',
    );
    expect(tok(f, '--c', 'base')!.value).toBe('#111');
    expect(tok(f, '--c', 'dark')!.value).toBe('#eee');
    expect(tok(f, '--c', 'theme-ocean')).toBeTruthy();
    expect(tok(f, '--d', 'dark')).toBeTruthy();
    expect(tok(f, '--card-bg', 'scoped')).toBeTruthy(); // `.dark .card` styles a component, not the root
    expect(tok(f, '--btn-bg', 'scoped')).toBeTruthy();
    expect(tok(f, '--color-brand-500')).toMatchObject({
      origin: 'tailwind-theme',
      mode: 'base',
      category: 'color',
    });
    expect(tok(f, '--font-sans')!.category).toBe('typography');
    expect(tok(f, '--spacing')!.category).toBe('spacing');
    expect(tok(f, '--breakpoint-md')!.category).toBe('breakpoint');
    expect(f.traits.darkMedia).toBe(true);
    expect(f.schemes.map((s) => s.name).sort()).toEqual(['dark', 'theme-ocean']);
  });
  it('reads SCSS and Less variables without compiling anything, and notes RTL support', () => {
    const s = analyzeCss(
      `// comment $nope: 1;
$primary: #3498db !default;
$font-stack: "Helvetica Neue", Arial; /* $also-not: 2 */
@import 'other';
.a { margin-inline-start: 4px; direction: rtl; width: #{$x}; }`,
      'a.scss',
    );
    expect(tok(s, '$primary')).toMatchObject({
      value: '#3498db',
      origin: 'scss-var',
      category: 'color',
    });
    expect(tok(s, '$font-stack')!.category).toBe('typography');
    expect(tok(s, '$nope')).toBeUndefined();
    expect(tok(s, '$also-not')).toBeUndefined();
    expect(s.traits).toMatchObject({ rtl: true, logicalProps: true });
    const l = analyzeCss('@brand: #ff0000;\n.a { color: @brand; }', 'a.less');
    expect(tok(l, '@brand')).toMatchObject({ value: '#ff0000', origin: 'less-var' });
  });
  it('ignores colours in comments, strings, urls and selectors that only look like tokens', () => {
    const f = analyzeCss(
      `/* --ghost: #f00; */
.a { content: "--fake: #00f;"; background: url(data:image/png;base64,AAAA) }
.b::after { content: '}' ; --real: #123; }`,
      'a.css',
    );
    expect(f.tokens.map((t) => t.name)).toEqual(['--real']);
  });
  it('is bounded and survives hostile input', () => {
    expect(analyzeCss(`a{${'x'.repeat(6000)}}`, 'a.css').skipped).toBe('minified');
    expect(analyzeCss('a{--x:1}\u0000', 'a.css').skipped).toBe('parse_error');
    const many = analyzeCss(
      `:root{${Array.from({ length: 5000 }, (_, i) => `--v${i}:${i}px;`).join('\n')}}`,
      'a.css',
    );
    expect(many.tokens.length).toBe(800);
    expect(many.truncated).toBe(true);
    const deep = analyzeCss('a{\n'.repeat(50_000) + '--x:1;' + '}\n'.repeat(50_000), 'a.css');
    expect(deep.truncated).toBe(true);
    for (const css of [
      '{',
      '}',
      ';;;',
      '--x',
      ':root{--__proto__: #fff; --constructor: 1}',
      'a{b:"',
      '@media',
      '@theme{',
      `a{--x:${'('.repeat(10_000)}`,
    ])
      expect(() => analyzeCss(css, 'a.css')).not.toThrow();
    const p = analyzeCss(':root{--__proto__: #fff; --constructor: #000}', 'a.css');
    expect(p.tokens.map((t) => t.name).sort()).toEqual(['--__proto__', '--constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('is deterministic and never throws (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (s) => {
        const a = analyzeCss(s, 'a.scss');
        const b = analyzeCss(s, 'a.scss');
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const t of a.tokens) expect(t.value.length).toBeLessThanOrEqual(400);
      }),
      { numRuns: 300 },
    );
  });
});

describe('design-token JSON reader', () => {
  it('reads W3C design tokens, Style Dictionary, aliases and dark variants', () => {
    const w3c = analyzeTokensJson(
      JSON.stringify({
        color: {
          $type: 'color',
          brand: { primary: { $value: '#0055ff', $description: 'x' } },
          dark: { surface: { $value: '#101010' } },
          link: { $value: '{color.brand.primary}' },
        },
        space: { 4: { $value: '16px', $type: 'dimension' } },
      }),
      'tokens.json',
    );
    expect(tok(w3c, 'color.brand.primary')).toMatchObject({
      value: '#0055ff',
      category: 'color',
      mode: 'base',
    });
    expect(tok(w3c, 'color.dark.surface')!.mode).toBe('dark');
    expect(tok(w3c, 'color.link')!.value).toBe('{color.brand.primary}');
    expect(tok(w3c, 'space.4')).toMatchObject({ category: 'spacing', value: '16px' });
    const sd = analyzeTokensJson(
      JSON.stringify({ size: { font: { base: { value: '16px', type: 'fontSizes' } } } }),
      'tokens.json',
    );
    expect(tok(sd, 'size.font.base')!.value).toBe('16px');
  });
  it('reads theme.json presets by slug', () => {
    const f = analyzeTokensJson(
      JSON.stringify({
        settings: {
          color: {
            palette: [
              { slug: 'primary', color: '#0073aa', name: 'Primary' },
              { slug: 'base', color: '#fff' },
            ],
          },
          typography: {
            fontSizes: [{ slug: 'small', size: '13px' }],
            fontFamilies: [{ slug: 'body', fontFamily: 'Cairo, sans-serif' }],
          },
        },
      }),
      'theme.json',
    );
    expect(tok(f, 'settings.color.palette.primary')).toMatchObject({
      value: '#0073aa',
      category: 'color',
    });
    expect(tok(f, 'settings.typography.fontFamilies.body')!.value).toBe('Cairo, sans-serif');
    expect(f.tokens.length).toBe(4);
  });
  it('is bounded and never executes or pollutes: invalid JSON, depth bombs, __proto__ keys, huge arrays', () => {
    expect(analyzeTokensJson('{not json', 'a.json').skipped).toBe('parse_error');
    expect(analyzeTokensJson('"x"', 'a.json').skipped).toBe('parse_error');
    expect(analyzeTokensJson('a\u0000', 'a.json').skipped).toBe('parse_error');
    const deep = analyzeTokensJson('{"a":'.repeat(500) + '"#fff"' + '}'.repeat(500), 'a.json');
    expect(deep.tokens.length).toBe(0);
    expect(deep.truncated).toBe(true);
    const big = analyzeTokensJson(
      JSON.stringify({
        c: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, '#fff'])),
      }),
      'a.json',
    );
    expect(big.tokens.length).toBe(600);
    expect(big.truncated).toBe(true);
    const proto = analyzeTokensJson(
      '{"__proto__":{"color":{"$value":"#abc"}},"constructor":{"x":"#def"}}',
      'a.json',
    );
    expect(proto.tokens.map((t) => t.name).sort()).toEqual(['__proto__.color', 'constructor.x']);
    expect(({} as Record<string, unknown>).color).toBeUndefined();
  });
});

describe('Flutter theme reader', () => {
  const SRC = `
import 'package:flutter/material.dart';
class AppColors {
  static const Color primary = Color(0xFF1E88E5);
  static const background = Color(0xFFFAFAFA); // light bg
  static const scrim = Color(0x80000000);
}
final lightTheme = ThemeData(
  useMaterial3: true,
  fontFamily: 'Cairo',
  colorScheme: ColorScheme.light(primary: AppColors.primary, secondary: Color(0xFF26A69A), surface: Colors.white),
  textTheme: TextTheme(bodyLarge: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, height: 1.5)),
  cardTheme: CardTheme(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
);
final darkTheme = ThemeData.dark().copyWith(colorScheme: ColorScheme.dark(primary: Color(0xFF90CAF9)));
`;
  it('reads colours, schemes, fonts, text styles and radii with the brightness they belong to', () => {
    const f = analyzeFlutterTheme(SRC, 'lib/theme.dart');
    expect(tok(f, 'AppColors.primary')).toMatchObject({
      value: '#1e88e5',
      category: 'color',
      origin: 'flutter-theme',
    });
    expect(tok(f, 'AppColors.scrim')!.value).toBe('#000000' + '80');
    expect(tok(f, 'fontFamily')!.value).toBe('Cairo');
    expect(tok(f, 'useMaterial3')!.value).toBe('true');
    expect(tok(f, 'secondary')!.value).toBe('#26a69a');
    expect(tok(f, 'surface')!.value).toBe('Colors.white');
    expect(tok(f, 'bodyLarge.fontSize')!.value).toBe('16px');
    expect(tok(f, 'bodyLarge.fontWeight')!.value).toBe('w600');
    expect(tok(f, 'borderRadius.12')!.category).toBe('radius');
    expect(f.tokens.some((t) => t.mode === 'dark' && t.value === '#90caf9')).toBe(true);
  });
  it('ignores commented-out colours and is bounded', () => {
    expect(
      analyzeFlutterTheme('// static const x = Color(0xFF000000);\nvoid main(){}', 'a.dart').tokens,
    ).toEqual([]);
    expect(analyzeFlutterTheme('a'.repeat(6000), 'a.dart').skipped).toBe('minified');
    expect(analyzeFlutterTheme('Color(0xFF000000)\u0000', 'a.dart').skipped).toBe('parse_error');
    const many = analyzeFlutterTheme(
      Array.from(
        { length: 3000 },
        (_, i) => `static const c${i} = Color(0xFF${(i % 255).toString(16).padStart(2, '0')}0000);`,
      ).join('\n'),
      'a.dart',
    );
    expect(many.tokens.length).toBe(800);
  });
});

const file = (path: string, project: string, facts: DesignFileFacts): DesignAssembleFile => ({
  path,
  project,
  facts,
});
const PROJECT = {
  root: '.',
  name: 'shop',
  kind: 'application',
  frameworks: ['nextjs', 'tailwindcss'],
};

describe('Design DNA assembly', () => {
  const css = analyzeCss(
    `:root { --background: 0 0% 100%; --foreground: 222 47% 11%; --primary: 221 83% 53%; --primary-foreground: 210 40% 98%; --muted-foreground: 215 16% 47%; --border: 214 32% 91%; --radius: 0.5rem; --spacing: 4px; --font-sans: Cairo, sans-serif; }
.dark { --background: 222 47% 11%; --foreground: 210 40% 98%; }
body { background: hsl(var(--background)); color: hsl(var(--foreground)); direction: rtl; }`,
    'src/globals.css',
  );
  const cfg: DesignFileFacts = {
    ...emptyDesignFacts('theme-config'),
    tokens: [
      {
        category: 'color',
        name: 'colors.primary',
        value: 'hsl(var(--primary))',
        mode: 'base',
        line: 9,
        origin: 'tailwind-config',
        dynamic: false,
      },
      {
        category: 'color',
        name: 'colors.plugin',
        value: '',
        mode: 'base',
        line: 10,
        origin: 'tailwind-config',
        dynamic: true,
      },
    ],
  };
  const run = (extra: DesignAssembleFile[] = []) =>
    assembleDesign(
      [file('src/globals.css', '.', css), file('tailwind.config.ts', '.', cfg), ...extra],
      [],
      [PROJECT],
    );

  it('infers roles per mode with evidence, confidence and usage, resolves variables and computes contrast', () => {
    const { dna, tokens } = run();
    const p = dna.projects[0]!;
    expect(p.modes).toEqual(['base', 'dark']);
    const base = p.palette.find((x) => x.mode === 'base')!;
    const role = (name: string) => base.roles.find((r) => r.role === name)!;
    expect(role('background')).toMatchObject({
      token: '--background',
      hex: '#ffffff',
      via: 'name+usage',
    });
    expect(role('foreground')).toMatchObject({ token: '--foreground', via: 'name+usage' });
    expect(role('primary').evidence).toEqual({ path: 'src/globals.css', line: 1 });
    expect(role('primary').confidence).toBeGreaterThan(0.7);
    const dark = p.palette.find((x) => x.mode === 'dark')!;
    expect(dark.roles.find((r) => r.role === 'background')!.hex).toBe(
      toHex(parseColor('hsl(222 47% 11%)')!),
    );
    expect(dark.roles.find((r) => r.role === 'primary')).toBeTruthy(); // inherited from the base: the cascade
    const textBg = p.contrast.find((c) => c.mode === 'base' && c.pair === 'text/background')!;
    expect(textBg.ratio).toBeGreaterThan(15);
    expect(textBg).toMatchObject({ aa: true, aaa: true });
    // the Tailwind config value is a reference: resolved against the CSS variable in the same project
    const tw = tokens.find((t) => t.name === 'colors.primary')!;
    expect(tw.resolvedValue).toBe('hsl(221 83% 53%)');
    expect(p.traits).toMatchObject({
      darkMode: true,
      rtl: true,
      arabicFont: true,
      tailwind: true,
      cssVariables: true,
    });
    expect(p.spacing).toMatchObject({ baseUnit: 4, baseUnitInferred: false });
    expect(p.typography.families[0]!.value).toBe('Cairo, sans-serif');
    expect(p.radius[0]).toMatchObject({ name: '--radius', px: 8 });
  });
  it('reports computed values as dynamic and never invents a number for them', () => {
    const { dna, tokens } = run();
    const d = tokens.find((t) => t.name === 'colors.plugin')!;
    expect(d).toMatchObject({ dynamic: true, resolvedValue: null });
    expect(dna.projects[0]!.dynamic).toEqual([
      { name: 'colors.plugin', path: 'tailwind.config.ts', line: 10 },
    ]);
    expect(dna.projects[0]!.palette[0]!.colors.some((c) => c.name === 'colors.plugin')).toBe(false);
  });
  it('reports a reference it cannot resolve instead of guessing', () => {
    const f: DesignFileFacts = {
      ...emptyDesignFacts('css'),
      tokens: [
        {
          category: 'color',
          name: '--x',
          value: 'var(--nowhere)',
          mode: 'base',
          line: 1,
          origin: 'css-var',
          dynamic: false,
        },
      ],
    };
    const r = assembleDesign([file('a.css', '.', f)], [], [PROJECT]);
    expect(r.tokens[0]).toMatchObject({ resolvedValue: null });
    expect(r.dna.projects[0]!.stats.unresolved).toBe(1);
    expect(r.dna.projects[0]!.palette[0]!.colors).toEqual([]);
  });
  it('survives reference cycles', () => {
    const f: DesignFileFacts = {
      ...emptyDesignFacts('css'),
      tokens: [
        {
          category: 'color',
          name: '--a',
          value: 'var(--b)',
          mode: 'base',
          line: 1,
          origin: 'css-var',
          dynamic: false,
        },
        {
          category: 'color',
          name: '--b',
          value: 'var(--a)',
          mode: 'base',
          line: 2,
          origin: 'css-var',
          dynamic: false,
        },
      ],
    };
    const r = assembleDesign([file('a.css', '.', f)], [], [PROJECT]);
    expect(r.tokens.every((t) => t.resolvedValue === null)).toBe(true);
  });
  it('lists colour schemes and layouts as variants', () => {
    const named = analyzeCss(`[data-theme='ocean'] { --primary: #08f; }`, 'themes.css');
    const { variants } = assembleDesign(
      [file('src/globals.css', '.', css), file('themes.css', '.', named)],
      [
        {
          name: 'Sidebar',
          kind: 'react-component',
          framework: 'react',
          path: 'src/components/sidebar.tsx',
        },
        { name: 'RootLayout', kind: 'next-layout', framework: 'next', path: 'src/app/layout.tsx' },
        { name: 'LoginPage', kind: 'next-page', framework: 'next', path: 'src/app/login/page.tsx' },
        {
          name: 'HomeScreen',
          kind: 'flutter-widget',
          framework: 'flutter',
          path: 'lib/screens/home_screen.dart',
        },
        {
          name: 'UsersController',
          kind: 'nest-controller',
          framework: 'nestjs',
          path: 'src/users.controller.ts',
        },
      ],
      [PROJECT],
    );
    const names = variants.map((v) => `${v.kind}:${v.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'color-scheme:dark',
        'color-scheme:theme-ocean',
        'sidebar:Sidebar',
        'layout:RootLayout',
        'page-template:LoginPage',
        'screen:HomeScreen',
      ]),
    );
    expect(names.some((n) => n.includes('UsersController'))).toBe(false);
  });
  it('is deterministic whatever the input order, and bounded', () => {
    const a = run();
    const b = assembleDesign(
      [file('tailwind.config.ts', '.', cfg), file('src/globals.css', '.', css)],
      [],
      [PROJECT],
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const big: DesignFileFacts = {
      ...emptyDesignFacts('css'),
      tokens: Array.from({ length: 800 }, (_, i) => ({
        category: 'color' as const,
        name: `--c${i}`,
        value: `#${((i * 977) % 0xffffff).toString(16).padStart(6, '0')}`,
        mode: 'base',
        line: i + 1,
        origin: 'css-var' as const,
        dynamic: false,
      })),
    };
    const many = assembleDesign(
      Array.from({ length: 12 }, (_, i) => file(`f${i}.css`, '.', big)),
      [],
      [PROJECT],
    );
    expect(many.tokens.length).toBe(6000);
    expect(many.dna.stats.truncated).toContain('tokens');
    expect(JSON.stringify(fitDna(many.dna, 5000)).length).toBeLessThan(
      JSON.stringify(many.dna).length,
    );
  });
  it('keeps projects apart and skipped files out of the palette', () => {
    const flutter = analyzeFlutterTheme(
      'static const Color primary = Color(0xFF1E88E5);',
      'lib/theme.dart',
    );
    const r = assembleDesign(
      [
        file('web/a.css', 'web', css),
        file('app/lib/theme.dart', 'app', flutter),
        file('web/min.css', 'web', emptyDesignFacts('css', 'minified')),
      ],
      [],
      [
        { root: 'web', name: 'web', kind: 'application', frameworks: [] },
        { root: 'app', name: 'app', kind: 'application', frameworks: ['flutter'] },
      ],
    );
    expect(r.dna.projects.map((p) => p.root)).toEqual(['app', 'web']);
    expect(r.dna.primary).toBe(1); // the web project has the most colours
    expect(r.dna.stats.skipped).toEqual({ minified: 1 });
  });
  it('normalises token names to role keys', () => {
    expect(roleKey('--color-primary-500')).toBe('primary-500');
    expect(roleKey('palette.primary.main')).toBe('primary-main');
    expect(roleKey('colorScheme.onPrimary')).toBe('on-primary');
    expect(roleKey('--primary-foreground')).toBe('primary-foreground');
  });
});
