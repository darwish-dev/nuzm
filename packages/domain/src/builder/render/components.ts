import { isSafeUrl, type Localized, type Section, type SectionType } from '../site-model';
import { assetPath, assetSize, ID_RE, pagePath, text } from './common';
import type { RenderCtx } from './types';
import { esc, formatNumber, paragraphs } from './text';
import { UI } from './ui';

type Props = Record<string, unknown>;
const obj = (v: unknown): Props | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Props) : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const loc = (v: unknown): Localized | undefined => obj(v) as Localized | undefined;
const list = (v: unknown): Props[] =>
  Array.isArray(v) ? v.map(obj).filter((x): x is Props => !!x) : [];

const BACKGROUNDS = new Set(['default', 'muted', 'primary']);
const ALIGNS = new Set(['start', 'center']);
const TYPES = new Set<string>([
  'hero',
  'text',
  'image',
  'gallery',
  'features',
  'pricing',
  'testimonials',
  'faq',
  'contact_form',
  'map',
  'stats',
  'cta',
  'steps',
] satisfies SectionType[]);

const T = (ctx: RenderCtx, v: unknown): string => text(loc(v), ctx.locale);
/** escaped localized text */
const E = (ctx: RenderCtx, v: unknown): string => esc(T(ctx, v));

function sid(s: Section): string {
  if (!ID_RE.test(s.id)) throw new RangeError('invalid section id');
  return s.id;
}

/** Resolved link: internal page, safe URL or nothing (reported). */
function resolveLink(
  ctx: RenderCtx,
  v: unknown,
  where: string,
): { href: string; external: boolean } | undefined {
  const o = obj(v);
  if (!o) return undefined;
  if (typeof o.pageId === 'string') {
    const p = ctx.model.pages.find((x) => x.id === o.pageId);
    if (p) return { href: pagePath(ctx.locale, p.slug), external: false };
    ctx.issues.push({
      code: 'unsafe_url',
      severity: 'error',
      message: `unknown page in link at ${where}`,
    });
    return undefined;
  }
  const u = o.url;
  if (!isSafeUrl(u) || u.startsWith('//')) {
    ctx.issues.push({
      code: 'unsafe_url',
      severity: 'error',
      message: `unsafe URL dropped at ${where}`,
    });
    return undefined;
  }
  if (u.startsWith('#') && ctx.page.sections.some((s) => `${s.id}` === u.slice(1)))
    return { href: `#s-${u.slice(1)}`, external: false };
  return { href: u, external: /^https?:/i.test(u) };
}
const anchor = (
  ctx: RenderCtx,
  link: { href: string; external: boolean },
  label: string,
  cls = '',
): string =>
  `<a${cls ? ` class="${cls}"` : ''} href="${esc(link.href)}"${link.external ? ' rel="noopener noreferrer"' : ''}>${label}</a>`;

/** `<img>` for an asset id: always a non-empty alt, intrinsic size when known, lazy loading except for the first content image of the page. */
export function renderImage(
  ctx: RenderCtx,
  assetId: unknown,
  cls = '',
  countAsContent = true,
): string {
  const a = typeof assetId === 'string' ? ctx.assets.get(assetId) : undefined;
  if (!a) return '';
  const size = assetSize(a);
  const first = countAsContent ? ctx.state.images++ === 0 : true;
  const alt = text(a.alt, ctx.locale) || a.label || a.id;
  return `<img${cls ? ` class="${cls}"` : ''} src="/${esc(assetPath(a))}" alt="${esc(alt)}"${size ? ` width="${size.w}" height="${size.h}"` : ''}${first ? '' : ' loading="lazy"'} decoding="async">`;
}

/**
 * The Tailwind utility classes of every part of a page, in one place. Logical utilities only (`ps-`, `ms-`, `text-start` …) so one stylesheet serves RTL and LTR. The
 * semantic hooks (`sec`, `sec-<type>`, `tone-<x>`, `card`, `step`) stay in the markup next to the utilities: the stylesheet and the editor key off them.
 */
