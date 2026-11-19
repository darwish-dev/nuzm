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
 * The ONE stylesheet. Only design tokens (lookup tables above) and re-validated hex colours are interpolated; layout uses CSS logical
 * properties exclusively so the same file serves RTL and LTR (see `lintPhysicalDirectionCss`).
 */
export function buildCss(model: SiteModel, p: Palette): string {
  const t = model.tokens;
  const radius = RADIUS[t.radius] ?? RADIUS.md;
  const space = SPACE[t.spacing] ?? SPACE.normal;
  const width = WIDTH[t.width] ?? WIDTH.normal;
  const font = FONT[t.fontFamily] ?? FONT.sans;
  return `:root {
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
  --gap: 1.5rem;
  --shadow: 0 1px 2px color-mix(in srgb, var(--c-text) 8%, transparent), 0 8px 24px color-mix(in srgb, var(--c-text) 8%, transparent);
  --tint: color-mix(in srgb, var(--c-primary) 9%, var(--c-bg));
  --font: ${font};
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font);
  font-size: 1rem;
  line-height: 1.6;
  color: var(--c-text);
  background: var(--c-bg);
  overflow-wrap: break-word;
}
html[lang="ar"] body { line-height: 1.85; }
img { display: block; max-inline-size: 100%; block-size: auto; }
a { color: var(--c-link); text-decoration: underline; text-underline-offset: 0.15em; }
:focus-visible { outline: 3px solid var(--c-link); outline-offset: 2px; }
h1, h2, h3 { line-height: 1.2; margin-block: 0 0.75rem; text-wrap: balance; }
h1 { font-size: clamp(2.25rem, 5.5vw, 3.75rem); font-weight: 800; }
h2 { font-size: clamp(1.6rem, 3.5vw, 2.4rem); font-weight: 750; }
h3 { font-size: 1.2rem; font-weight: 700; }
html[lang="en"] h1 { letter-spacing: -0.02em; }
html[lang="en"] h2 { letter-spacing: -0.01em; }
p { margin-block: 0 1rem; }
ul { margin: 0; padding: 0; list-style: none; }
figure { margin: 0; }
figcaption { margin-block-start: 0.5rem; font-size: 0.9rem; color: var(--c-muted-text); }
.wrap { max-inline-size: var(--width); margin-inline: auto; padding-inline: 1rem; }
.sr-only, .hp {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.skip {
  position: absolute;
  inset-inline-start: 0.5rem;
  inset-block-start: -5rem;
  z-index: 20;
  padding-block: 0.5rem;
  padding-inline: 1rem;
  color: var(--c-bg);
  background: var(--c-text);
}
.skip:focus { inset-block-start: 0.5rem; color: var(--c-bg); }
.preview-banner { padding-block: 0.5rem; padding-inline: 1rem; text-align: center; font-weight: 600; color: var(--c-bg); background: var(--c-text); }
.site-header { position: sticky; inset-block-start: 0; z-index: 10; background: color-mix(in srgb, var(--c-bg) 92%, transparent); backdrop-filter: saturate(1.4) blur(10px); border-block-end: 1px solid var(--c-border); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.5rem; padding-block: 0.9rem; }
.brand { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1.15rem; color: var(--c-text); text-decoration: none; }
.logo { block-size: 2.25rem; inline-size: auto; }
.nav-list { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
.nav-list a { display: inline-block; padding-block: 0.25rem; }
.nav-list a[aria-current="page"] { font-weight: 700; text-decoration: none; border-block-end: 2px solid currentColor; }
.lang { margin-inline-start: auto; }
.nav-toggle { display: none; font: inherit; padding-block: 0.4rem; padding-inline: 0.9rem; color: var(--c-text); background: var(--c-bg); border: 1px solid var(--c-text); border-radius: var(--radius); cursor: pointer; }
@media (max-width: 48rem) {
  .js .nav-toggle { display: inline-block; }
  .js .nav-list[data-open="false"] { display: none; }
  .js .nav-list { flex-direction: column; inline-size: 100%; }
}
.page-head { padding-block: var(--space) 0; }
.sec { padding-block: calc(var(--space) * 1.15); }
.sec > .wrap > h2 { margin-block-end: 1.25rem; }
.align-center > .wrap > h2 { margin-inline: auto; }
.align-center { text-align: center; }
.align-start { text-align: start; }
.bg-default { background: var(--c-bg); color: var(--c-text); }
.bg-muted { background: var(--c-muted-bg); color: var(--c-text); }
.bg-primary { background: var(--c-primary); color: var(--c-on-primary); }
.bg-primary a, .bg-primary figcaption, .bg-primary .address { color: inherit; }
.bg-primary :focus-visible { outline-color: var(--c-on-primary); }
.bg-primary .card, .bg-primary .form-card { color: var(--c-text); }
.bg-primary .card a { color: var(--c-link); }
.bg-primary .card figcaption, .bg-primary .card .address { color: var(--c-muted-text); }
.btn { display: inline-block; padding-block: 0.8rem; padding-inline: 1.75rem; font: inherit; font-weight: 700; text-decoration: none; color: var(--c-on-primary); background: var(--c-primary); border: 2px solid var(--c-primary); border-radius: var(--radius); box-shadow: var(--shadow); cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease; }
.btn:hover { transform: translateY(-2px); }
.bg-primary .btn { color: var(--c-primary); background: var(--c-on-primary); border-color: var(--c-on-primary); }
.btn:disabled { opacity: 0.6; cursor: progress; }
.sec-hero.bg-default { background: linear-gradient(160deg, var(--tint), var(--c-bg) 70%); }
.sec-hero { padding-block: calc(var(--space) * 1.6); }
.hero-grid { display: grid; gap: 2.5rem; align-items: center; }
.hero-grid:not(.has-media) .hero-copy { max-inline-size: 48rem; }
.align-center .hero-grid:not(.has-media) .hero-copy { margin-inline: auto; }
.hero-copy .lead { margin-block-end: 1.5rem; }
@media (min-width: 48rem) { .hero-grid.has-media { grid-template-columns: 1fr 1fr; } }
.lead { font-size: 1.25rem; color: var(--c-muted-text); }
.bg-primary .lead { color: inherit; opacity: 0.92; }
.align-center .lead { margin-inline: auto; max-inline-size: 40rem; }
.hero-media img, .fig img, .gallery img { border-radius: var(--radius); box-shadow: var(--shadow); }
.gallery img { inline-size: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
.align-center .hero-media img, .align-center .fig img { margin-inline: auto; }
.sec-text .wrap > p, .sec-text .wrap > h2 { max-inline-size: 46rem; }
.align-center.sec-text .wrap > p, .align-center.sec-text .wrap > h2 { margin-inline: auto; }
.grid { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.sec .grid, .faq, .form, .map-card { margin-block-start: 1.5rem; }
.card { padding: 1.5rem; color: var(--c-text); background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius); box-shadow: var(--shadow); transition: transform 0.2s ease, box-shadow 0.2s ease; }
.cards .card { border-block-start: 3px solid var(--c-accent); }
.cards .card:hover { transform: translateY(-3px); }
.plan .amount { color: var(--c-primary); }
@media (prefers-reduced-motion: reduce) { .card, .btn { transition: none; } .cards .card:hover, .btn:hover { transform: none; } }
.card > :last-child { margin-block-end: 0; }
.icon { display: inline-flex; align-items: center; justify-content: center; min-inline-size: 3rem; block-size: 3rem; margin-block-end: 1rem; padding-inline: 0.5rem; font-size: 1.25rem; font-weight: 700; color: var(--c-on-accent); background: var(--c-accent); border-radius: 999px; }
.price { margin-block-end: 0.5rem; }
.amount { font-size: 2rem; font-weight: 700; }
.cur, .period { margin-inline-start: 0.25rem; color: var(--c-muted-text); }
blockquote { margin: 0 0 0.75rem; }
.author { font-weight: 700; font-style: normal; }
.role { margin-inline-start: 0.5rem; }
.faq { text-align: start; }
.qa summary { padding-block: 0.9rem; font-weight: 600; cursor: pointer; }
.qa p { padding-block-end: 0.5rem; }
.form { max-inline-size: 36rem; text-align: start; }
.align-center .form, .align-center .map-card { margin-inline: auto; }
.field { display: grid; gap: 0.3rem; margin-block-end: 1rem; }
.field label { font-weight: 600; }
.req { margin-inline-start: 0.25rem; }
input, textarea { inline-size: 100%; padding-block: 0.6rem; padding-inline: 0.75rem; font: inherit; color: var(--c-text); background: var(--c-bg); border: 1px solid var(--c-muted-text); border-radius: var(--radius); }
.form-status { margin-block-start: 1rem; font-weight: 600; }
.map-card { max-inline-size: 36rem; text-align: start; }
.address { color: var(--c-muted-text); }
.stats-grid { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); margin-block-start: 1.5rem; text-align: center; }
.stat { padding-block: 1rem; }
.stat-value { display: block; font-size: clamp(2rem, 5vw, 3.25rem); font-weight: 800; line-height: 1.1; color: var(--c-primary); }
.bg-primary .stat-value { color: inherit; }
.stat-label { display: block; margin-block-start: 0.4rem; color: var(--c-muted-text); }
.bg-primary .stat-label { color: inherit; opacity: 0.9; }
.cta-box { max-inline-size: 46rem; margin-inline: auto; padding-block: 1rem; }
.cta-box h2 { margin-block-end: 0.75rem; }
.steps-list { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); margin: 1.5rem 0 0; padding: 0; counter-reset: step; list-style: none; }
.step { position: relative; padding: 1.5rem; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius); box-shadow: var(--shadow); counter-increment: step; }
.step::before { content: counter(step); display: inline-flex; align-items: center; justify-content: center; inline-size: 2.5rem; block-size: 2.5rem; margin-block-end: 0.9rem; font-weight: 800; color: var(--c-on-primary); background: var(--c-primary); border-radius: 999px; }
.step p { margin-block-end: 0; color: var(--c-muted-text); }
.qa { margin-block-end: 0.5rem; padding-inline: 1.1rem; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius); }
.site-footer { margin-block-start: var(--space); padding-block: 2rem; color: var(--c-text); background: var(--c-muted-bg); border-block-start: 1px solid var(--c-border); }
.site-footer ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
`;
}
