import type { Locale, Page, SiteModel } from '../site-model';
import { pagePath, pageTitle, text } from './common';
import { cleanDeep, esc, jsonSafe } from './text';
import type { RenderCtx, RenderResult } from './types';
import { contrastIssues } from './validate';

const ORG_TYPES = new Set([
  'Organization',
  'LocalBusiness',
  'Restaurant',
  'MedicalClinic',
  'Store',
  'EducationalOrganization',
  'NGO',
]);

/** Origin of an absolute forms base URL, else undefined (relative / same-origin). */
function originOf(u: string | undefined): string | undefined {
  if (!u || !/^https?:\/\//i.test(u)) return undefined;
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

/**
 * Content-Security-Policy of served pages, everything except `frame-ancestors` (the server appends it). The pages need no inline script or style, so
 * both stay 'self'. JSON-LD blocks are data, not script, and need no allowance. `form-action`/`connect-src` name the forms origin only when the model
 * has a contact form and the forms base URL is absolute.
 */
export function csp(model: SiteModel, opts: { formsBaseUrl?: string } = {}): string {
  const hasForm = model.pages.some((p) => p.sections.some((s) => s.type === 'contact_form'));
  const origin = hasForm ? originOf(opts.formsBaseUrl) : undefined;
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    `form-action 'self'${origin ? ` ${origin}` : ''}`,
    ...(origin ? [`connect-src 'self' ${origin}`] : []),
    "base-uri 'none'",
  ].join('; ');
}

/** JSON-LD graph for a page (Organization on the home page, Product+Offer for pricing plans), already serialised and made safe for an inline data block. */
export function jsonLd(ctx: RenderCtx): string | undefined {
  const { model, locale, page } = ctx;
  const base = ctx.opts.baseUrl;
  const graph: Record<string, unknown>[] = [];
  const org = model.seo.organization;
  if (org && page.slug === 'home') {
    const address = text(org.address, locale);
    graph.push({
      '@type': org.type && ORG_TYPES.has(org.type) ? org.type : 'Organization',
      name: org.name,
      ...(base ? { url: `${base}${pagePath(locale, 'home')}` } : {}),
      ...(org.phone ? { telephone: org.phone } : {}),
      ...(org.email ? { email: org.email } : {}),
      ...(address ? { address: { '@type': 'PostalAddress', streetAddress: address } } : {}),
      ...(org.geo
        ? { geo: { '@type': 'GeoCoordinates', latitude: org.geo.lat, longitude: org.geo.lng } }
        : {}),
      ...(org.openingHours?.length ? { openingHours: org.openingHours } : {}),
    });
  }
  for (const s of page.sections) {
    if (s.type !== 'pricing' || !Array.isArray(s.props.plans)) continue;
    for (const pl of s.props.plans as Record<string, unknown>[]) {
      const name = text(pl.name as { ar?: string; en?: string }, locale);
      const price = typeof pl.price === 'string' ? pl.price : '';
      if (!name || !price) continue;
      const desc = text(pl.description as { ar?: string; en?: string } | undefined, locale);
      graph.push({
        '@type': 'Product',
        name,
        ...(desc ? { description: desc } : {}),
        brand: { '@type': 'Brand', name: text(model.brand.name, locale) },
        offers: {
          '@type': 'Offer',
          price,
          priceCurrency:
            typeof pl.currency === 'string' && /^[A-Z]{3}$/.test(pl.currency) ? pl.currency : 'SAR',
          ...(base ? { url: `${base}${pagePath(locale, page.slug)}` } : {}),
        },
      });
    }
  }
  if (graph.length === 0) return undefined;
  return jsonSafe(cleanDeep({ '@context': 'https://schema.org', '@graph': graph }));
}

const indexable = (p: Page) => !p.seo?.noindex;

export function buildSitemap(model: SiteModel, base: string): string {
  const url = (l: Locale, p: Page) => esc(`${base}${pagePath(l, p.slug)}`);
  const entries: string[] = [];
  for (const l of model.locales)
    for (const p of model.pages.filter(indexable)) {
      const alts = [
        ...model.locales.map(
          (a) => `    <xhtml:link rel="alternate" hreflang="${a}" href="${url(a, p)}"/>`,
        ),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${url(model.defaultLocale, p)}"/>`,
      ];
      entries.push(`  <url>\n    <loc>${url(l, p)}</loc>\n${alts.join('\n')}\n  </url>`);
    }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
}

export const buildRobots = (base: string): string =>
  `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;

type Pair = { ar: string; en: string };
interface Check {
  id: string;
  ok: boolean;
  message: Pair;
}
const c = (id: string, ok: boolean, good: Pair, bad: Pair): Check => ({
  id,
  ok,
  message: ok ? good : bad,
});

/**
 * SEO checklist with a 0-100 score (share of passed checks). Pass the render result to also verify the generated output (h1, lang/dir, hreflang,
 * sitemap, JSON-LD); without it the checks are derived from the model alone.
 */
export function seoReport(
  model: SiteModel,
  result?: RenderResult,
): { score: number; checks: { id: string; ok: boolean; message: Pair }[] } {
  const L = model.locales;
  const htmls = (result?.files ?? []).filter(
    (f) => f.path.endsWith('.html') && typeof f.content === 'string' && f.path !== 'index.html',
  );
  const html = (f: { content: string | Uint8Array }) => f.content as string;
  const titlesOk = L.every((l) => {
    const titles = model.pages.map((p) => pageTitle(model, p, l));
    return new Set(titles).size === titles.length && titles.every((t) => t.length <= 60);
  });
  const org = model.seo.organization;
  const orgOk = !!org && !!org.name && !!(org.phone || org.email || org.address);
  const hasPricing = model.pages.some((p) => p.sections.some((s) => s.type === 'pricing'));
  const rasterOg = model.assets.some(
    (a) => a.id === model.seo.ogImageAssetId && a.source === 'upload',
  );
  const base = result ? result.files.some((f) => f.path === 'sitemap.xml') : !!model.seo.baseUrl;
  const linked = new Set([
    ...model.nav.items.map((i) => i.pageId),
    ...(model.footer.links ?? []).map((i) => i.pageId),
  ]);
  const checks: Check[] = [
    c(
      'site-title',
      L.every((l) => {
        const t = text(model.seo.siteTitle, l);
        return t.length > 0 && t.length <= 60;
      }),
      { ar: 'عنوان الموقع موجود وبطول مناسب', en: 'Site title is present and a good length' },
      {
        ar: 'أضف عنوان موقع واضحًا بطول لا يتجاوز 60 حرفًا',
        en: 'Add a clear site title of at most 60 characters',
      },
    ),
    c(
      'site-description',
      L.every((l) => {
        const n = text(model.seo.description, l).length;
        return n >= 50 && n <= 160;
      }),
      {
        ar: 'وصف الموقع بطول مناسب (50 إلى 160 حرفًا)',
        en: 'Site description is 50 to 160 characters',
      },
      {
        ar: 'اجعل وصف الموقع بين 50 و160 حرفًا في كل لغة',
        en: 'Make the site description 50 to 160 characters in every language',
      },
    ),
    c(
      'page-titles',
      titlesOk,
      { ar: 'عناوين الصفحات فريدة وقصيرة', en: 'Page titles are unique and short' },
      {
        ar: 'اجعل عنوان كل صفحة فريدًا وبطول لا يتجاوز 60 حرفًا',
        en: 'Give every page a unique title of at most 60 characters',
      },
    ),
    c(
      'page-descriptions',
      model.pages.filter(indexable).every((p) => L.every((l) => !!p.seo?.description?.[l]?.trim())),
      { ar: 'لكل صفحة وصف خاص بها', en: 'Every page has its own description' },
      { ar: 'أضف وصفًا خاصًا لكل صفحة', en: 'Add a description to every page' },
    ),
    c(
      'base-url',
      !!model.seo.baseUrl,
      { ar: 'عنوان الموقع المطلق (baseUrl) محدد', en: 'The absolute site URL (baseUrl) is set' },
      {
        ar: 'حدد عنوان الموقع المطلق (https) لتفعيل الروابط الأساسية وخريطة الموقع',
        en: 'Set the absolute site URL (https) to enable canonical links and the sitemap',
      },
    ),
    c(
      'hreflang',
      result
        ? htmls.length > 0 && htmls.every((f) => html(f).includes('hreflang="x-default"'))
        : L.length === 1 || !!model.seo.baseUrl,
      {
        ar: 'روابط اللغات البديلة (hreflang) متاحة',
        en: 'Language alternates (hreflang) are present',
      },
      {
        ar: 'تحتاج روابط اللغات البديلة إلى عنوان موقع مطلق',
        en: 'Language alternates (hreflang) need an absolute site URL',
      },
    ),
    c(
      'sitemap',
      base,
      { ar: 'خريطة الموقع (sitemap.xml) تُنشأ', en: 'A sitemap.xml is generated' },
      {
        ar: 'لا يمكن إنشاء خريطة الموقع دون عنوان موقع مطلق',
        en: 'A sitemap cannot be generated without an absolute site URL',
      },
    ),
    c(
      'organization',
      orgOk,
      { ar: 'بيانات المنشأة مكتملة', en: 'Business details are complete' },
      {
        ar: 'أضف اسم المنشأة ووسيلة اتصال أو عنوانًا',
        en: 'Add the business name and a phone, email or address',
      },
    ),
    c(
      'structured-data',
      result ? htmls.some((f) => html(f).includes('application/ld+json')) : orgOk || hasPricing,
      { ar: 'البيانات المنظمة (JSON-LD) متاحة', en: 'Structured data (JSON-LD) is present' },
      {
        ar: 'أضف بيانات المنشأة لتوليد بيانات منظمة',
        en: 'Add business details to generate structured data',
      },
    ),
    c(
      'og-image',
      rasterOg,
      { ar: 'صورة المشاركة الاجتماعية محددة', en: 'A social sharing image is set' },
      {
        ar: 'ارفع صورة للمشاركة الاجتماعية (PNG أو JPEG أو WebP)',
        en: 'Upload a social sharing image (PNG, JPEG or WebP)',
      },
    ),
    c(
      'alt-text',
      model.assets.every((a) => L.every((l) => text(a.alt, l).length >= 3)),
      { ar: 'كل الصور لها نص بديل', en: 'Every image has alt text' },
      { ar: 'أضف نصًا بديلًا وصفيًا لكل صورة', en: 'Add descriptive alt text to every image' },
    ),
    c(
      'headings',
      result ? htmls.every((f) => (html(f).match(/<h1[\s>]/g) ?? []).length === 1) : true,
      { ar: 'لكل صفحة عنوان رئيسي واحد', en: 'Every page has exactly one main heading' },
      {
        ar: 'يجب أن يكون لكل صفحة عنوان رئيسي واحد فقط',
        en: 'Each page must have exactly one main heading',
      },
    ),
    c(
      'lang-dir',
      result ? htmls.every((f) => /<html lang="(ar|en)" dir="(rtl|ltr)">/.test(html(f))) : true,
      { ar: 'لغة الصفحات واتجاهها محددان', en: 'Page language and direction are set' },
      { ar: 'حدد لغة الصفحات واتجاهها', en: 'Set the page language and direction' },
    ),
    c(
      'indexable',
      model.pages.some((p) => p.slug === 'home' && indexable(p)),
      { ar: 'الصفحة الرئيسية قابلة للأرشفة', en: 'The home page can be indexed' },
      {
        ar: 'الصفحة الرئيسية مستثناة من محركات البحث',
        en: 'The home page is excluded from search engines',
      },
    ),
    c(
      'navigation',
      model.pages.every((p) => linked.has(p.id)),
      { ar: 'كل الصفحات متصلة بالتنقل', en: 'Every page is linked from the navigation' },
      {
        ar: 'بعض الصفحات غير مرتبطة بالقائمة أو التذييل',
        en: 'Some pages are not linked from the navigation or footer',
      },
    ),
    c(
      'contrast',
      contrastIssues(model).length === 0,
      { ar: 'تباين الألوان مناسب', en: 'Colour contrast meets WCAG AA' },
      {
        ar: 'تباين لون النص مع الخلفية أقل من المطلوب',
        en: 'Text and background colours are below the required contrast',
      },
    ),
  ];
  const score = Math.round((100 * checks.filter((k) => k.ok).length) / checks.length);
  return { score, checks };
}