export const TW = {
  wrap: 'mx-auto w-full max-w-site px-4',
  tone: {
    default: 'bg-page text-ink',
    muted: 'bg-soft text-ink',
    primary: 'bg-primary text-on-primary',
  } as Record<string, string>,
  align: { start: 'text-start', center: 'text-center' } as Record<string, string>,
  sec: 'py-section',
  h1: 'mb-4 text-4xl font-extrabold leading-tight text-balance md:text-6xl',
  h2: 'mb-5 text-3xl font-bold leading-tight text-balance md:text-4xl',
  h3: 'mb-2 text-xl font-bold',
  lead: 'mb-6 text-xl text-muted in-[.tone-primary]:text-inherit in-[.tone-primary]:opacity-90',
  btn: 'inline-block rounded-site border-2 border-primary bg-primary px-7 py-3 font-bold text-on-primary no-underline shadow-card transition hover:-translate-y-0.5 disabled:cursor-progress disabled:opacity-60 motion-reduce:transition-none motion-reduce:hover:translate-y-0 in-[.tone-primary]:border-on-primary in-[.tone-primary]:bg-on-primary in-[.tone-primary]:text-primary',
  grid: 'mt-6 grid gap-6 grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]',
  card: 'card rounded-site border border-line border-t-accent bg-page p-6 text-ink shadow-card',
  cardLift:
    'transition hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
  img: 'rounded-site shadow-card',
  icon: 'mb-4 inline-flex size-12 items-center justify-center rounded-full bg-accent px-2 text-xl font-bold text-on-accent',
  muted: 'text-muted',
  sr: 'sr-only',
} as const;

/** Wraps section content: `<section id="s-…">`; `labelled` links aria-labelledby to the heading `h-…`. */
function wrap(
  s: Section,
  inner: string,
  labelled: boolean,
  extra = '',
  pad: string = TW.sec,
): string {
  const id = sid(s);
  const tone = BACKGROUNDS.has(s.style?.background ?? '')
    ? (s.style?.background ?? 'default')
    : 'default';
  const align = ALIGNS.has(s.style?.align ?? '') ? (s.style?.align ?? 'start') : 'start';
  const type = TYPES.has(s.type) ? s.type : 'text';
  return `<section id="s-${id}" class="sec sec-${type} tone-${tone} align-${align} ${pad} ${TW.tone[tone]} ${TW.align[align]}${extra}"${labelled ? ` aria-labelledby="h-${id}"` : ''}>\n<div class="${TW.wrap}">\n${inner}\n</div>\n</section>`;
}

/** H2 of a section: visible when the model gives a heading, else visually hidden with a default so list sections always have a name. */
function heading(ctx: RenderCtx, s: Section, fallback: keyof typeof UI | null): string {
  const given = E(ctx, s.props.heading);
  if (given) return `<h2 id="h-${sid(s)}" class="${TW.h2}">${given}</h2>`;
  if (!fallback) return '';
  return `<h2 id="h-${sid(s)}" class="${TW.sr}">${esc(UI[fallback][ctx.locale])}</h2>`;
}

