import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  lintPhysicalDirectionCss,
  renderSite,
  type RenderOptions,
  type RenderResult,
  type SiteModel,
} from '@nuzm/domain';

/** The part of Tailwind's compiler API used here (v4): `compile(source, …).build(classNames)` returns the CSS of exactly those utilities. */
interface TailwindCompiler {
  build(candidates: string[]): string;
}
interface TailwindModule {
  compile(
    source: string,
    opts: {
      base: string;
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; content: string }>;
    },
  ): Promise<TailwindCompiler>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the package's CommonJS entry; its types are ESM-only
const tailwind = require('tailwindcss') as TailwindModule;
const TW_DIR = path.dirname(require.resolve('tailwindcss/package.json'));

/** Only the stylesheets of the Tailwind package itself can be imported by a site's source: anything else is refused (a site model never names a file). */
async function loadStylesheet(id: string) {
  const m = /^tailwindcss(?:\/(theme|preflight|utilities)\.css)?$/.exec(id);
  if (!m) throw new Error(`stylesheet ${id.slice(0, 60)} is not available`);
  const file = path.join(TW_DIR, m[1] ? `${m[1]}.css` : 'index.css');
  return { path: file, base: TW_DIR, content: await readFile(file, 'utf8') };
}

const cache = new Map<string, string>();
const CACHE_MAX = 64;

/**
 * Compile a site's Tailwind source into its stylesheet: no CDN and no script at runtime, so the published site keeps its strict CSP. Pure and deterministic (the same
 * source and classes give the same CSS), so a result is cached by content.
 */
export async function compileSiteCss(t: { source: string; candidates: string[] }): Promise<string> {
  const key = createHash('sha256')
    .update(t.source)
    .update('\0')
    .update(t.candidates.join(' '))
    .digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const compiler = await tailwind.compile(t.source, { base: TW_DIR, loadStylesheet });
  const css = compiler
    .build(t.candidates)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, `${css}\n`);
  return `${css}\n`;
}

/**
 * `renderSite` with the stylesheet compiled: the pages carry Tailwind utility classes, and `assets/styles.css` is replaced by exactly the CSS they need. The finished
 * stylesheet is checked for physical (left/right) direction rules like the source is, so one file serves both reading directions.
 */
export async function renderSiteCss(
  model: SiteModel,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const out = renderSite(model, options);
  const css = await compileSiteCss(out.tailwind);
  const issues = [...out.issues];
  for (const m of lintPhysicalDirectionCss(css))
    issues.push({
      code: 'css_direction',
      severity: 'error',
      message: m,
      file: 'assets/styles.css',
    });
  return {
    ...out,
    issues,
    files: out.files.map((f) => (f.path === 'assets/styles.css' ? { ...f, content: css } : f)),
  };
}
