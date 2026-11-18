import { describe, expect, it } from 'vitest';
import { validateSiteModel, type Section, type SiteModel } from '../site-model';
import { renderSection } from './components';
import { buildCss } from './css';
import { richModel, UPLOAD_BYTES, UPLOAD_HASH } from './fixtures';
import { tokenize } from './html-scan';
import { renderSite, type RenderResult } from './index';
import { makeCtx } from './page';
import { computePalette } from './palette';
import { clean, esc, jsonSafe } from './text';
import type { RenderIssue } from './types';
import { validateHtml } from './validate';

const assetBytes = { [UPLOAD_HASH]: UPLOAD_BYTES };
const ASCII_BIDI = /[\u202A-\u202E\u2066-\u2069]/;

/** Hostile strings, all within the tightest model length limits (<= 38 characters). */
const TOXIC = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</script><script>alert(1)//',
  'javascript:alert(1)',
  'a\u202Eevil\u202C b\u2066c\u2069 d',
  '`onerror=alert(1)` &lt;b&gt;',
  '{{7*7}} ${alert(1)} %s \\u003c',
  'x\u2028y\u2029</style><style>*{}',
  '<svg/onload=alert(1)>',
  'a\u0000b\u0007c\u001bd',
];
const toxicAt = (i: number) => TOXIC[i % TOXIC.length]!;

/** The rich model with every free-text field replaced by hostile text (still a valid model). */
function hostileModel(): SiteModel {
  let n = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length > 0 && keys.every((k) => k === 'ar' || k === 'en')) {
      const t = toxicAt(n++);
      return Object.fromEntries(keys.map((k) => [k, t]));
    }
    return Object.fromEntries(keys.map((k) => [k, walk(o[k])]));
  };
  const m = walk(richModel()) as SiteModel;
  m.seo.organization!.name = '</script><script>alert(1)</script>\u2028';
  m.seo.organization!.openingHours = ['"><script>alert(2)</script>'];
  for (const a of m.assets) a.label = '<script>alert(3)</script> & "q"';
  const feat = m.pages[0]!.sections.find((s) => s.type === 'features')!;
  for (const it of feat.props.items as Record<string, unknown>[]) if (it.icon) it.icon = '<b>"&';
  const test = m.pages[1]!.sections.find((s) => s.type === 'testimonials')!;
  for (const it of test.props.items as Record<string, unknown>[])
    it.author = '"><svg onload=alert(4)>';
  const map = m.pages[2]!.sections.find((s) => s.type === 'map')!;
  map.props.query = '"><script>alert(5)</script> & /?#';
  m.forms[0]!.name = '"><script>';
  return m;
}

const textOf = (r: RenderResult) => r.files.filter((f) => typeof f.content === 'string');