function hero(ctx: RenderCtx, s: Section): string {
  const p = s.props;
  const isH1 = ctx.state.heroH1 && ctx.page.sections[0]?.id === s.id;
  const tag = isH1 ? 'h1' : 'h2';
  const link = resolveLink(ctx, p.cta, `section ${s.id} cta`);
  const label = E(ctx, p.ctaLabel) || esc(UI.ctaDefault[ctx.locale]);
  const centered = s.style?.align === 'center';
  const image = renderImage(ctx, p.imageAssetId, `${TW.img}${centered ? ' mx-auto' : ''}`);
  const sub = E(ctx, p.subheading);
  const copy = [
    `<${tag} id="h-${sid(s)}" class="${isH1 ? TW.h1 : TW.h2}">${E(ctx, p.heading)}</${tag}>`,
    sub ? `<p class="lead ${TW.lead}${centered ? ' mx-auto max-w-2xl' : ''}">${sub}</p>` : '',
    link ? `<p>${anchor(ctx, link, label, `btn ${TW.btn}`)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const grid = `hero-grid grid items-center gap-10${image ? ' has-media md:grid-cols-2' : ''}`;
  const copyCls = `hero-copy${image ? '' : ` max-w-3xl${centered ? ' mx-auto' : ''}`}`;
  const inner = `<div class="${grid}">\n<div class="${copyCls}">\n${copy}\n</div>${image ? `\n<div class="hero-media">\n${image}\n</div>` : ''}\n</div>`;
  const tone = BACKGROUNDS.has(s.style?.background ?? '') ? s.style?.background : 'default';
  return wrap(
    s,
    inner,
    true,
    tone === 'default' ? ' bg-linear-160 from-tint to-page to-70%' : '',
    'py-[calc(var(--spacing-section)*1.5)]',
  );
}

function textSection(ctx: RenderCtx, s: Section): string {
  const h = heading(ctx, s, null);
  const centered = s.style?.align === 'center';
  const body = [h, paragraphs(T(ctx, s.props.body))].filter(Boolean).join('\n');
  return wrap(s, `<div class="max-w-3xl${centered ? ' mx-auto' : ''}">\n${body}\n</div>`, h !== '');
}

function imageSection(ctx: RenderCtx, s: Section): string {
  const cap = E(ctx, s.props.caption);
  const img = renderImage(ctx, s.props.assetId, `${TW.img} mx-auto`);
  return wrap(
    s,
    `<figure class="fig">\n${img}${cap ? `\n<figcaption class="mt-2 text-sm text-muted">${cap}</figcaption>` : ''}\n</figure>`,
    false,
  );
}

function gallery(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.images).map((it) => {
    const cap = E(ctx, it.caption);
    return `<li>\n<figure>\n${renderImage(ctx, it.assetId, `${TW.img} aspect-[4/3] w-full object-cover`)}${cap ? `\n<figcaption class="mt-2 text-sm text-muted">${cap}</figcaption>` : ''}\n</figure>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingGallery')}\n<ul class="gallery grid ${TW.grid}" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function features(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map((it) => {
    const icon = str(it.icon);
    return `<li class="${TW.card} ${TW.cardLift}">\n${icon ? `<span class="icon ${TW.icon}" aria-hidden="true">${esc(icon)}</span>\n` : ''}<h3 class="${TW.h3}">${E(ctx, it.title)}</h3>\n<p>${E(ctx, it.text)}</p>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingFeatures')}\n<ul class="cards ${TW.grid}" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function pricing(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.plans).map((pl) => {
    const cur = str(pl.currency) || 'SAR';
    const curLabel = cur === 'SAR' ? UI.currencySAR[ctx.locale] : cur;
    const desc = E(ctx, pl.description);
    const period = E(ctx, pl.period);
    const price = str(pl.price);
    return `<li class="plan ${TW.card} ${TW.cardLift}">\n<h3 class="${TW.h3}">${E(ctx, pl.name)}</h3>\n<p class="price mb-2"><data class="amount text-3xl font-bold text-primary" value="${esc(price)}">${esc(formatNumber(price, ctx.locale))}</data><span class="cur ms-1 ${TW.muted}">${esc(curLabel)}</span>${period ? `<span class="period ms-1 ${TW.muted}">${period}</span>` : ''}</p>${desc ? `\n<p>${desc}</p>` : ''}\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingPricing')}\n<ul class="cards ${TW.grid}" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function testimonials(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map((it) => {
    const role = E(ctx, it.role);
    return `<li class="${TW.card} ${TW.cardLift}">\n<figure>\n<blockquote class="mb-3"><p>${E(ctx, it.quote)}</p></blockquote>\n<figcaption><cite class="author font-bold not-italic">${esc(str(it.author))}</cite>${role ? `<span class="role ms-2 ${TW.muted}">${role}</span>` : ''}</figcaption>\n</figure>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingTestimonials')}\n<ul class="cards ${TW.grid}" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function faq(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map(
    (it) =>
      `<details class="qa mb-2 rounded-site border border-line bg-page px-4 text-ink">\n<summary class="cursor-pointer py-3.5 font-semibold">${E(ctx, it.question)}</summary>\n${paragraphs(T(ctx, it.answer))}\n</details>`,
  );
  return wrap(
    s,
    `${heading(ctx, s, 'headingFaq')}\n<div class="faq mt-6 text-start">\n${items.join('\n')}\n</div>`,
    true,
  );
}

const AUTOCOMPLETE: Record<string, string> = {
  name: 'name',
  full_name: 'name',
  fullname: 'name',
  first_name: 'given-name',
  last_name: 'family-name',
  company: 'organization',
  organization: 'organization',
  city: 'address-level2',
};
const CONTROL = 'w-full rounded-site border border-muted bg-page px-3 py-2.5 text-ink';
function contactForm(ctx: RenderCtx, s: Section): string {
  const form = ctx.forms.get(str(s.props.formId));
  const id = sid(s);
  if (!form) return wrap(s, heading(ctx, s, 'headingContact'), true);
  const intro = E(ctx, s.props.intro);
  const centered = s.style?.align === 'center';
  const fields = form.fields.map((f) => {
    const fid = `f-${id}-${f.name}`;
    const ac =
      f.type === 'email'
        ? 'email'
        : f.type === 'tel'
          ? 'tel'
          : f.type === 'text'
            ? AUTOCOMPLETE[f.name]
            : undefined;
    const req = f.required ? ' required' : '';
    const control =
      f.type === 'textarea'
        ? `<textarea id="${fid}" name="${esc(f.name)}" class="${CONTROL}" rows="5"${req}></textarea>`
        : `<input id="${fid}" name="${esc(f.name)}" class="${CONTROL}" type="${f.type === 'text' || f.type === 'email' || f.type === 'tel' ? f.type : 'text'}"${ac ? ` autocomplete="${ac}"` : ''}${req}>`;
    const star = f.required ? `<span class="req ms-1" aria-hidden="true">*</span>` : '';
    return `<div class="field mb-4 grid gap-1">\n<label for="${fid}" class="font-semibold">${E(ctx, f.label)}${star}</label>\n${control}\n</div>`;
  });
  const action = `${ctx.opts.formsBase}/v1/public/forms/${encodeURIComponent(form.id)}`;
  const body = [
    heading(ctx, s, 'headingContact'),
    intro ? `<p>${intro}</p>` : '',
    `<form class="form mt-6 max-w-xl text-start${centered ? ' mx-auto' : ''}" method="post" action="${esc(action)}" data-status="msg-${id}" data-success="${E(ctx, form.successMessage)}">`,
    ...fields,
    `<div class="hp sr-only" aria-hidden="true">\n<label for="hp-${id}">${esc(UI.hpLabel[ctx.locale])}</label>\n<input id="hp-${id}" name="website_url" type="text" tabindex="-1" autocomplete="off">\n</div>`,
    `<button class="btn ${TW.btn}" type="submit">${E(ctx, form.submitLabel)}</button>`,
    `</form>`,
    `<div class="form-status mt-4 font-semibold" id="msg-${id}" role="status" tabindex="-1"></div>`,
  ]
    .filter(Boolean)
    .join('\n');
  return wrap(s, body, true);
}

function map(ctx: RenderCtx, s: Section): string {
  const address = T(ctx, s.props.address);
  const query = str(s.props.query) || address;
  const link = query
    ? `<p><a href="https://www.openstreetmap.org/search?query=${encodeURIComponent(query.replace(/\n/g, ' '))}" target="_blank" rel="noopener noreferrer">${esc(UI.mapOpen[ctx.locale])}<span class="sr-only"> ${esc(UI.newTab[ctx.locale])}</span></a></p>`
    : '';
  const centered = s.style?.align === 'center';
  const card = `<div class="map-card mt-6 max-w-xl text-start${centered ? ' mx-auto' : ''} ${TW.card}">\n${address ? `<p class="address ${TW.muted}">${esc(address)}</p>\n` : ''}${link}\n</div>`;
  return wrap(s, `${heading(ctx, s, 'headingMap')}\n${card}`, true);
}

function stats(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.stats).map(
    (it) =>
      `<li class="stat py-4">\n<strong class="stat-value block text-4xl font-extrabold leading-none text-primary md:text-5xl in-[.tone-primary]:text-inherit">${esc(str(it.value))}</strong>\n<span class="stat-label mt-1.5 block text-muted in-[.tone-primary]:text-inherit in-[.tone-primary]:opacity-90">${E(ctx, it.label)}</span>\n</li>`,
  );
  return wrap(
    s,
    `${heading(ctx, s, 'headingStats')}\n<ul class="stats-grid mt-6 grid gap-6 text-center grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function cta(ctx: RenderCtx, s: Section): string {
  const p = s.props;
  const link = resolveLink(ctx, p.cta, `section ${s.id} cta`);
  const label = E(ctx, p.ctaLabel) || esc(UI.ctaDefault[ctx.locale]);
  const sub = E(ctx, p.subheading);
  const inner = [
    `<h2 id="h-${sid(s)}" class="${TW.h2}">${E(ctx, p.heading)}</h2>`,
    sub ? `<p class="lead ${TW.lead} mx-auto max-w-2xl">${sub}</p>` : '',
    link ? `<p>${anchor(ctx, link, label, `btn ${TW.btn}`)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return wrap(s, `<div class="cta-box mx-auto max-w-3xl py-4">\n${inner}\n</div>`, true);
}

function steps(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.steps).map(
    (it, i) =>
      `<li class="step rounded-site border border-line bg-page p-6 text-ink shadow-card">\n<span class="step-num mb-3.5 inline-flex size-10 items-center justify-center rounded-full bg-primary font-extrabold text-on-primary" aria-hidden="true">${esc(formatNumber(String(i + 1), ctx.locale))}</span>\n<h3 class="${TW.h3}">${E(ctx, it.title)}</h3>\n<p class="mb-0 ${TW.muted}">${E(ctx, it.text)}</p>\n</li>`,
  );
  return wrap(
    s,
    `${heading(ctx, s, 'headingSteps')}\n<ol class="steps-list mt-6 grid gap-6 grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]" role="list">\n${items.join('\n')}\n</ol>`,
    true,
  );
}

const RENDERERS: Record<SectionType, (ctx: RenderCtx, s: Section) => string> = {
  hero,
  text: textSection,
  image: imageSection,
  gallery,
  features,
  pricing,
  testimonials,
  faq,
  contact_form: contactForm,
  map,
  stats,
  cta,
  steps,
};

/** The other background than the previous section's, unless the next section explicitly asks for that very one (then keep the previous, so the explicit band stands out). */
function alternate(prev: string, next: Section | undefined): string {
  const want = prev === 'default' ? 'muted' : 'default';
  return next?.style?.background === want ? prev : want;
}

/**
 * The background a section gets. An explicit choice (`style.background`) always wins. Otherwise the page keeps a rhythm of its own: a hero starts on the page
 * background, a call to action is a primary band, and every other section alternates between the page background and the muted one, so two neighbouring
 * sections never melt into each other.
 */
export function effectiveBackground(sections: Section[], index: number): string {
  let prev = 'default';
  let bg = 'default';
  sections.slice(0, index + 1).forEach((x) => {
    const explicit = x.style?.background;
    bg = BACKGROUNDS.has(explicit ?? '')
      ? explicit!
      : x.type === 'cta'
        ? 'primary'
        : x.type === 'hero'
          ? 'default'
          : alternate(prev, sections[sections.indexOf(x) + 1]);
    prev = bg;
  });
  return bg;
}

/** Render one section (a `<section>` element). Unknown types render nothing: the model is validated before rendering. */
export function renderSection(ctx: RenderCtx, s: Section): string {
  const fn = RENDERERS[s.type];
  if (!fn) return '';
  const i = ctx.page.sections.findIndex((x) => x.id === s.id);
  const bg =
    i >= 0 ? effectiveBackground(ctx.page.sections, i) : (s.style?.background ?? 'default');
  return fn(ctx, {
    ...s,
    style: { ...s.style, background: bg as 'default' | 'muted' | 'primary' },
  });
}
