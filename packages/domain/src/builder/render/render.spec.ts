import { describe, expect, it } from 'vitest';
import { validateSiteModel, type SiteModel } from '../site-model';
import {
  manyPages,
  minimalModel,
  richModel,
  singleLocale,
  UPLOAD_BYTES,
  UPLOAD_HASH,
} from './fixtures';
import { csp, renderSite, seoReport, type RenderResult } from './index';
import { checkAltText, checkLinks, lintPhysicalDirectionCss, validateHtml } from './validate';

const assetBytes = { [UPLOAD_HASH]: UPLOAD_BYTES };
const read = (r: RenderResult, path: string): string => {
  const f = r.files.find((x) => x.path === path);
  if (!f) throw new Error(`no file ${path}`);
  return f.content as string;
};
const has = (r: RenderResult, path: string) => r.files.some((f) => f.path === path);
const htmlFiles = (r: RenderResult) => r.files.filter((f) => f.path.endsWith('.html'));

const matrix: [string, SiteModel][] = [
  ['rich ar+en', richModel()],
  ['rich ar-only', singleLocale(richModel(), 'ar')],
  ['rich en-only', singleLocale(richModel(), 'en')],
  ['minimal ar+en', minimalModel()],
  ['minimal ar-only', { ...minimalModel(), locales: ['ar'], defaultLocale: 'ar' }],
];

describe('fixture matrix', () => {
  it.each(matrix)('%s is a valid model', (_n, m) => {
    expect(validateSiteModel(m)).toEqual([]);
  });

  it.each(matrix)('%s renders without problems', (_n, m) => {
    const r = renderSite(m, { assetBytes });
    // `info` issues (no absolute baseUrl) are not defects
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    for (const f of htmlFiles(r)) {
      const html = f.content as string;
      expect(validateHtml(html), f.path).toEqual([]);
      expect(checkAltText(html), f.path).toEqual([]);
    }
    expect(checkLinks(r.files)).toEqual([]);
    expect(lintPhysicalDirectionCss(read(r, 'assets/styles.css'))).toEqual([]);
  });

  it('the rich fixture with a base URL has no issues at all', () => {
    expect(renderSite(richModel(), { assetBytes }).issues).toEqual([]);
  });

  it.each(matrix)('%s: lang/dir per locale and file layout', (_n, m) => {
    const r = renderSite(m, { assetBytes });
    expect(has(r, 'index.html')).toBe(true);
    for (const l of m.locales)
      for (const p of m.pages) {
        const path = p.slug === 'home' ? `${l}/index.html` : `${l}/${p.slug}/index.html`;
        const html = read(r, path);
        expect(html).toContain(`<html lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}">`);
        expect(r.pages).toContainEqual(expect.objectContaining({ pageId: p.id, locale: l, path }));
      }
    expect(r.pages).toHaveLength(m.locales.length * m.pages.length);
  });

  it('the root page redirects to the default locale without JS', () => {
    const r = renderSite(richModel(), { assetBytes });
    const html = read(r, 'index.html');
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=/ar/">');
    expect(html).toContain('<a href="/ar/">');
    expect(html).not.toContain('<script');
    const en = renderSite({ ...richModel(), defaultLocale: 'en' }, { assetBytes });
    expect(read(en, 'index.html')).toContain('url=/en/');
    expect(read(en, 'index.html')).toContain('lang="en" dir="ltr"');
  });

  it('is deterministic: same input, byte-identical output', () => {
    const a = renderSite(richModel(), { assetBytes });
    const b = renderSite(richModel(), { assetBytes });
    expect(b.files.map((f) => f.path)).toEqual(a.files.map((f) => f.path));
    for (const f of a.files) {
      const g = b.files.find((x) => x.path === f.path)!;
      expect(typeof g.content === 'string' ? g.content : Array.from(g.content)).toEqual(
        typeof f.content === 'string' ? f.content : Array.from(f.content),
      );
    }
  });

  it('renders 10 extra pages x 2 locales in well under 500 ms', () => {
    const m = manyPages(10);
    expect(validateSiteModel(m)).toEqual([]);
    renderSite(m, { assetBytes }); // warm up
    const t = performance.now();
    const r = renderSite(m, { assetBytes });
    const ms = performance.now() - t;
    expect(r.pages).toHaveLength(26);
    expect(r.issues).toEqual([]);
    expect(ms).toBeLessThan(500);
  });
});

