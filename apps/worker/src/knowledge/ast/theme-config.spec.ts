import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyzeThemeConfig } from './theme-config';

const tok = (f: ReturnType<typeof analyzeThemeConfig>, name: string) =>
  f.tokens.find((t) => t.name === name);

const TAILWIND = `
import type { Config } from 'tailwindcss';
import colors from 'tailwindcss/colors';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#3b82f6', 500: '#3b82f6' },
        brand: 'hsl(var(--brand))',
        danger: colors.red[500],
        ...extraColors,
      },
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      fontSize: { sm: ['0.875rem', { lineHeight: '1.25rem' }] },
      spacing: { 18: '4.5rem', '-2': -8 },
      borderRadius: { lg: '0.5rem' },
      screens: { tablet: '640px' },
      keyframes: { spin: { to: { transform: 'rotate(360deg)' } } },
    },
  },
  plugins: [require('@tailwindcss/forms')],
} satisfies Config;
`;

describe('theme configuration reader', () => {
  it('reads a Tailwind configuration as a syntax tree: literals become tokens, computed values become dynamic entries', () => {
    const f = analyzeThemeConfig(TAILWIND, 'tailwind.config.ts');
    expect(tok(f, 'colors.primary.DEFAULT')).toMatchObject({
      value: '#3b82f6',
      category: 'color',
      origin: 'tailwind-config',
      mode: 'base',
    });
    expect(tok(f, 'colors.primary.500')!.value).toBe('#3b82f6');
    expect(tok(f, 'colors.brand')!.value).toBe('hsl(var(--brand))');
    expect(tok(f, 'colors.danger')).toMatchObject({ dynamic: true, value: '' });
    expect(tok(f, 'colors.$spread')).toMatchObject({ dynamic: true });
    expect(tok(f, 'fontFamily.sans')).toMatchObject({
      value: 'Inter, sans-serif',
      category: 'typography',
    });
    expect(tok(f, 'fontSize.sm')!.value).toBe('0.875rem');
    expect(tok(f, 'fontSize.sm-line.lineHeight')!.value).toBe('1.25rem');
    expect(tok(f, 'spacing.18')).toMatchObject({ value: '4.5rem', category: 'spacing' });
    expect(tok(f, 'spacing.-2')!.value).toBe('-8');
    expect(tok(f, 'borderRadius.lg')!.category).toBe('radius');
    expect(tok(f, 'screens.tablet')!.category).toBe('breakpoint');
    // not tokens: content, plugins, keyframes
    expect(f.tokens.some((t) => /content|plugins|keyframes|transform/.test(t.name))).toBe(false);
    expect(f.traits.tailwind).toBe(true);
    expect(tok(f, 'colors.primary.500')!.line).toBe(10);
  });
  it('reads Material UI, Chakra and plain exported token objects, with dark variants by name', () => {
    const f = analyzeThemeConfig(
      `const lightTheme = createTheme({ palette: { primary: { main: '#1976d2' } }, typography: { fontFamily: '"Roboto", sans-serif' }, spacing: 8, shape: { borderRadius: 4 } });
const darkTheme = createTheme({ palette: { primary: { main: '#90caf9' } } });
export const colors = { brand: '#ff0066', nested: { a: '#000' } } as const;
const unrelated = { primary: '#123456' };`,
      'src/theme/index.ts',
    );
    expect(
      f.tokens.find((t) => t.name === 'palette.primary.main' && t.mode === 'base')!.value,
    ).toBe('#1976d2');
    expect(
      f.tokens.find((t) => t.name === 'palette.primary.main' && t.mode === 'dark')!.value,
    ).toBe('#90caf9');
    expect(tok(f, 'typography.fontFamily')!.value).toBe('"Roboto", sans-serif');
    expect(tok(f, 'spacing')).toMatchObject({ value: '8', category: 'spacing' });
    expect(tok(f, 'shape.borderRadius')!.category).toBe('radius');
    expect(tok(f, 'colors.brand')!.value).toBe('#ff0066');
    expect(tok(f, 'colors.brand')!.origin).toBe('js-theme');
    expect(tok(f, 'colors.nested.a')!.value).toBe('#000');
    expect(f.tokens.some((t) => t.value === '#123456')).toBe(false); // an object that is not a theme
  });
  it('never executes the file: code that would leave a marker only produces dynamic entries', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__nuzm_theme_marker;
    const f = analyzeThemeConfig(
      `globalThis.__nuzm_theme_marker = 'ran'; process.exit(3); require('child_process').execSync('echo x');
export const theme = { colors: { a: (() => { globalThis.__nuzm_theme_marker = 'ran2'; return '#fff'; })(), b: require('x'), c: \`#\${hex}\`, d() { return 1; } } };`,
      'theme.ts',
    );
    expect(g.__nuzm_theme_marker).toBeUndefined();
    expect(f.tokens.filter((t) => t.dynamic).map((t) => t.name)).toEqual([
      'colors.a',
      'colors.b',
      'colors.c',
      'colors.d',
    ]);
    expect(f.tokens.every((t) => t.dynamic)).toBe(true);
  });
  it('ignores what only looks like a theme: strings, comments, props, other objects', () => {
    const f = analyzeThemeConfig(
      `// const theme = { colors: { a: '#fff' } }
const s = "export const theme = { colors: { a: '#fff' } }";
const x = { theme: 'dark', colors: 'x' };
function A() { return <Comp theme="dark" />; }
const other = { colors: { a: '#abc' } };`,
      'a.tsx',
    );
    expect(f.tokens).toEqual([]);
  });
  it('is bounded and survives hostile input', () => {
    expect(
      analyzeThemeConfig(`export const theme = {${'a'.repeat(6000)}}`, 'theme.ts').skipped,
    ).toBe('minified');
    expect(analyzeThemeConfig('export const theme = {}\u0000', 'theme.ts').skipped).toBe(
      'parse_error',
    );
    const deep = analyzeThemeConfig(
      `export const theme = ${'{ a:\n'.repeat(3000)}'#fff'${' }\n'.repeat(3000)};`,
      'theme.ts',
    );
    expect(deep.tokens.length).toBe(0);
    // the parser may refuse a file nested that deep (stack), or the reader stops at its depth limit: either way nothing is invented
    expect(deep.truncated || deep.skipped === 'parse_error').toBe(true);
    const many = analyzeThemeConfig(
      `export const colors = {\n${Array.from({ length: 5000 }, (_, i) => `  c${i}: '#${(i % 4096).toString(16).padStart(3, '0')}',`).join('\n')}\n};`,
      'colors.ts',
    );
    expect(many.tokens.length).toBe(600);
    expect(many.truncated).toBe(true);
    expect(analyzeThemeConfig(TAILWIND, 'tailwind.config.ts', { maxNodes: 5 }).skipped).toBe(
      'budget',
    );
    for (const src of [
      'export const theme = {',
      'theme: {{{',
      "export const colors = { ['a'+'b']: '#fff', [1]: '#000', __proto__: '#111' }",
      'export default',
      '`',
      '/*',
    ])
      expect(() => analyzeThemeConfig(src, 'theme.ts')).not.toThrow();
    const p = analyzeThemeConfig(
      "export const colors = { ['__proto__']: '#111', constructor: '#222' }",
      'colors.ts',
    );
    expect(p.tokens.map((t) => t.name).sort()).toEqual(['colors.__proto__', 'colors.constructor']);
    expect(({} as Record<string, unknown>)['111']).toBeUndefined();
  });
  it('is deterministic and never throws (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        const a = analyzeThemeConfig(`export const theme = { ${s} };`, 'theme.ts');
        const b = analyzeThemeConfig(`export const theme = { ${s} };`, 'theme.ts');
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const t of a.tokens) expect(t.value.length).toBeLessThanOrEqual(400);
      }),
      { numRuns: 200 },
    );
  });
});
