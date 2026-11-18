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

/** Wraps section content: `<section id="s-…">`; `labelled` links aria-labelledby to the heading `h-…`. */
function wrap(s: Section, inner: string, labelled: boolean, extra = ''): string {
  const id = sid(s);
  const bg = BACKGROUNDS.has(s.style?.background ?? '') ? s.style?.background : 'default';
  const align = ALIGNS.has(s.style?.align ?? '') ? s.style?.align : 'start';
  const type = TYPES.has(s.type) ? s.type : 'text';
  return `<section id="s-${id}" class="sec sec-${type} bg-${bg} align-${align}${extra}"${labelled ? ` aria-labelledby="h-${id}"` : ''}>\n<div class="wrap">\n${inner}\n</div>\n</section>`;
}

/** H2 of a section: visible when the model gives a heading, else visually hidden with a default so list sections always have a name. */
function heading(ctx: RenderCtx, s: Section, fallback: keyof typeof UI | null): string {
  const given = E(ctx, s.props.heading);
  if (given) return `<h2 id="h-${sid(s)}">${given}</h2>`;
  if (!fallback) return '';
  return `<h2 id="h-${sid(s)}" class="sr-only">${esc(UI[fallback][ctx.locale])}</h2>`;
}

function hero(ctx: RenderCtx, s: Section): string {
  const p = s.props;
  const isH1 = ctx.state.heroH1 && ctx.page.sections[0]?.id === s.id;
  const tag = isH1 ? 'h1' : 'h2';
  const link = resolveLink(ctx, p.cta, `section ${s.id} cta`);
  const label = E(ctx, p.ctaLabel) || esc(UI.ctaDefault[ctx.locale]);
  const image = renderImage(ctx, p.imageAssetId);
  const sub = E(ctx, p.subheading);
  const copy = [
    `<${tag} id="h-${sid(s)}">${E(ctx, p.heading)}</${tag}>`,
    sub ? `<p class="lead">${sub}</p>` : '',
    link ? `<p>${anchor(ctx, link, label, 'btn')}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const inner = `<div class="hero-grid${image ? ' has-media' : ''}">\n<div class="hero-copy">\n${copy}\n</div>${image ? `\n<div class="hero-media">\n${image}\n</div>` : ''}\n</div>`;
  return wrap(s, inner, true);
}

function textSection(ctx: RenderCtx, s: Section): string {
  const h = heading(ctx, s, null);
  return wrap(s, [h, paragraphs(T(ctx, s.props.body))].filter(Boolean).join('\n'), h !== '');
}

function imageSection(ctx: RenderCtx, s: Section): string {
  const cap = E(ctx, s.props.caption);
  const img = renderImage(ctx, s.props.assetId);
  return wrap(
    s,
    `<figure class="fig">\n${img}${cap ? `\n<figcaption>${cap}</figcaption>` : ''}\n</figure>`,
    false,
  );
}

function gallery(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.images).map((it) => {
    const cap = E(ctx, it.caption);
    return `<li>\n<figure>\n${renderImage(ctx, it.assetId)}${cap ? `\n<figcaption>${cap}</figcaption>` : ''}\n</figure>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingGallery')}\n<ul class="gallery grid" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function features(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map((it) => {
    const icon = str(it.icon);
    return `<li class="card">\n${icon ? `<span class="icon" aria-hidden="true">${esc(icon)}</span>\n` : ''}<h3>${E(ctx, it.title)}</h3>\n<p>${E(ctx, it.text)}</p>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingFeatures')}\n<ul class="cards grid" role="list">\n${items.join('\n')}\n</ul>`,
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
    return `<li class="card plan">\n<h3>${E(ctx, pl.name)}</h3>\n<p class="price"><data class="amount" value="${esc(price)}">${esc(formatNumber(price, ctx.locale))}</data><span class="cur">${esc(curLabel)}</span>${period ? `<span class="period">${period}</span>` : ''}</p>${desc ? `\n<p>${desc}</p>` : ''}\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingPricing')}\n<ul class="cards grid" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function testimonials(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map((it) => {
    const role = E(ctx, it.role);
    return `<li class="card">\n<figure>\n<blockquote><p>${E(ctx, it.quote)}</p></blockquote>\n<figcaption><cite class="author">${esc(str(it.author))}</cite>${role ? `<span class="role">${role}</span>` : ''}</figcaption>\n</figure>\n</li>`;
  });
  return wrap(
    s,
    `${heading(ctx, s, 'headingTestimonials')}\n<ul class="cards grid" role="list">\n${items.join('\n')}\n</ul>`,
    true,
  );
}

function faq(ctx: RenderCtx, s: Section): string {
  const items = list(s.props.items).map(
    (it) =>
      `<details class="qa">\n<summary>${E(ctx, it.question)}</summary>\n${paragraphs(T(ctx, it.answer))}\n</details>`,
  );
  return wrap(
    s,
    `${heading(ctx, s, 'headingFaq')}\n<div class="faq">\n${items.join('\n')}\n</div>`,
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
function contactForm(ctx: RenderCtx, s: Section): string {
  const form = ctx.forms.get(str(s.props.formId));
  const id = sid(s);
  if (!form) return wrap(s, heading(ctx, s, 'headingContact'), true);
  const intro = E(ctx, s.props.intro);
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
        ? `<textarea id="${fid}" name="${esc(f.name)}" rows="5"${req}></textarea>`
        : `<input id="${fid}" name="${esc(f.name)}" type="${f.type === 'text' || f.type === 'email' || f.type === 'tel' ? f.type : 'text'}"${ac ? ` autocomplete="${ac}"` : ''}${req}>`;
    const star = f.required ? `<span class="req" aria-hidden="true">*</span>` : '';
    return `<div class="field">\n<label for="${fid}">${E(ctx, f.label)}${star}</label>\n${control}\n</div>`;
  });
  const action = `${ctx.opts.formsBase}/v1/public/forms/${encodeURIComponent(form.id)}`;
  const body = [
    heading(ctx, s, 'headingContact'),
    intro ? `<p>${intro}</p>` : '',
    `<form class="form" method="post" action="${esc(action)}" data-status="msg-${id}" data-success="${E(ctx, form.successMessage)}">`,
    ...fields,
    `<div class="hp" aria-hidden="true">\n<label for="hp-${id}">${esc(UI.hpLabel[ctx.locale])}</label>\n<input id="hp-${id}" name="website_url" type="text" tabindex="-1" autocomplete="off">\n</div>`,
    `<button class="btn" type="submit">${E(ctx, form.submitLabel)}</button>`,
    `</form>`,
    `<div class="form-status" id="msg-${id}" role="status" tabindex="-1"></div>`,
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
  const card = `<div class="card map-card">\n${address ? `<p class="address">${esc(address)}</p>\n` : ''}${link}\n</div>`;
  return wrap(s, `${heading(ctx, s, 'headingMap')}\n${card}`, true);
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
};

/** Render one section (a `<section>` element). Unknown types render nothing: the model is validated before rendering. */
export function renderSection(ctx: RenderCtx, s: Section): string {
  const fn = RENDERERS[s.type];
  return fn ? fn(ctx, s) : '';
}
