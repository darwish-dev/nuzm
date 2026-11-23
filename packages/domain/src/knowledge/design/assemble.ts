import { contrast, parseColor, toHex, type Rgba } from './color';
import {
  DESIGN_ANALYZER_VERSION,
  DESIGN_LIMITS as L,
  type DesignFileFacts,
  type TokenCategory,
  type TokenFact,
  type TokenOrigin,
} from './types';

/**
 * Design DNA assembly (S-K4): merges the per-file design facts of a version into token rows, theme variants and one Design DNA document per project. Pure and deterministic:
 * the same facts give the same bytes. Every value carries the file and line (or token path) that proves it; roles are inferred from names AND how properties use them, with a
 * confidence; contrast is the WCAG formula over resolved colours; a value that cannot be resolved is reported as unresolved, never invented.
 */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const CATEGORY_ORDER: Record<TokenCategory, number> = {
  color: 0,
  typography: 1,
  spacing: 2,
  radius: 3,
  shadow: 4,
  breakpoint: 5,
  motion: 6,
  other: 7,
};

export interface DesignAssembleFile {
  path: string;
  project: string;
  facts: DesignFileFacts;
}
export interface DesignAssembleProject {
  root: string;
  name: string | null;
  kind: string;
  frameworks: string[];
}
export interface DesignComponentRef {
  name: string;
  kind: string;
  framework: string | null;
  path: string;
}
export interface TokenRow {
  category: TokenCategory;
  name: string;
  value: string;
  mode: string;
  line: number;
  origin: TokenOrigin;
  dynamic: boolean;
  resolvedValue: string | null;
  sourcePath: string;
  project: string;
}
export interface VariantRow {
  kind: string;
  name: string;
  descriptor: Record<string, unknown>;
}
interface Evidence {
  path: string;
  line: number;
}
export interface DnaEntry {
  name: string;
  value: string;
  resolved: string | null;
  px: number | null;
  mode: string;
  origin: TokenOrigin;
  evidence: Evidence;
}
export interface DnaRole {
  role: string;
  token: string;
  value: string;
  hex: string | null;
  mode: string;
  via: 'name' | 'name+usage';
  confidence: number;
  evidence: Evidence;
}
export interface DnaContrast {
  mode: string;
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  aa: boolean;
  aaLarge: boolean;
  aaa: boolean;
}
export interface ProjectDna {
  root: string;
  name: string | null;
  frameworks: string[];
  sources: { path: string; kind: string; tokens: number }[];
  modes: string[];
  palette: { mode: string; roles: DnaRole[]; colors: DnaEntry[] }[];
  typography: {
    families: DnaEntry[];
    sizes: DnaEntry[];
    weights: DnaEntry[];
    lineHeights: DnaEntry[];
  };
  spacing: { scale: DnaEntry[]; baseUnit: number | null; baseUnitInferred: boolean };
  radius: DnaEntry[];
  shadows: DnaEntry[];
  breakpoints: DnaEntry[];
  motion: DnaEntry[];
  contrast: DnaContrast[];
  traits: {
    darkMode: boolean;
    multiTheme: boolean;
    schemes: string[];
    rtl: boolean;
    logicalProperties: boolean;
    arabicFont: boolean;
    tailwind: boolean;
    cssVariables: boolean;
    material3: boolean | null;
  };
  dynamic: { name: string; path: string; line: number }[];
  stats: { files: number; tokens: number; resolved: number; unresolved: number; dynamic: number };
}
export interface DesignDna {
  schemaVersion: '1';
  analyzerVersion: string;
  /** Index of the project the UI shows first: the one with the most colour tokens. */
  primary: number;
  projects: ProjectDna[];
  stats: {
    files: number;
    tokens: number;
    variants: number;
    skipped: Record<string, number>;
    truncated: string[];
  };
}
export interface DesignResult {
  tokens: TokenRow[];
  variants: VariantRow[];
  dna: DesignDna;
}

// ---- value resolution ------------------------------------------------------------------------------------------------------------
const TRIPLET =
  /^([+-]?\d*\.?\d+)(?:deg)?[\s,]+(\d*\.?\d+)%[\s,]+(\d*\.?\d+)%(?:\s*\/\s*([\d.]+%?))?$/;
