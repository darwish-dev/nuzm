import type { SiteModel, Tokens } from '../site-model';
import type { Palette } from './palette';

const RADIUS: Record<Tokens['radius'], string> = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '1rem',
};
const SPACE: Record<Tokens['spacing'], string> = {
  compact: '2rem',
  normal: '3.5rem',
  relaxed: '5rem',
};
const WIDTH: Record<Tokens['width'], string> = { narrow: '44rem', normal: '68rem', wide: '84rem' };
const FONT: Record<Tokens['fontFamily'], string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Arabic", Tahoma, Arial, sans-serif',
  serif: 'Georgia, "Noto Naskh Arabic", "Times New Roman", serif',
};

/**
 * The ONE stylesheet, as a Tailwind CSS v4 SOURCE: the pages carry Tailwind utility classes, and the server compiles exactly the utilities they use into
 * `assets/styles.css` (no CDN, no runtime script: the site keeps its strict CSP). Only design tokens (lookup tables above) and re-validated hex colours are
 * interpolated; layout uses logical utilities (`ps-`, `ms-`, `text-start`, `border-s` …) so the same file serves RTL and LTR (see `lintPhysicalDirectionCss`).
 */
export function buildCss(model: SiteModel, p: Palette): string {
  const t = model.tokens;
  const radius = RADIUS[t.radius] ?? RADIUS.md;
  const space = SPACE[t.spacing] ?? SPACE.normal;
  const width = WIDTH[t.width] ?? WIDTH.normal;
  const font = FONT[t.fontFamily] ?? FONT.sans;
  return `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);

:root {
  --c-bg: ${p.bg};
  --c-text: ${p.text};
  --c-primary: ${p.primary};
  --c-on-primary: ${p.onPrimary};
  --c-accent: ${p.accent};
  --c-on-accent: ${p.onAccent};
  --c-muted-bg: ${p.mutedBg};
  --c-muted-text: ${p.mutedText};
  --c-link: ${p.link};
  --c-border: ${p.border};
  --radius: ${radius};
  --space: ${space};
  --width: ${width};
  --font: ${font};
}

@theme {
  --color-page: var(--c-bg);
  --color-ink: var(--c-text);
  --color-primary: var(--c-primary);
  --color-on-primary: var(--c-on-primary);
  --color-accent: var(--c-accent);
  --color-on-accent: var(--c-on-accent);
  --color-soft: var(--c-muted-bg);
  --color-muted: var(--c-muted-text);
  --color-link: var(--c-link);
  --color-line: var(--c-border);
  --color-tint: color-mix(in srgb, var(--c-primary) 9%, var(--c-bg));
  --radius-site: var(--radius);
  --spacing-section: var(--space);
  --container-site: var(--width);
  --font-site: var(--font);
  --shadow-card: 0 1px 2px color-mix(in srgb, var(--c-text) 8%, transparent), 0 8px 24px color-mix(in srgb, var(--c-text) 8%, transparent);
}

@layer base {
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; font-family: var(--font-site); font-size: 1rem; line-height: 1.6; color: var(--color-ink); background: var(--color-page); overflow-wrap: break-word; }
  html[lang="ar"] body { line-height: 1.85; }
  html[lang="en"] h1 { letter-spacing: -0.02em; }
  :focus-visible { outline: 3px solid var(--color-link); outline-offset: 2px; }
  a { color: var(--color-link); text-decoration: underline; text-underline-offset: 0.15em; }
  h1, h2, h3 { line-height: 1.2; margin-block: 0 0.75rem; text-wrap: balance; }
  p { margin-block: 0 1rem; }
  figure, blockquote { margin: 0; }
  summary { list-style-position: inside; }
  .tone-primary a:not([class]) { color: inherit; }
  .tone-primary :focus-visible { outline-color: var(--color-on-primary); }
  .tone-primary .card a:not([class]) { color: var(--color-link); }
  .tone-primary .card, .tone-primary .step { color: var(--color-ink); }
}
`;
}
