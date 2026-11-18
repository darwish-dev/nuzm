import type { Locale, Page, SiteModel } from '../site-model';
import { renderImage, renderSection } from './components';
import { dirOf, UI } from './ui';
import { assetPath, pageDescription, pagePath, pageTitle, text } from './common';
import { jsonLd } from './seo';
import { esc } from './text';
import type { RenderCtx, RenderIssue, ResolvedOptions } from './types';

const OG_LOCALE: Record<Locale, string> = { ar: 'ar_SA', en: 'en_US' };

export function makeCtx(
  model: SiteModel,
  locale: Locale,
  page: Page,
  opts: ResolvedOptions,
  issues: RenderIssue[],
): RenderCtx {
  return {
    model,
    locale,
    page,
    opts,
    issues,
    assets: new Map(model.assets.map((a) => [a.id, a])),
    forms: new Map(model.forms.map((f) => [f.id, f])),
    state: { images: 0, heroH1: page.sections[0]?.type === 'hero' },
  };
}

const meta = (name: string, content: string) => `<meta name="${name}" content="${esc(content)}">`;
const og = (prop: string, content: string) => `<meta property="${prop}" content="${esc(content)}">`;

/** `<head>` metadata that depends on an absolute base URL: canonical, hreflang alternates and Open Graph. Empty without one. */
function absoluteHead(ctx: RenderCtx, title: string, description: string): string[] {
  const base = ctx.opts.baseUrl;
  if (!base) return [];
  const { model, locale, page } = ctx;
  const url = (l: Locale) => `${base}${pagePath(l, page.slug)}`;
  const lines = [
    `<link rel="canonical" href="${esc(url(locale))}">`,
    ...model.locales.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(url(l))}">`),
    `<link rel="alternate" hreflang="x-default" href="${esc(url(model.defaultLocale))}">`,
    og('og:title', title),
    og('og:description', description),
    og('og:type', 'website'),
    og('og:site_name', text(model.brand.name, locale)),
    og('og:locale', OG_LOCALE[locale]),
    ...model.locales
      .filter((l) => l !== locale)
      .map((l) => og('og:locale:alternate', OG_LOCALE[l])),
    og('og:url', url(locale)),
  ];
  // social platforms do not render SVG: only uploaded raster images are used as og:image
  const wanted = [
    model.seo.ogImageAssetId,
    ...page.sections.map((s) => s.props.imageAssetId),
    model.brand.logoAssetId,
  ];
  const asset = wanted
    .map((id) => (typeof id === 'string' ? ctx.assets.get(id) : undefined))
    .find((a) => a?.source === 'upload');
  if (asset) {
    lines.push(
      og('og:image', `${base}/${assetPath(asset)}`),
      og('og:image:alt', text(asset.alt, locale)),
      meta('twitter:card', 'summary_large_image'),
    );
  }
  return lines;
}

function header(ctx: RenderCtx): string {
  const { model, locale, page } = ctx;
  const logo = model.brand.logoAssetId
    ? renderImage(ctx, model.brand.logoAssetId, 'logo', false)
    : '';
  const items = model.nav.items
    .map((n) => {
      const target = model.pages.find((p) => p.id === n.pageId);
      if (!target) return '';
      const label = text(n.label, locale) || text(target.title, locale);
      return `<li><a href="${pagePath(locale, target.slug)}"${target.id === page.id ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`;
    })
    .filter(Boolean);
  const other = model.locales.find((l) => l !== locale);
  return [
    `<header class="site-header">`,
    `<div class="wrap bar">`,
    `<a class="brand" href="${pagePath(locale, 'home')}">${logo}<span>${esc(text(model.brand.name, locale))}</span></a>`,
    `<nav aria-label="${esc(UI.navLabel[locale])}">`,
    `<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">${esc(UI.menu[locale])}</button>`,
    `<ul class="nav-list" id="site-nav">\n${items.join('\n')}\n</ul>`,
    `</nav>`,
    other
      ? `<a class="lang" href="${pagePath(other, page.slug)}" lang="${other}" hreflang="${other}" aria-label="${esc(UI.switchLabel[locale])}">${esc(UI.switchTo[other])}</a>`
      : '',
    `</div>`,
    `</header>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function footer(ctx: RenderCtx): string {
  const { model, locale } = ctx;
  const links = (model.footer.links ?? [])
    .map((l) => {
      const target = model.pages.find((p) => p.id === l.pageId);
      return target
        ? `<li><a href="${pagePath(locale, target.slug)}">${esc(text(l.label, locale))}</a></li>`
        : '';
    })
    .filter(Boolean);
  return [
    `<footer class="site-footer">`,
    `<div class="wrap">`,
    `<p>${esc(text(model.footer.text, locale))}</p>`,
    links.length
      ? `<nav aria-label="${esc(UI.footerNav[locale])}">\n<ul>\n${links.join('\n')}\n</ul>\n</nav>`
      : '',
    `</div>`,
    `</footer>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Renders one page in one locale. Returns the complete HTML document and its `<title>`. */
export function renderPage(ctx: RenderCtx): { html: string; title: string } {
  const { model, locale, page } = ctx;
  const title = pageTitle(model, page, locale);
  const description = pageDescription(model, page, locale);
  const noindex = !!page.seo?.noindex || ctx.opts.previewBanner;
  const ld = jsonLd(ctx);
  const sections = page.sections.map((s) => renderSection(ctx, s));
  const pageHead = ctx.state.heroH1
    ? ''
    : `<div class="page-head">\n<div class="wrap">\n<h1>${esc(text(page.title, locale))}</h1>\n</div>\n</div>\n`;
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)}</title>`,
    meta('description', description),
    noindex ? meta('robots', 'noindex') : '',
    ...absoluteHead(ctx, title, description),
    `<link rel="stylesheet" href="/assets/styles.css">`,
    ld ? `<script type="application/ld+json">${ld}</script>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const body = [
    ctx.opts.previewBanner
      ? `<div class="preview-banner" role="note">${esc(UI.preview[locale])}</div>`
      : '',
    `<a class="skip" href="#main">${esc(UI.skip[locale])}</a>`,
    header(ctx),
    `<main id="main">\n${pageHead}${sections.join('\n')}\n</main>`,
    footer(ctx),
    `<script src="/assets/site.js" defer></script>`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    html: `<!doctype html>\n<html lang="${locale}" dir="${dirOf(locale)}">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
    title,
  };
}

/** `index.html`: a tiny no-JS redirect to the default locale. */
export function renderRedirect(model: SiteModel, baseUrl: string | undefined): string {
  const l = model.defaultLocale;
  const target = pagePath(l, 'home');
  const name = text(model.brand.name, l);
  return `<!doctype html>
<html lang="${l}" dir="${dirOf(l)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(text(model.seo.siteTitle, l))}</title>
<meta http-equiv="refresh" content="0; url=${target}">
${baseUrl ? `<link rel="canonical" href="${esc(baseUrl + target)}">\n` : ''}<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<main id="main" class="wrap">
<h1>${esc(name)}</h1>
<p><a href="${target}">${esc(UI.continue[l])}</a></p>
</main>
</body>
</html>
`;
}