/** A colour value as text → colour. Understands the shadcn habit of storing `hsl` channels without the function (`222 47% 11%`). */
export function colorOf(v: string | null): Rgba | null {
  if (!v) return null;
  const direct = parseColor(v);
  if (direct) return direct;
  const m = TRIPLET.exec(v.trim());
  return m ? parseColor(`hsl(${m[1]} ${m[2]}% ${m[3]}%${m[4] ? ` / ${m[4]}` : ''})`) : null;
}
const VAR = /var\(\s*(--[\w-]{1,100})\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
const ALIAS = /^\{([\w$.\-/: ]{1,120})\}$/;

interface Scope {
  byMode: Map<string, Map<string, TokenFact>>;
}
function lookup(scope: Scope, mode: string, name: string): TokenFact | undefined {
  return scope.byMode.get(mode)?.get(name) ?? scope.byMode.get('base')?.get(name);
}
/** Resolves `var(--x, fallback)` and `{alias.path}` against the tokens of the same project, in the mode first and then the base. Cycle-safe, depth-limited. */
function resolve(scope: Scope, mode: string, value: string, depth = 0): string | null {
  if (depth > 6) return null;
  const alias = ALIAS.exec(value.trim());
  if (alias) {
    const t = lookup(scope, mode, alias[1]!);
    return t && !t.dynamic ? resolve(scope, mode, t.value, depth + 1) : null;
  }
  if (!value.includes('var(')) return value;
  let failed = false;
  const out = value.replace(VAR, (_all, name: string, fallback: string | undefined) => {
    const t = lookup(scope, mode, name);
    const sub = t && !t.dynamic ? resolve(scope, mode, t.value, depth + 1) : null;
    if (sub !== null) return sub;
    if (fallback !== undefined) {
      const fb = resolve(scope, mode, fallback.trim(), depth + 1);
      if (fb !== null) return fb;
    }
    failed = true;
    return '';
  });
  return failed || out.includes('var(') ? null : out;
}

const pxOf = (v: string | null): number | null => {
  if (!v) return null;
  const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!) * (m[2] === 'rem' ? 16 : 1);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

// ---- roles -----------------------------------------------------------------------------------------------------------------------
interface RoleDef {
  role: string;
  exact: string[];
  pattern: RegExp;
  usage: 'bg' | 'fg' | 'border' | null;
  /** A candidate whose normalised name matches this is never this role. */
  not?: RegExp;
}
const FG_WORDS = /(foreground|(^|-)on-|(^|-)text($|-)|contrast-?text|(^|-)fg($|-))/;
const ROLES: RoleDef[] = [
  {
    role: 'primary',
    exact: [
      'primary',
      'brand',
      'main',
      'primary-500',
      'primary-600',
      'primary-default',
      'primary-main',
      'primary-color',
      'primarycolor',
    ],
    pattern: /(^|-)(primary|brand)(-(\d{2,3}|default|base|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'primary-foreground',
    exact: [
      'primary-foreground',
      'on-primary',
      'onprimary',
      'primary-contrast-text',
      'primary-contrasttext',
      'primary-text',
    ],
    pattern: /(on-?primary|primary-(foreground|contrast|text))/,
    usage: 'fg',
  },
  {
    role: 'secondary',
    exact: ['secondary', 'secondary-500', 'secondary-main', 'secondary-color', 'secondarycolor'],
    pattern: /(^|-)secondary(-(\d{2,3}|default|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'accent',
    exact: ['accent', 'accent-500', 'accent-color', 'accentcolor'],
    pattern: /(^|-)accent(-(\d{2,3}|default|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'background',
    exact: [
      'background',
      'bg',
      'background-color',
      'scaffoldbackgroundcolor',
      'background-default',
      'page-bg',
      'body-bg',
      'canvas',
    ],
    pattern: /(^|-)(background|bg|canvas)(-(default|color|page|body|base))?$/,
    usage: 'bg',
    not: FG_WORDS,
  },
  {
    role: 'surface',
    exact: [
      'surface',
      'card',
      'paper',
      'background-paper',
      'surface-color',
      'cardcolor',
      'popover',
    ],
    pattern: /(^|-)(surface|card|paper|popover)(-(default|color|bg|background))?$/,
    usage: 'bg',
    not: FG_WORDS,
  },
  {
    role: 'foreground',
    exact: [
      'foreground',
      'text',
      'body',
      'text-primary',
      'fg',
      'on-background',
      'on-surface',
      'onbackground',
      'onsurface',
      'text-color',
      'body-color',
    ],
    pattern: /(^|-)(foreground|text(-(primary|color|default|body))?|fg|body-color)$/,
    usage: 'fg',
    not: /(primary-foreground|muted|secondary|accent|card-foreground|disabled|inverse)/,
  },
  {
    role: 'muted-foreground',
    exact: ['muted-foreground', 'text-secondary', 'text-muted', 'muted-text', 'text-subtle'],
    pattern: /(muted-foreground|text-(secondary|muted|subtle)|muted-text)/,
    usage: 'fg',
  },
  {
    role: 'border',
    exact: ['border', 'border-color', 'divider', 'outline', 'input'],
    pattern: /(^|-)(border|divider|outline)(-(default|color))?$/,
    usage: 'border',
  },
  {
    role: 'danger',
    exact: ['destructive', 'danger', 'error', 'negative', 'error-main', 'color-error'],
    pattern: /(^|-)(destructive|danger|error|negative)(-(\d{2,3}|default|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'success',
    exact: ['success', 'positive', 'success-main'],
    pattern: /(^|-)(success|positive)(-(\d{2,3}|default|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'warning',
    exact: ['warning', 'caution', 'warning-main'],
    pattern: /(^|-)(warning|caution)(-(\d{2,3}|default|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
  {
    role: 'info',
    exact: ['info', 'information', 'info-main'],
    pattern: /(^|-)(info|information)(-(\d{2,3}|default|main|color))?$/,
    usage: null,
    not: FG_WORDS,
  },
];
const PREFIX =
  /^(--|\$|@)?(color-|colors?[.\-/]|palette[.\-/]|colorscheme[.\-/]|theme[.\-/]|tw-)+/i;
/** `--color-primary-500` → `primary-500`; `palette.primary.main` → `primary-main`; `colorScheme.onPrimary` → `onprimary`. */
export const roleKey = (name: string): string =>
  name
    .replace(/^(--|\$|@)/, '')
    .replace(PREFIX, '')
    .replace(/[.:/ ]+/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();

const ARABIC_FONTS =
  /(cairo|tajawal|almarai|noto (sans|kufi|naskh) arabic|ibm plex (sans )?arabic|amiri|harmattan|lateef|scheherazade|changa|el messiri|mada|lemonada|rakkas|readex|baloo bhaijaan|dubai|dm sans arabic|vazirmatn|kufi|naskh|noto-?sans-?arabic|ibm-?plex-?arabic|googlefonts\.(cairo|tajawal|almarai|amiri|readexpro|ibmplexsansarabic|notosansarabic|notokufiarabic|notonaskharabic|elmessiri|changa|mada|lemonada))/i;

// ---- assembly --------------------------------------------------------------------------------------------------------------------
export function assembleDesign(
  files: DesignAssembleFile[],
  components: DesignComponentRef[],
  projects: DesignAssembleProject[],
): DesignResult {
  const sortedFiles = [...files].sort((a, b) => cmp(a.path, b.path));
  const truncated = new Set<string>();
  const skipped: Record<string, number> = {};
  const rows: TokenRow[] = [];
  const byProject = new Map<string, DesignAssembleFile[]>();
  for (const f of sortedFiles) {
    if (f.facts.skipped) {
      skipped[f.facts.skipped] = (skipped[f.facts.skipped] ?? 0) + 1;
      continue;
    }
    if (f.facts.truncated) truncated.add('file_tokens');
    const list = byProject.get(f.project) ?? [];
    list.push(f);
    byProject.set(f.project, list);
  }
  const projectDnas: ProjectDna[] = [];
  const scopes = new Map<string, Scope>();

  for (const p of [...projects].sort((a, b) => cmp(a.root, b.root))) {
    const pf = byProject.get(p.root) ?? [];
    if (!pf.length) continue;
    const scope: Scope = { byMode: new Map() };
    const where = new Map<string, { path: string; origin: TokenOrigin }>();
    for (const f of pf)
      for (const t of f.facts.tokens) {
        const m = scope.byMode.get(t.mode) ?? new Map<string, TokenFact>();
        // a later file of the same project overrides an earlier one with the same name (cascade order is by path: deterministic, labelled)
        m.set(t.name, t);
        scope.byMode.set(t.mode, m);
        where.set(`${t.mode}\u0000${t.name}`, { path: f.path, origin: t.origin });
      }
    scopes.set(p.root, scope);

    const projRows: TokenRow[] = [];
    for (const f of pf)
      for (const t of f.facts.tokens) {
        const rv = t.dynamic ? null : resolve(scope, t.mode, t.value);
        projRows.push({
          ...t,
          resolvedValue: rv !== null && rv !== t.value ? rv : null,
          sourcePath: f.path,
          project: p.root,
        });
      }
    rows.push(...projRows);

    const entryOf = (r: TokenRow): DnaEntry => {
      const eff = r.resolvedValue ?? r.value;
      return {
        name: r.name,
        value: r.dynamic ? '(dynamic)' : r.value,
        resolved: r.resolvedValue,
        px: r.category === 'color' ? null : pxOf(eff),
        mode: r.mode,
        origin: r.origin,
        evidence: { path: r.sourcePath, line: r.line },
      };
    };
    const live = projRows.filter((r) => r.mode !== 'scoped');
    const of = (cat: TokenCategory) =>
      live
        .filter((r) => r.category === cat && !r.dynamic)
        .sort(
          (a, b) => cmp(a.mode, b.mode) || cmp(a.name, b.name) || cmp(a.sourcePath, b.sourcePath),
        );
    const cap = <T>(a: T[], n: number, label: string): T[] => {
      if (a.length > n) truncated.add(label);
      return a.slice(0, n);
    };

    // usage evidence per custom property
    const usage = new Map<string, { bg: number; fg: number; border: number }>();
    for (const f of pf)
      for (const u of f.facts.usage) {
        const x = usage.get(u.name) ?? { bg: 0, fg: 0, border: 0 };
        x.bg += u.bg;
        x.fg += u.fg;
        x.border += u.border;
        usage.set(u.name, x);
      }

    // modes and palette per mode (the cascade: base, overridden by the mode)
    const modes = [...new Set(live.filter((r) => r.category === 'color').map((r) => r.mode))].sort(
      (a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : cmp(a, b)),
    );
    const palette: ProjectDna['palette'] = [];
    const contrastOut: DnaContrast[] = [];
    for (const mode of modes) {
      const eff = new Map<string, TokenRow>();
      for (const r of live.filter((x) => x.category === 'color' && !x.dynamic && x.mode === 'base'))
        eff.set(r.name, r);
      if (mode !== 'base')
        for (const r of live.filter((x) => x.category === 'color' && !x.dynamic && x.mode === mode))
          eff.set(r.name, r);
      const colored = [...eff.values()]
        .map((r) => ({ r, rgb: colorOf(r.resolvedValue ?? r.value) }))
        .sort((a, b) => cmp(a.r.name, b.r.name) || cmp(a.r.sourcePath, b.r.sourcePath));
      const roles: DnaRole[] = [];
      const picked = new Map<string, { rgb: Rgba; hex: string }>();
      for (const def of ROLES) {
        let best: { score: number; row: TokenRow; rgb: Rgba | null; key: string } | null = null;
        for (const { r, rgb } of colored) {
          const key = roleKey(r.name);
          if (def.not?.test(key)) continue;
          const exact = def.exact.includes(key);
          if (!exact && !def.pattern.test(key)) continue;
          const score =
            (exact ? 3 : 1) + (rgb ? 0.5 : 0) - (r.mode === mode || mode === 'base' ? 0 : 0.2);
          if (!best || score > best.score) best = { score, row: r, rgb, key };
        }
        if (!best) continue;
        const u = usage.get(best.row.name);
        const used = def.usage && u ? u[def.usage] : 0;
        const exact = def.exact.includes(best.key);
        const confidence = Math.min(
          0.95,
          0.5 + (exact ? 0.3 : 0.15) + (used > 0 ? 0.1 : 0) + (best.rgb ? 0.05 : 0),
        );
        roles.push({
          role: def.role,
          token: best.row.name,
          value: best.row.value,
          hex: best.rgb ? toHex(best.rgb) : null,
          mode,
          via: used > 0 ? 'name+usage' : 'name',
          confidence: Math.round(confidence * 100) / 100,
          evidence: { path: best.row.sourcePath, line: best.row.line },
        });
        if (best.rgb && best.rgb.a === 1)
          picked.set(def.role, { rgb: best.rgb, hex: toHex(best.rgb) });
      }
      const rolesSorted = roles.sort(
        (a, b) =>
          ROLES.findIndex((x) => x.role === a.role) - ROLES.findIndex((x) => x.role === b.role),
      );
      palette.push({
        mode,
        roles: rolesSorted,
        colors: cap(
          colored.filter((x) => x.rgb).map((x) => entryOf(x.r)),
          60,
          'palette_colors',
        ),
      });
      const pairs: [string, string, string][] = [
        ['foreground', 'background', 'text/background'],
        ['primary-foreground', 'primary', 'on-primary/primary'],
        ['foreground', 'surface', 'text/surface'],
        ['muted-foreground', 'background', 'muted-text/background'],
        ['primary', 'background', 'primary/background'],
      ];
      for (const [fg, bg, label] of pairs) {
        const a = picked.get(fg);
        const b = picked.get(bg);
        if (!a || !b) continue;
        const ratio = contrast(a.rgb, b.rgb);
        if (ratio === null) continue;
        contrastOut.push({
          mode,
          pair: label,
          foreground: a.hex,
          background: b.hex,
          ratio,
          aa: ratio >= 4.5,
          aaLarge: ratio >= 3,
          aaa: ratio >= 7,
        });
      }
    }

    const typo = of('typography');
    const isFamily = (r: TokenRow) =>
      /font-?family|(^|[-._])font-(sans|serif|mono|display|body|heading|base)|fontfamily|typeface/i.test(
        r.name,
      ) ||
      (!/\d/.test(r.value) &&
        /,|serif|sans|mono|^["']?[A-Z][\w ]+["']?$/.test(r.value) &&
        /font/i.test(r.name) &&
        !/weight|size|style/i.test(r.name));
    const families = typo.filter(isFamily);
    const weights = typo.filter((r) => /weight/i.test(r.name));
    const lineHeights = typo.filter((r) => /line-?height|leading/i.test(r.name));
    const sizes = typo.filter(
      (r) =>
        !isFamily(r) &&
        !/weight|line-?height|leading|letter|tracking/i.test(r.name) &&
        pxOf(r.resolvedValue ?? r.value) !== null,
    );
    const spacingRows = of('spacing').filter((r) => pxOf(r.resolvedValue ?? r.value) !== null);
    const pxs = [
      ...new Set(
        spacingRows.map((r) => pxOf(r.resolvedValue ?? r.value)!).filter((n) => n >= 1 && n <= 256),
      ),
    ].slice(0, 40);
    const baseTok = spacingRows.find((r) => /(^|[-._])spacing$/i.test(r.name.replace(/^--/, '')));
    let baseUnit: number | null = null;
    let baseUnitInferred = false;
    if (baseTok) baseUnit = pxOf(baseTok.resolvedValue ?? baseTok.value);
    else if (pxs.length >= 3) {
      for (const g of [8, 4, 2]) {
        if (pxs.every((n) => Number.isInteger(n / g))) {
          baseUnit = g;
          baseUnitInferred = true;
          break;
        }
      }
    }
    const allTraits = pf.map((f) => f.facts.traits);
    const schemeNames = [...new Set(pf.flatMap((f) => f.facts.schemes.map((s) => s.name)))].sort(
      cmp,
    );
    const fontText = families.map((r) => r.resolvedValue ?? r.value).join(' ');
    const dyn = projRows
      .filter((r) => r.dynamic)
      .sort((a, b) => cmp(a.sourcePath, b.sourcePath) || a.line - b.line);
    const dna: ProjectDna = {
      root: p.root,
      name: p.name,
      frameworks: [...p.frameworks].sort(cmp),
      sources: pf.map((f) => ({ path: f.path, kind: f.facts.kind, tokens: f.facts.tokens.length })),
      modes,
      palette,
      typography: {
        families: cap(families.map(entryOf), 20, 'families'),
        sizes: cap(sizes.map(entryOf), 40, 'sizes'),
        weights: cap(weights.map(entryOf), 20, 'weights'),
        lineHeights: cap(lineHeights.map(entryOf), 20, 'line_heights'),
      },
      spacing: { scale: cap(spacingRows.map(entryOf), 40, 'spacing'), baseUnit, baseUnitInferred },
      radius: cap(of('radius').map(entryOf), 20, 'radius'),
      shadows: cap(of('shadow').map(entryOf), 20, 'shadows'),
      breakpoints: cap(of('breakpoint').map(entryOf), 12, 'breakpoints'),
      motion: cap(of('motion').map(entryOf), 20, 'motion'),
      contrast: cap(contrastOut, 60, 'contrast'),
      traits: {
        darkMode: modes.includes('dark') || allTraits.some((t) => t.darkMedia),
        multiTheme: schemeNames.filter((s) => s !== 'dark' && s !== 'light').length > 0,
        schemes: schemeNames,
        rtl: allTraits.some((t) => t.rtl),
        logicalProperties: allTraits.some((t) => t.logicalProps),
        arabicFont: ARABIC_FONTS.test(fontText),
        tailwind:
          allTraits.some((t) => t.tailwind) ||
          projRows.some((r) => r.origin === 'tailwind-theme' || r.origin === 'tailwind-config'),
        cssVariables: projRows.some((r) => r.origin === 'css-var'),
        material3: (() => {
          const m = projRows.find((r) => r.name === 'useMaterial3');
          return m ? m.value === 'true' : null;
        })(),
      },
      dynamic: cap(
        dyn.map((r) => ({ name: r.name, path: r.sourcePath, line: r.line })),
        50,
        'dynamic',
      ),
      stats: {
        files: pf.length,
        tokens: projRows.length,
        resolved: projRows.filter((r) => r.resolvedValue !== null).length,
        unresolved: projRows.filter(
          (r) => !r.dynamic && r.value.includes('var(') && r.resolvedValue === null,
        ).length,
        dynamic: dyn.length,
      },
    };
    projectDnas.push(dna);
  }

  // rows: colours and typography first, then the cap
  rows.sort(
    (a, b) =>
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      cmp(a.project, b.project) ||
      cmp(a.sourcePath, b.sourcePath) ||
      cmp(a.mode, b.mode) ||
      cmp(a.name, b.name),
  );
  if (rows.length > L.maxTokens) truncated.add('tokens');
  const tokens = rows.slice(0, L.maxTokens);

  // ---- variants: colour schemes and layouts -----------------------------------------------------------------------------------------
  const variants = new Map<string, VariantRow>();
  const addVariant = (v: VariantRow) => {
    const k = `${v.kind}\u0000${v.name}`;
    if (!variants.has(k) && variants.size < L.maxVariants) variants.set(k, v);
    else if (!variants.has(k)) truncated.add('variants');
  };
  for (const f of sortedFiles) {
    if (f.facts.skipped) continue;
    for (const s of f.facts.schemes)
      addVariant({
        kind: 'color-scheme',
        name: s.name,
        descriptor: {
          mode: s.mode,
          selector: s.selector,
          path: f.path,
          line: s.line,
          tokens: f.facts.tokens.filter((t) => t.mode === s.name).length,
        },
      });
  }
  const LAYOUT: [RegExp, string][] = [
    [/^(dashboard)?(shell|layout)$|layout$/i, 'layout'],
    [/sidebar|sidenav|drawer|navrail/i, 'sidebar'],
    [/header|navbar|topbar|appbar|navigationbar/i, 'header'],
    [/footer|bottomnav|bottombar/i, 'footer'],
  ];
  const PAGE =
    /(^|[/_.-])(login|signin|sign-in|signup|sign-up|register|pricing|landing|home|dashboard|settings|profile|checkout|cart|404|error|onboarding)($|[/_.-])/i;
  for (const c of [...components].sort((a, b) => cmp(a.path, b.path) || cmp(a.name, b.name))) {
    if (c.kind.startsWith('nest-')) continue;
    let kind: string | null = null;
    if (c.kind === 'next-layout') kind = 'layout';
    else
      for (const [re, k] of LAYOUT)
        if (re.test(c.name)) {
          kind = k;
          break;
        }
    if (!kind && /dashboard/i.test(c.name) && /(shell|layout|scaffold)/i.test(c.name))
      kind = 'dashboard-shell';
    if (
      !kind &&
      (c.kind === 'next-page' || /(screen|page)$/i.test(c.name)) &&
      PAGE.test(`${c.path}/${c.name}`)
    )
      kind = c.framework === 'flutter' ? 'screen' : 'page-template';
    if (!kind) continue;
    addVariant({
      kind,
      name: c.name,
      descriptor: {
        component: c.name,
        componentKind: c.kind,
        framework: c.framework,
        path: c.path,
      },
    });
  }

  const primary = (() => {
    let best = 0;
    let n = -1;
    projectDnas.forEach((p, i) => {
      const c = p.palette.reduce((a, x) => a + x.colors.length, 0);
      if (c > n) {
        n = c;
        best = i;
      }
    });
    return best;
  })();
  const variantRows = [...variants.values()].sort(
    (a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name),
  );
  return {
    tokens,
    variants: variantRows,
    dna: {
      schemaVersion: '1',
      analyzerVersion: DESIGN_ANALYZER_VERSION,
      primary,
      projects: projectDnas.slice(0, 6),
      stats: {
        files: sortedFiles.filter((f) => !f.facts.skipped).length,
        tokens: tokens.length,
        variants: variantRows.length,
        skipped,
        truncated: [...truncated].sort(cmp),
      },
    },
  };
}

/** The schema-3 manifest: everything of schema 2 plus a compact design summary (the full document is served by its own endpoint from the DNA row). */
export function buildManifestV3(
  v2: Record<string, unknown>,
  dna: DesignDna,
): Record<string, unknown> {
  const p = dna.projects[dna.primary];
  return {
    ...v2,
    schemaVersion: '3',
    design: {
      analyzerVersion: dna.analyzerVersion,
      projects: dna.projects.length,
      tokens: dna.stats.tokens,
      variants: dna.stats.variants,
      modes: p?.modes ?? [],
      roles: (p?.palette[0]?.roles ?? []).map((r) => r.role),
      darkMode: p?.traits.darkMode ?? false,
      multiTheme: p?.traits.multiTheme ?? false,
      rtl: p?.traits.rtl ?? false,
      arabicFont: p?.traits.arabicFont ?? false,
    },
  };
}

/** The DNA row is bounded (200 KB in the database): drop the least important projects, then shorten the colour lists, until it fits. Deterministic. */
export function fitDna(dna: DesignDna, maxBytes = 150_000): DesignDna {
  const size = (d: DesignDna) => JSON.stringify(d).length;
  let out = dna;
  if (size(out) <= maxBytes) return out;
  const marks = new Set(out.stats.truncated);
  marks.add('dna_size');
  while (size(out) > maxBytes && out.projects.length > 1) {
    let drop = out.projects.length - 1;
    if (drop === out.primary) drop--;
    out = {
      ...out,
      primary: drop < out.primary ? out.primary - 1 : out.primary,
      projects: out.projects.filter((_, i) => i !== drop),
    };
  }
  for (const n of [30, 12, 4]) {
    if (size(out) <= maxBytes) break;
    out = {
      ...out,
      projects: out.projects.map((p) => ({
        ...p,
        palette: p.palette.map((x) => ({ ...x, colors: x.colors.slice(0, n) })),
        spacing: { ...p.spacing, scale: p.spacing.scale.slice(0, n) },
        typography: { ...p.typography, sizes: p.typography.sizes.slice(0, n) },
      })),
    };
  }
  return { ...out, stats: { ...out.stats, truncated: [...marks].sort(cmp) } };
}
