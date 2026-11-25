import type { Asset, Locale, Page, SiteModel } from '../site-model';
import { clean, esc } from './text';

export const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{2,5})?(\/[A-Za-z0-9._~/-]*)?$/;
export const FORMS_BASE_RE = /^(https?:\/\/[A-Za-z0-9.-]+(:[0-9]{2,5})?(\/[A-Za-z0-9._~/-]*)?)?$/;

/** URL path of a page: `/{locale}/` for home, else `/{locale}/{slug}/`. */
export const pagePath = (locale: Locale, slug: string): string =>
  slug === 'home' ? `/${locale}/` : `/${locale}/${slug}/`;
/** File path (relative, no leading slash) of a page. */
export const pageFile = (locale: Locale, slug: string): string =>
  `${pagePath(locale, slug).slice(1)}index.html`;

export const stripSlash = (u: string): string => u.replace(/\/+$/, '');

/** The absolute base URL in effect (option wins over the model), without trailing slash; throws on a malformed option. */
export function resolveBaseUrl(model: SiteModel, optBase?: string): string | undefined {
  const v = optBase ?? model.seo.baseUrl;
  if (v === undefined) return undefined;
  if (!BASE_URL_RE.test(v)) throw new RangeError('baseUrl must be an absolute https URL');
  return stripSlash(v);
}

export const text = (v: { ar?: string; en?: string } | undefined, l: Locale): string =>
  clean(v?.[l] ?? '');

export function pageTitle(model: SiteModel, page: Page, l: Locale): string {
  const own = page.seo?.title?.[l];
  if (own && own.trim() !== '') return clean(own);
  const site = text(model.seo.siteTitle, l);
  return page.slug === 'home' ? site : `${text(page.title, l)} | ${site}`;
}
export function pageDescription(model: SiteModel, page: Page, l: Locale): string {
  const own = page.seo?.description?.[l];
  return own && own.trim() !== '' ? clean(own) : text(model.seo.description, l);
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
/** Relative file path of an asset in the output. Placeholders are generated SVGs, uploads are content-addressed. */
export function assetPath(a: Asset): string {
  if (a.source === 'upload' && a.contentHash && a.mime)
    return `assets/${a.contentHash}.${EXT[a.mime]}`;
  return `assets/${a.id}.svg`;
}
const PLACEHOLDER_SIZE = { w: 1200, h: 675 };
export function assetSize(a: Asset): { w: number; h: number } | undefined {
  if (a.width && a.height) return { w: a.width, h: a.height };
  return a.source === 'placeholder' ? PLACEHOLDER_SIZE : undefined;
}

/** Neutral gradient SVG with the escaped label. No scripts, no external references, no model text outside the escaped label. */
/** The site's favicon: the first letter of the brand name (default locale) on the primary colour. Deterministic, text only (no script, no external reference). */
export function faviconSvg(brandName: string, primary: string, onPrimary: string): string {
  const initial = esc([...brandName.trim()][0] ?? '•');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<rect width="64" height="64" rx="14" fill="${primary}"/>
<text x="32" y="33" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="38" font-weight="700" fill="${onPrimary}">${initial}</text>
</svg>
`;
}

export function placeholderSvg(a: Asset): string {
  const { w, h } = assetSize(a) ?? PLACEHOLDER_SIZE;
  const label = a.label ? esc(a.label) : '';
  const fs = Math.max(12, Math.round(Math.min(w, h) / 14));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e5e7eb"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
${label ? `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${fs}" fill="#334155">${label}</text>` : ''}
</svg>
`;
}