describe('hostile (but valid) model text never becomes executable markup', () => {
  const model = hostileModel();
  it('the hostile model is a valid model (the renderer, not validation, must hold)', () => {
    expect(validateSiteModel(model)).toEqual([]);
  });
  const r = renderSite(model, { assetBytes });

  it('renders without issues and every page passes validateHtml', () => {
    expect(r.issues.filter((i: RenderIssue) => i.severity !== 'info')).toEqual([]);
    for (const f of r.files.filter((x) => x.path.endsWith('.html')))
      expect(validateHtml(f.content as string), f.path).toEqual([]);
  });
  it('has no script except the JSON-LD data block and site.js; no handlers; no style attributes', () => {
    for (const f of r.files.filter((x) => x.path.endsWith('.html'))) {
      for (const t of tokenize(f.content as string)) {
        if (t.kind !== 'start') continue;
        expect(t.name, f.path).not.toMatch(/^(iframe|object|embed|style|svg|base)$/);
        for (const a of t.attrs) {
          expect(a.name.startsWith('on'), `${f.path} ${t.name} ${a.name}`).toBe(false);
          expect(a.name).not.toBe('style');
          expect(a.name).toMatch(/^[a-z][a-z0-9:-]*$/);
        }
        if (t.name === 'script')
          expect(
            t.attrs.some((a) => a.name === 'type' && a.value === 'application/ld+json') ||
              t.attrs.some((a) => a.name === 'src' && a.value === '/assets/site.js'),
          ).toBe(true);
        if (t.name === 'img')
          expect(t.attrs.find((a) => a.name === 'src')!.value).toMatch(
            /^\/assets\/[a-z0-9_-]+\.(svg|png)$/,
          );
      }
    }
  });
  it('shows hostile text as escaped text', () => {
    const html = textOf(r).find((f) => f.path === 'en/index.html')!.content as string;
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg/onload');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&#39; onmouseover=&#39;alert(1)');
    expect(html).toContain('&#96;onerror=alert(1)&#96;');
  });
  it('strips bidi override/embedding/isolate controls and control characters everywhere', () => {
    for (const f of textOf(r)) {
      expect(ASCII_BIDI.test(f.content as string), f.path).toBe(false);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000B-\u001F]/.test(f.content as string), f.path).toBe(false);
    }
  });
  it('JSON-LD stays valid JSON with the organization name intact and no raw < > & or line separators', () => {
    const html = textOf(r).find((f) => f.path === 'ar/index.html')!.content as string;
    const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(body).not.toMatch(/[<>&\u2028\u2029]/);
    expect(body).toContain('\\u003c/script\\u003e');
    const data = JSON.parse(body);
    expect(data['@graph'][0].name).toBe('</script><script>alert(1)</script>\u2028');
    expect(data['@graph'][0].openingHours).toEqual(['"><script>alert(2)</script>']);
  });
  it('the map link encodes the hostile query', () => {
    const html = textOf(r).find((f) => f.path === 'en/contact/index.html')!.content as string;
    expect(html).toContain('query=%22%3E%3Cscript%3Ealert(5)%3C%2Fscript%3E%20%26%20%2F%3F%23');
  });
  it('the stylesheet, script and SVGs contain no model text', () => {
    const css = textOf(r).find((f) => f.path === 'assets/styles.css')!.content as string;
    const js = textOf(r).find((f) => f.path === 'assets/site.js')!.content as string;
    for (const bad of ['alert(', '<script', 'onerror']) {
      expect(css).not.toContain(bad);
      expect(js).not.toContain(bad);
    }
    const svg = textOf(r).find((f) => f.path === 'assets/hero.svg')!.content as string;
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;alert(3)&lt;/script&gt; &amp; &quot;q&quot;');
  });
});