describe('structure and accessibility of the generated pages', () => {
  const r = renderSite(richModel(), { assetBytes });
  const home = read(r, 'ar/index.html');
  const about = read(r, 'en/about/index.html');

  it('has skip link, banner, nav with aria-current, language switcher, main, footer', () => {
    expect(home).toContain('<a class="skip" href="#main">');
    expect(home).toContain('<header class="site-header">');
    expect(home).toContain('<nav aria-label="التنقل الرئيسي">');
    expect(home).toContain('<a href="/ar/" aria-current="page">');
    expect(home).toContain('<a class="lang" href="/en/" lang="en" hreflang="en"');
    expect(about).toContain('<a class="lang" href="/ar/about/" lang="ar" hreflang="ar"');
    expect(about).toContain('<a href="/en/about/" aria-current="page">About</a>');
    expect(home).toContain('<main id="main">');
    expect(home).toContain('<footer class="site-footer">');
  });
  it('nav label falls back to the page title', () => {
    expect(home).toContain('<a href="/ar/contact/">تواصل معنا</a>');
  });
  it('uses exactly one h1: the first hero, otherwise the page title', () => {
    expect(home.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(home).toContain('<h1 id="h-hero1">');
    expect(about.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(about).toContain('<h1>About us</h1>');
  });
  it('a hero that is not the first section becomes an h2', () => {
    const m = richModel();
    const home0 = m.pages[0]!;
    home0.sections = [home0.sections[1]!, home0.sections[0]!, ...home0.sections.slice(2)];
    const out = renderSite(m, { assetBytes });
    expect(out.issues).toEqual([]);
    const html = read(out, 'en/index.html');
    expect(html).toContain('<h1>Home</h1>');
    expect(html).toContain('<h2 id="h-hero1">Welcome to Palm</h2>');
  });
  it('the contact form is accessible and carries a honeypot', () => {
    const html = read(r, 'en/contact/index.html');
    expect(html).toContain('<form class="form" method="post" action="/v1/public/forms/contact"');
    for (const f of ['name', 'email', 'phone', 'message'])
      expect(html).toContain(`<label for="f-form1-${f}">`);
    expect(html).toMatch(
      /<input id="f-form1-email" name="email" type="email" autocomplete="email" required>/,
    );
    expect(html).toMatch(/<input id="f-form1-phone" name="phone" type="tel" autocomplete="tel">/);
    expect(html).toContain(
      '<textarea id="f-form1-message" name="message" rows="5" required></textarea>',
    );
    expect(html).toContain('<div class="hp" aria-hidden="true">');
    expect(html).toContain('name="website_url" type="text" tabindex="-1" autocomplete="off"');
    expect(html).toContain('role="status"');
  });
  it('form action honours formsBaseUrl and a trailing slash', () => {
    const out = renderSite(richModel(), { assetBytes, formsBaseUrl: 'https://forms.example.com/' });
    expect(read(out, 'en/contact/index.html')).toContain(
      'action="https://forms.example.com/v1/public/forms/contact"',
    );
    expect(() =>
      renderSite(richModel(), { assetBytes, formsBaseUrl: 'javascript:alert(1)' }),
    ).toThrow(RangeError);
    expect(() => renderSite(richModel(), { assetBytes, formsBaseUrl: 'ftp://x.example' })).toThrow(
      RangeError,
    );
  });
  it('the map is a link card, never an iframe', () => {
    const html = read(r, 'en/contact/index.html');
    expect(html).not.toContain('<iframe');
    expect(html).toContain(
      'href="https://www.openstreetmap.org/search?query=King%20Fahd%20Road%20Riyadh"',
    );
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('(opens in a new tab)');
  });
  it('faq uses native details/summary', () => {
    expect(home).toContain('<details class="qa">');
    expect(home).toContain('<summary>');
  });
  it('images: alt always, size attributes, lazy except the first', () => {
    const imgs = home.match(/<img [^>]*>/g)!;
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) expect(i).toMatch(/ alt="[^"]+"/);
    const content = imgs.filter((i) => !i.includes('class="logo"'));
    expect(content[0]).not.toContain('loading=');
    const aboutImgs = read(r, 'ar/about/index.html')
      .match(/<img [^>]*>/g)!
      .filter((i) => !i.includes('class="logo"'));
    expect(aboutImgs[0]).toContain('width="800" height="600"');
    expect(aboutImgs[0]).not.toContain('loading=');
    for (const i of aboutImgs.slice(1)) expect(i).toContain('loading="lazy"');
  });
  it('pricing digits: Arabic-Indic in ar, Latin in en; machine-readable value kept', () => {
    expect(home).toContain('<data class="amount" value="1200.50">١٬٢٠٠٫٥٠</data>');
    expect(read(r, 'en/index.html')).toContain(
      '<data class="amount" value="1200.50">1,200.50</data>',
    );
    expect(read(r, 'en/index.html')).toContain('<span class="cur">SAR</span>');
    expect(home).toContain('<span class="cur">ر.س</span>');
    expect(read(r, 'en/index.html')).toContain('<span class="cur">USD</span>');
  });
  it('section ids are s-{id} and style options become classes, never inline styles', () => {
    expect(home).toContain('<section id="s-feat" class="sec sec-features bg-muted align-center"');
    expect(home).not.toMatch(/\sstyle=/);
  });
  it('emits site.js without eval, dynamic code or HTML injection', () => {
    const js = read(r, 'assets/site.js');
    for (const bad of [
      'eval(',
      'new Function',
      'innerHTML',
      'document.write',
      'setTimeout(',
      'outerHTML',
    ])
      expect(js).not.toContain(bad);
    expect(js).toContain('aria-expanded');
    expect(js).toContain('fetch(');
    expect(js).toContain('form.submit()');
  });
  it('tokens become CSS custom properties', () => {
    const css = read(r, 'assets/styles.css');
    expect(css).toContain('--c-primary: #0f766e;');
    expect(css).toContain('--radius: 0.5rem;');
    expect(css).toContain('--width: 68rem;');
    const m = richModel();
    m.tokens = { radius: 'lg', spacing: 'relaxed', fontFamily: 'serif', width: 'wide' };
    const css2 = read(renderSite(m, { assetBytes }), 'assets/styles.css');
    expect(css2).toContain('--radius: 1rem;');
    expect(css2).toContain('--space: 5rem;');
    expect(css2).toContain('--width: 84rem;');
    expect(css2).toContain('Georgia');
  });
  it('preview mode adds a banner and noindex', () => {
    const out = renderSite(richModel(), { assetBytes, previewBanner: true });
    const html = read(out, 'en/index.html');
    expect(html).toContain('class="preview-banner" role="note"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(out.issues).toEqual([]);
  });
});

describe('assets', () => {
  it('generates placeholder SVGs with the escaped label and no script', () => {
    const m = richModel();
    m.assets[1]!.label = '<script>alert(1)</script> & "x"';
    const r = renderSite(m, { assetBytes });
    const svg = read(r, 'assets/hero.svg');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(svg).not.toContain('<script');
    expect(r.files.find((f) => f.path === 'assets/hero.svg')!.mime).toBe('image/svg+xml');
  });
  it('emits uploads content-addressed from assetBytes, else reports missing bytes', () => {
    const ok = renderSite(richModel(), { assetBytes });
    const f = ok.files.find((x) => x.path === `assets/${UPLOAD_HASH}.png`)!;
    expect(f.mime).toBe('image/png');
    expect(f.content).toBe(UPLOAD_BYTES);
    const missing = renderSite(richModel());
    expect(missing.issues.filter((i) => i.code === 'missing_asset_bytes')).toHaveLength(1);
    expect(has(missing, `assets/${UPLOAD_HASH}.png`)).toBe(false);
  });
});

describe('SEO outputs: presence and absence rules', () => {
  it('with a base URL: canonical, hreflang (+x-default), Open Graph, sitemap, robots', () => {
    const r = renderSite(richModel(), { assetBytes });
    const html = read(r, 'en/about/index.html');
    expect(html).toContain('<link rel="canonical" href="https://palm.example.com/en/about/">');
    expect(html).toContain(
      '<link rel="alternate" hreflang="ar" href="https://palm.example.com/ar/about/">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="en" href="https://palm.example.com/en/about/">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://palm.example.com/ar/about/">',
    );
    for (const p of ['og:title', 'og:description', 'og:type', 'og:locale', 'og:url', 'og:image'])
      expect(html).toContain(`property="${p}"`);
    expect(html).toContain(`content="https://palm.example.com/assets/${UPLOAD_HASH}.png"`);
    const sitemap = read(r, 'sitemap.xml');
    expect(sitemap.match(/<loc>/g)).toHaveLength(6);
    expect(sitemap).toContain('<loc>https://palm.example.com/ar/</loc>');
    expect(sitemap).toContain('hreflang="x-default"');
    expect(read(r, 'robots.txt')).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://palm.example.com/sitemap.xml\n',
    );
  });
  it('without a base URL: none of them, and an info issue', () => {
    const m = richModel();
    delete m.seo.baseUrl;
    const r = renderSite(m, { assetBytes });
    const html = read(r, 'en/index.html');
    for (const s of ['rel="canonical"', 'hreflang="x-default"', 'og:title', 'og:image'])
      expect(html).not.toContain(s);
    expect(has(r, 'sitemap.xml')).toBe(false);
    expect(has(r, 'robots.txt')).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ code: 'no_base_url', severity: 'info' })]);
  });
  it('the baseUrl option overrides the model and is validated', () => {
    const r = renderSite(richModel(), { assetBytes, baseUrl: 'https://other.example.org/site/' });
    expect(read(r, 'en/index.html')).toContain('href="https://other.example.org/site/en/"');
    expect(() =>
      renderSite(richModel(), { assetBytes, baseUrl: 'http://insecure.example' }),
    ).toThrow(RangeError);
    const m = minimalModel();
    const r2 = renderSite(m, { baseUrl: 'https://min.example.com' });
    expect(has(r2, 'sitemap.xml')).toBe(true);
    expect(r2.issues).toEqual([]);
  });
  it('noindex pages: robots meta, excluded from the sitemap', () => {
    const m = richModel();
    m.pages[1]!.seo = { noindex: true };
    const r = renderSite(m, { assetBytes });
    expect(read(r, 'en/about/index.html')).toContain('<meta name="robots" content="noindex">');
    expect(read(r, 'en/index.html')).not.toContain('name="robots"');
    const sitemap = read(r, 'sitemap.xml');
    expect(sitemap).not.toContain('/about/');
    expect(sitemap.match(/<loc>/g)).toHaveLength(4);
  });
  it('og:image only for uploaded raster images', () => {
    const m = richModel();
    delete m.seo.ogImageAssetId;
    const r = renderSite(m, { assetBytes });
    expect(read(r, 'en/index.html')).not.toContain('og:image');
    expect(read(r, 'en/about/index.html')).not.toContain('og:image'); // about has the photo, but not as hero/og/logo
  });
  it('title and description rules', () => {
    const r = renderSite(richModel(), { assetBytes });
    expect(read(r, 'en/index.html')).toContain('<title>Palm Restaurant | Oriental Food</title>');
    expect(read(r, 'en/about/index.html')).toContain(
      '<title>About us | Palm Restaurant | Oriental Food</title>',
    );
    expect(read(r, 'en/index.html')).toContain('content="The freshest oriental dishes in town"');
    expect(read(r, 'en/about/index.html')).toContain('content="Palm Restaurant serves fresh');
    const m = richModel();
    m.pages[1]!.seo = { title: { ar: 'عنوان خاص', en: 'Custom title' } };
    expect(read(renderSite(m, { assetBytes }), 'en/about/index.html')).toContain(
      '<title>Custom title</title>',
    );
  });
  it('JSON-LD: organization on home, Product+Offer for plans, valid and safe', () => {
    const r = renderSite(richModel(), { assetBytes });
    const blocks = (html: string) =>
      [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
        JSON.parse(m[1]!),
      );
    const home = blocks(read(r, 'en/index.html'));
    expect(home).toHaveLength(1);
    const graph = home[0]['@graph'];
    expect(home[0]['@context']).toBe('https://schema.org');
    expect(graph[0]).toMatchObject({
      '@type': 'Restaurant',
      name: 'Palm Restaurant',
      telephone: '+966 11 000 0000',
      email: 'hello@palm.example.com',
      url: 'https://palm.example.com/en/',
      address: { '@type': 'PostalAddress', streetAddress: 'King Fahd Road, Riyadh' },
      geo: { '@type': 'GeoCoordinates', latitude: 24.7136, longitude: 46.6753 },
      openingHours: ['Mo-Su 10:00-23:00'],
    });
    expect(graph[1]).toMatchObject({
      '@type': 'Product',
      name: 'Family',
      offers: { '@type': 'Offer', price: '1200.50', priceCurrency: 'SAR' },
    });
    expect(graph[2].offers.priceCurrency).toBe('USD');
    expect(blocks(read(r, 'en/about/index.html'))).toEqual([]);
    expect(blocks(read(r, 'en/contact/index.html'))).toEqual([]);
  });
  it('JSON-LD omits url without a base URL and is absent without organization or plans', () => {
    const m = richModel();
    delete m.seo.baseUrl;
    expect(read(renderSite(m, { assetBytes }), 'en/index.html')).not.toContain('"url"');
    const bare = minimalModel();
    expect(read(renderSite(bare), 'en/index.html')).not.toContain('ld+json');
  });
});

