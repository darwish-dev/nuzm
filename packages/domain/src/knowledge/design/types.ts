import type { SkipReason } from '../components/types';

/** Version of the design analyzers: a new version invalidates the per-file cache (S-K4, SCR-K-06). */
export const DESIGN_ANALYZER_VERSION = '1.0.0';

export type TokenCategory =
  'color' | 'typography' | 'spacing' | 'radius' | 'shadow' | 'breakpoint' | 'motion' | 'other';
export const TOKEN_CATEGORIES: readonly TokenCategory[] = [
  'color',
  'typography',
  'spacing',
  'radius',
  'shadow',
  'breakpoint',
  'motion',
  'other',
];
export type TokenOrigin =
  | 'css-var'
  | 'scss-var'
  | 'less-var'
  | 'tailwind-theme'
  | 'tailwind-config'
  | 'tokens-json'
  | 'js-theme'
  | 'flutter-theme';
export const TOKEN_ORIGINS: readonly TokenOrigin[] = [
  'css-var',
  'scss-var',
  'less-var',
  'tailwind-theme',
  'tailwind-config',
  'tokens-json',
  'js-theme',
  'flutter-theme',
];
export type DesignFileKind = 'css' | 'tokens-json' | 'theme-config' | 'dart-theme';

/** One design value found in one file. `mode` is `base`, `light`, `dark` or a named scheme (`theme-blue`). A value that is computed is `dynamic` and carries no value. */
export interface TokenFact {
  category: TokenCategory;
  name: string;
  value: string;
  mode: string;
  line: number;
  origin: TokenOrigin;
  dynamic: boolean;
}
/** How a custom property is used by declarations: which kind of property reads it. Evidence for roles beyond the name. */
export interface UsageFact {
  name: string;
  bg: number;
  fg: number;
  border: number;
}
export interface SchemeFact {
  name: string;
  selector: string;
  line: number;
  mode: 'light' | 'dark' | 'scheme';
}
export interface DesignTraits {
  /** `direction: rtl`, `[dir=rtl]` or `:dir(rtl)` seen. */
  rtl: boolean;
  /** Logical properties (`margin-inline-start`, `padding-block`, …) used. */
  logicalProps: boolean;
  /** `@tailwind`, `@apply`, `@theme` or `@import "tailwindcss"` seen. */
  tailwind: boolean;
  /** `@media (prefers-color-scheme: dark)` seen. */
  darkMedia: boolean;
}
export interface DesignFileFacts {
  kind: DesignFileKind;
  tokens: TokenFact[];
  usage: UsageFact[];
  schemes: SchemeFact[];
  traits: DesignTraits;
  skipped: SkipReason | null;
  truncated: boolean;
}
export const emptyDesignFacts = (
  kind: DesignFileKind,
  skipped: SkipReason | null = null,
): DesignFileFacts => ({
  kind,
  tokens: [],
  usage: [],
  schemes: [],
  traits: { rtl: false, logicalProps: false, tailwind: false, darkMedia: false },
  skipped,
  truncated: false,
});

export const DESIGN_LIMITS = {
  maxTokensPerFile: 800,
  maxUsagePerFile: 400,
  maxSchemesPerFile: 40,
  maxValue: 400,
  maxName: 120,
  maxLine: 5000,
  maxFiles: 400,
  maxTokens: 6000,
  maxVariants: 300,
  maxJsonNodes: 20_000,
  maxJsonDepth: 9,
} as const;

const NAME = /^[\w$@.\-/: ]{1,120}$/u;
/** Names that come from source text: a restricted alphabet (no control characters, no markup). They are only ever values, never keys of a plain object. */
export const cleanName = (s: unknown): string | null =>
  typeof s === 'string' && NAME.test(s.trim()) ? s.trim() : null;
/** A value: control characters and runs of whitespace collapse; anything over the limit is refused (the caller counts it as truncated). */
/* eslint-disable no-control-regex -- removing control characters is the point of this expression */
const CONTROL = /[\u0000-\u001f\u007f]+/g;
/* eslint-enable no-control-regex */
export const cleanValue = (s: unknown): string | null => {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const v = String(s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return v.length > 0 && v.length <= DESIGN_LIMITS.maxValue ? v : null;
};

/** Category from the name (and the value when the name says nothing). Pure and deterministic. */
export function categoryOf(name: string, value: string): TokenCategory {
  const n = name.toLowerCase();
  if (/(^|[-_.:/ ])(breakpoints?|screens?|bp)([-_.:/ ]|$)/.test(n)) return 'breakpoint';
  if (/(shadow|elevation|drop-shadow)/.test(n)) return 'shadow';
  if (/(radius|radii|rounded|corner)/.test(n)) return 'radius';
  if (/(duration|easing|ease|transition|animation|delay|motion|keyframe)/.test(n)) return 'motion';
  if (
    /(font|typeface|typography|line-?height|letter-?spacing|leading|tracking|text-?(size|xs|sm|base|lg|xl)|heading|body-?text)/.test(
      n,
    )
  )
    return 'typography';
  if (/(^|[-_.:/ ])(spacing|space|gap|padding|margin|gutter|size|sizes|inset)([-_.:/ ]|$)/.test(n))
    return 'spacing';
  if (
    /(colou?r|palette|background|(^|[-_.:/ ])bg([-_.:/ ]|$)|foreground|(^|[-_.:/ ])fg([-_.:/ ]|$)|primary|secondary|accent|surface|border|ring|muted|brand|danger|error|success|warning|info|destructive|text|link|outline|fill|stroke)/.test(
      n,
    )
  )
    return 'color';
  const v = value.trim();
  if (/^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\()/i.test(v)) return 'color';
  if (/^-?\d*\.?\d+(px|rem|em)$/.test(v)) return 'spacing';
  return 'other';
}