describe('defence in depth: the components do not trust a model that skipped validation', () => {
  const m = richModel();
  const home = m.pages[0]!;
  const ctx = () =>
    makeCtx(m, 'en', home, { baseUrl: undefined, formsBase: '', previewBanner: false }, []);
  const hero = (props: Record<string, unknown>, extra: Partial<Section> = {}): Section => ({
    id: 'hx',
    type: 'hero',
    props: { heading: { en: 'H', ar: 'ع' }, ctaLabel: { en: 'Go', ar: 'اذهب' }, ...props },
    ...extra,
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    'https://a.example/"onmouseover="x',
    '/path with space',
    '\\\\evil',
  ])('drops the unsafe CTA URL %s and reports it', (url) => {
    const c = ctx();
    const html = renderSection(c, hero({ cta: { url } }));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(c.issues).toEqual([expect.objectContaining({ code: 'unsafe_url', severity: 'error' })]);
  });
  it('drops a CTA to an unknown page', () => {
    const c = ctx();
    expect(renderSection(c, hero({ cta: { pageId: 'nope' } }))).not.toContain('<a ');
    expect(c.issues).toHaveLength(1);
  });
  it('keeps safe URLs; external ones get rel=noopener noreferrer; #anchors map to section ids', () => {
    const c = ctx();
    expect(renderSection(c, hero({ cta: { url: 'https://a.example/x?y=1&z=2' } }))).toContain(
      'href="https://a.example/x?y=1&amp;z=2" rel="noopener noreferrer"',
    );
    expect(renderSection(c, hero({ cta: { url: 'mailto:a@b.example' } }))).toContain(
      'href="mailto:a@b.example"',
    );
    expect(renderSection(c, hero({ cta: { url: 'tel:+966 11 000 0000' } }))).toContain(
      'href="tel:+966 11 000 0000"',
    );
    expect(renderSection(c, hero({ cta: { url: '#feat' } }))).toContain('href="#s-feat"');
    expect(c.issues).toEqual([]);
  });
  it('refuses ids that are not plain identifiers', () => {
    for (const id of ['a"onmouseover="x', 'A', '1a', 'a b', "a'b", 'a>b', '', 'a'.repeat(41)])
      expect(() => renderSection(ctx(), hero({}, { id }))).toThrow(RangeError);
  });
  it('maps unknown style values to defaults (never into a class name)', () => {
    const html = renderSection(
      ctx(),
      hero({}, { style: { background: 'x" onload="y' as never, align: 'z y' as never } }),
    );
    expect(html).toContain('class="sec sec-hero bg-default align-start"');
    expect(html).not.toContain('onload');
  });
  it('unknown section types render nothing', () => {
    expect(renderSection(ctx(), { id: 'u1', type: 'script' as never, props: {} })).toBe('');
  });
  it('never uses model text as CSS: invalid colours fall back to defaults', () => {
    const bad = richModel();
    bad.brand.colors = {
      primary: 'red;}body{display:none',
      accent: 'url(x)',
      background: '#12',
      text: '</style>',
    };
    const { palette } = computePalette(bad);
    const css = buildCss(bad, palette);
    expect(css).not.toContain('display:none');
    expect(css).not.toContain('url(');
    expect(css).not.toContain('</style>');
    expect(css).toContain('--c-primary: #1d4ed8;');
  });
  it('renderSite refuses models with unsafe URLs or hostile ids', () => {
    const a = richModel();
    a.pages[0]!.sections[0]!.props.cta = { url: 'javascript:alert(1)' };
    expect(() => renderSite(a, { assetBytes })).toThrow(/Invalid site model/);
    const b = richModel();
    b.pages[0]!.sections[0]!.id = 'x" onmouseover="y';
    expect(() => renderSite(b, { assetBytes })).toThrow(/Invalid site model/);
    const c = richModel();
    c.pages[0]!.slug = '../../etc';
    expect(() => renderSite(c, { assetBytes })).toThrow(/Invalid site model/);
  });
});

describe('text primitives', () => {
  it('esc escapes & < > " \' and backtick and cleans controls', () => {
    expect(esc(`&<>"'\``)).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
    expect(esc('a\u202Eb\u0000c\r\nd')).toBe('abc\nd');
    expect(clean('\u200fمرحبا\u200f')).toBe('\u200fمرحبا\u200f'); // directional marks are kept
  });
  it('jsonSafe leaves no characters that could end a script block', () => {
    const out = jsonSafe({ a: '</script><!--', b: 'x&y', c: '\u2028\u2029' });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ a: '</script><!--', b: 'x&y', c: '\u2028\u2029' });
  });
});

describe('extremely long text', () => {
  it('renders the maximum body, heading and faq answer without issues', () => {
    const m = richModel();
    const intro = m.pages[0]!.sections.find((s) => s.type === 'text')!;
    intro.props.body = { ar: 'ن'.repeat(3999) + '<', en: 'w'.repeat(3999) + '<' };
    const faq = m.pages[0]!.sections.find((s) => s.type === 'faq')!;
    (faq.props.items as Record<string, unknown>[])[0]!.answer = {
      ar: 'أ'.repeat(1000),
      en: 'a'.repeat(1000),
    };
    m.brand.name = { ar: 'ب'.repeat(80), en: 'b'.repeat(80) };
    expect(validateSiteModel(m)).toEqual([]);
    const r = renderSite(m, { assetBytes });
    expect(r.issues).toEqual([]);
    const html = r.files.find((f) => f.path === 'en/index.html')!.content as string;
    expect(html).toContain('w'.repeat(3999) + '&lt;');
  });
});