describe('contrast handling', () => {
  it('repairs a failing text colour and reports a warning', () => {
    const m = richModel();
    m.brand.colors = { primary: '#0f766e', text: '#bbbbbb', background: '#ffffff' };
    const r = renderSite(m, { assetBytes });
    const w = r.issues.filter((i) => i.code === 'contrast');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(read(r, 'assets/styles.css')).toContain('--c-text: #000000;');
  });
  it('picks black or white on primary automatically', () => {
    const m = richModel();
    m.brand.colors = { primary: '#ffeb3b' };
    expect(read(renderSite(m, { assetBytes }), 'assets/styles.css')).toContain(
      '--c-on-primary: #000000;',
    );
    m.brand.colors = { primary: '#1a237e' };
    expect(read(renderSite(m, { assetBytes }), 'assets/styles.css')).toContain(
      '--c-on-primary: #ffffff;',
    );
  });
  it('a dark theme (light text on dark background) is accepted without warnings', () => {
    const m = richModel();
    m.brand.colors = { primary: '#38bdf8', background: '#0b1220', text: '#e5e7eb' };
    const r = renderSite(m, { assetBytes });
    expect(r.issues).toEqual([]);
  });
});

describe('input handling', () => {
  it('throws on an invalid model', () => {
    const m = richModel();
    m.pages[0]!.sections[0]!.props = { heading: { ar: 'x' } };
    expect(() => renderSite(m)).toThrow(/Invalid site model/);
    expect(() => renderSite({} as SiteModel)).toThrow(/Invalid site model/);
  });
  it('does not mutate the model', () => {
    const m = richModel();
    const before = JSON.stringify(m);
    renderSite(m, { assetBytes });
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('csp', () => {
  it('forbids inline script/style and external framing hooks', () => {
    const v = csp(richModel());
    expect(v).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'",
    );
    expect(v).not.toContain('unsafe-inline');
    expect(v).not.toContain('frame-ancestors');
  });
  it('adds the forms origin only for an absolute forms URL and a model with a form', () => {
    const v = csp(richModel(), { formsBaseUrl: 'https://forms.example.com/api' });
    expect(v).toContain("form-action 'self' https://forms.example.com;");
    expect(v).toContain("connect-src 'self' https://forms.example.com;");
    expect(csp(richModel(), { formsBaseUrl: '' })).not.toContain('connect-src');
    expect(csp(minimalModel(), { formsBaseUrl: 'https://forms.example.com' })).not.toContain(
      'forms.example.com',
    );
  });
});

describe('seoReport', () => {
  it('scores a complete model higher than a bare one, with bilingual messages', () => {
    const full = richModel();
    full.pages[1]!.seo = { description: { ar: 'وصف صفحة من نحن', en: 'About page description' } };
    full.pages[2]!.seo = {
      description: { ar: 'وصف صفحة التواصل', en: 'Contact page description' },
    };
    const r = renderSite(full, { assetBytes });
    const good = seoReport(full, r);
    const bare = seoReport(minimalModel());
    expect(good.score).toBeGreaterThan(bare.score);
    expect(good.score).toBeGreaterThanOrEqual(90);
    expect(bare.score).toBeLessThan(70);
    for (const c of [...good.checks, ...bare.checks]) {
      expect(c.id).toMatch(/^[a-z-]+$/);
      expect(c.message.ar.length).toBeGreaterThan(5);
      expect(c.message.en.length).toBeGreaterThan(5);
      expect(c.message.ar).not.toBe(c.message.en);
    }
    expect(new Set(good.checks.map((c) => c.id)).size).toBe(good.checks.length);
  });
  it('flags the specific missing items', () => {
    const m = minimalModel();
    const ids = Object.fromEntries(seoReport(m).checks.map((c) => [c.id, c.ok]));
    expect(ids).toMatchObject({
      'base-url': false,
      sitemap: false,
      organization: false,
      'og-image': false,
      'site-description': false,
    });
    expect(ids['headings']).toBe(true);
  });
  it('is model-only without a result and uses the generated files with one', () => {
    const m = richModel();
    delete m.seo.baseUrl;
    const withResult = seoReport(m, renderSite(m, { assetBytes }));
    expect(withResult.checks.find((c) => c.id === 'sitemap')!.ok).toBe(false);
    expect(withResult.checks.find((c) => c.id === 'hreflang')!.ok).toBe(false);
    const full = seoReport(richModel(), renderSite(richModel(), { assetBytes }));
    expect(full.checks.find((c) => c.id === 'sitemap')!.ok).toBe(true);
    expect(full.checks.find((c) => c.id === 'structured-data')!.ok).toBe(true);
  });
  it('score is an integer in 0..100', () => {
    for (const [, m] of matrix) {
      const s = seoReport(m).score;
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});
