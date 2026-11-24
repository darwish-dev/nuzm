import { gzipSync } from 'node:zlib';
import {
  checkAltText,
  checkLinks,
  contrastRatio,
  lintPhysicalDirectionCss,
  validateHtml,
  type RenderedFile,
} from '@nuzm/domain';
import type { QaContext, PageInfo } from './context';
import { cspAllows, parseCsp, strictnessProblems } from './csp';
import { attr, byTag, findAll, line, textOf, walk, type El } from './html';
import type { GateId, QaFinding } from './types';

type Gate = (c: QaContext) => QaFinding[];
const mk =
  (gate: GateId) =>
  (
    code: string,
    severity: 'error' | 'warning',
    message: string,
    file?: string,
    hint?: string,
  ): QaFinding => ({
    gate,
    code: `${gate}.${code}`,
    severity,
    message,
    ...(file ? { file } : {}),
    ...(hint ? { hint } : {}),
  });

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const ARABIC = new RegExp(
  '[\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff]',
  'g',
);
const LATIN = /[A-Za-z]/g;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// structure: document skeleton, landmarks, headings, names and labels (the parts of WCAG 2.1 AA that a static reader can decide)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const hasName = (e: El): boolean =>
  Boolean(attr(e, 'aria-label')?.trim()) ||
  Boolean(attr(e, 'aria-labelledby')?.trim()) ||
  textOf(e) !== '' ||
  byTag(e, 'img').some((i) => (attr(i, 'alt') ?? '').trim() !== '') ||
  Boolean(attr(e, 'title')?.trim());

export const structureGate: Gate = (c) => {
  const f = mk('structure');
  const out: QaFinding[] = [];
  for (const p of c.htmlFiles) {
    if (p.locale === null) continue; // the root redirect has its own, smaller contract (checked in `seo`)
    const root = p.doc.root;
    const html = byTag(root, 'html')[0];
    if (!p.doc.hasDoctype)
      out.push(f('doctype', 'error', 'the page has no <!doctype html>', p.path));
    if (!html) {
      out.push(f('no_html', 'error', 'no <html> element', p.path));
      continue;
    }
    const lang = attr(html, 'lang');
    if (!lang)
      out.push(
        f(
          'lang_missing',
          'error',
          '<html> has no lang attribute',
          p.path,
          `set lang="${p.locale}"`,
        ),
      );
    else if (lang.split('-')[0]!.toLowerCase() !== p.locale)
      out.push(
        f(
          'lang_mismatch',
          'error',
          `<html lang="${lang}"> on a ${p.locale} page`,
          p.path,
          `set lang="${p.locale}"`,
        ),
      );
    if (!byTag(root, 'meta').some((m) => m.attrs.charset !== undefined))
      out.push(f('charset', 'error', 'no <meta charset>', p.path));
    const vp = byTag(root, 'meta').find((m) => attr(m, 'name') === 'viewport');
    if (!vp) out.push(f('viewport_missing', 'error', 'no viewport meta (not responsive)', p.path));
    else {
      const v = attr(vp, 'content') ?? '';
      if (!/width\s*=\s*device-width/.test(v))
        out.push(f('viewport_width', 'error', 'viewport meta lacks width=device-width', p.path));
      if (
        /user-scalable\s*=\s*(no|0)/i.test(v) ||
        /maximum-scale\s*=\s*(0?\.\d+|1(\.0+)?)\b/i.test(v)
      )
        out.push(
          f(
            'viewport_zoom',
            'error',
            'viewport meta blocks zoom (WCAG 1.4.4)',
            p.path,
            'remove user-scalable and maximum-scale',
          ),
        );
    }
    const title = byTag(root, 'title')[0];
    if (!title || textOf(title) === '')
      out.push(f('title', 'error', 'the page has no <title>', p.path));

    const mains = byTag(root, 'main');
    if (mains.length !== 1)
      out.push(
        f('main', 'error', `${mains.length} <main> landmarks (exactly 1 is needed)`, p.path),
      );
    if (byTag(root, 'nav').length === 0) out.push(f('nav', 'warning', 'no <nav> landmark', p.path));
    if (byTag(root, 'header').length === 0 && byTag(root, 'footer').length === 0)
      out.push(f('banner', 'warning', 'no <header>/<footer> landmark', p.path));
    const navs = byTag(root, 'nav');
    if (navs.length > 1 && navs.some((n) => !attr(n, 'aria-label') && !attr(n, 'aria-labelledby')))
      out.push(
        f(
          'nav_label',
          'error',
          'several <nav> landmarks and one has no aria-label',
          p.path,
          'label each nav',
        ),
      );
    const skip = byTag(root, 'a').find((a) => (attr(a, 'href') ?? '').startsWith('#'));
    if (!skip) out.push(f('skip_link', 'warning', 'no skip-to-content link (WCAG 2.4.1)', p.path));

    // headings
    const hs = findAll(root, (e) => /^h[1-6]$/.test(e.tag));
    const h1s = hs.filter((h) => h.tag === 'h1');
    if (h1s.length !== 1)
      out.push(f('h1', 'error', `${h1s.length} <h1> elements (exactly 1 is needed)`, p.path));
    let prev = 0;
    for (const h of hs) {
      const lv = Number(h.tag[1]);
      if (prev && lv > prev + 1)
        out.push(
          f(
            'heading_skip',
            'error',
            `<h${lv}> follows <h${prev}> (heading levels skip)`,
            p.path,
            `use <h${prev + 1}>`,
          ),
        );
      if (textOf(h) === '' && byTag(h, 'img').length === 0)
        out.push(f('heading_empty', 'error', `empty <${h.tag}>`, p.path));
      prev = lv;
    }

    // ids
    const ids = new Map<string, number>();
    walk(root, (e) => {
      const id = attr(e, 'id');
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    });
    for (const [id, n] of ids)
      if (n > 1) out.push(f('duplicate_id', 'error', `id "${id}" is used ${n} times`, p.path));
    walk(root, (e) => {
      for (const k of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = attr(e, k);
        if (v)
          for (const ref of v.split(/\s+/))
            if (!ids.has(ref))
              out.push(f('aria_ref', 'error', `${k} points at a missing id "${ref}"`, p.path));
      }
    });

    // names
    for (const a of byTag(root, 'a'))
      if (attr(a, 'href') !== undefined && !hasName(a))
        out.push(
          f(
            'link_name',
            'error',
            `a link to ${attr(a, 'href')} has no accessible name`,
            p.path,
            'add text or aria-label',
          ),
        );
    for (const b of byTag(root, 'button'))
      if (!hasName(b))
        out.push(f('button_name', 'error', 'a <button> has no accessible name', p.path));
    for (const i of byTag(root, 'iframe'))
      if (!attr(i, 'title'))
        out.push(f('iframe_title', 'error', 'an <iframe> has no title', p.path));
    for (const img of byTag(root, 'img'))
      if (attr(img, 'alt') === undefined)
        out.push(f('img_alt', 'error', `<img src="${attr(img, 'src') ?? ''}"> has no alt`, p.path));

    // form controls
    const labelFor = new Set(
      byTag(root, 'label')
        .map((l) => attr(l, 'for'))
        .filter((x): x is string => Boolean(x)),
    );
    for (const inp of findAll(root, (e) => ['input', 'select', 'textarea'].includes(e.tag))) {
      const type = (attr(inp, 'type') ?? 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const id = attr(inp, 'id');
      let wrapped = false;
      for (let q = inp.parent; q; q = q.parent) if (q.tag === 'label') wrapped = true;
      const named = Boolean(attr(inp, 'aria-label')?.trim() || attr(inp, 'aria-labelledby'));
      if (!(id && labelFor.has(id)) && !wrapped && !named)
        out.push(
          f(
            'label',
            'error',
            `a <${inp.tag}${type !== 'text' ? ` type=${type}` : ''} name="${attr(inp, 'name') ?? ''}"> has no label`,
            p.path,
            'wrap it in a <label> or add label[for]',
          ),
        );
    }
    // tabindex > 0 breaks the natural focus order
    walk(root, (e) => {
      const t = Number(attr(e, 'tabindex'));
      if (Number.isFinite(t) && t > 0)
        out.push(
          f('tabindex', 'error', `tabindex="${t}" (positive values break focus order)`, p.path),
        );
    });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// html: well-formedness (reader errors + the strict validator of the renderer)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export const htmlGate: Gate = (c) => {
  const f = mk('html');
  const out: QaFinding[] = [];
  for (const p of c.htmlFiles) {
    for (const e of p.doc.errors) out.push(f('malformed', 'error', e, p.path));
    for (const i of validateHtml(p.html))
      out.push(f(i.code, 'error', i.message, p.path, `line ${line(p.html, i.index ?? 0)}`));
    for (const i of checkAltText(p.html))
      out.push(f(i.code, 'error', i.message, p.path, `line ${line(p.html, i.index ?? 0)}`));
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// links: every internal reference resolves; external links are safe
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export const linksGate: Gate = (c) => {
  const f = mk('links');
  const out: QaFinding[] = [];
  const rendered: RenderedFile[] = c.files.map((x) => ({
    path: x.path,
    mime: '',
    content: x.path.endsWith('.html') ? (c.text(x.path) ?? '') : x.bytes,
  }));
  for (const l of checkLinks(rendered))
    out.push(
      f('broken', 'error', `${l.href}: ${l.message}`, l.file, 'fix the target or remove the link'),
    );
  for (const p of c.htmlFiles)
    walk(p.doc.root, (e) => {
      if (e.tag !== 'a') return;
      const href = (attr(e, 'href') ?? '').trim();
      if (/^javascript:/i.test(href) || /^data:/i.test(href))
        out.push(f('unsafe_scheme', 'error', `a link uses ${href.slice(0, 12)}…`, p.path));
      if (/^http:\/\//i.test(href))
        out.push(f('insecure', 'warning', `${href.slice(0, 60)} is not https`, p.path));
      if (/^mailto:/i.test(href) && !/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+/i.test(href))
        out.push(f('mailto', 'error', `malformed ${href.slice(0, 50)}`, p.path));
      if (/^tel:/i.test(href) && !/^tel:\+?[0-9()\-.\s]{5,}$/i.test(href))
        out.push(f('tel', 'error', `malformed ${href.slice(0, 50)}`, p.path));
      if (attr(e, 'target') === '_blank' && !/\bnoopener\b/i.test(attr(e, 'rel') ?? ''))
        out.push(
          f(
            'noopener',
            'error',
            `${href.slice(0, 60)} opens a new tab without rel="noopener"`,
            p.path,
          ),
        );
      if (href === '#' || href === '')
        out.push(f('empty', 'warning', 'a link with an empty target', p.path));
    });
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// csp: the policy is strict, and the pages obey it (no inline code, no origin the policy would block)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const FETCHERS: { tag: string; attrName: string; directive: string; when?: (e: El) => boolean }[] =
  [
    { tag: 'script', attrName: 'src', directive: 'script-src' },
    {
      tag: 'link',
      attrName: 'href',
      directive: 'style-src',
      when: (e) => /stylesheet/i.test(attr(e, 'rel') ?? ''),
    },
    {
      tag: 'link',
      attrName: 'href',
      directive: 'img-src',
      when: (e) => /icon/i.test(attr(e, 'rel') ?? ''),
    },
    {
      tag: 'link',
      attrName: 'href',
      directive: 'font-src',
      when: (e) => /preload/i.test(attr(e, 'rel') ?? '') && attr(e, 'as') === 'font',
    },
    { tag: 'img', attrName: 'src', directive: 'img-src' },
    { tag: 'source', attrName: 'src', directive: 'media-src' },
    { tag: 'audio', attrName: 'src', directive: 'media-src' },
    { tag: 'video', attrName: 'src', directive: 'media-src' },
    { tag: 'iframe', attrName: 'src', directive: 'frame-src' },
    { tag: 'embed', attrName: 'src', directive: 'object-src' },
    { tag: 'object', attrName: 'data', directive: 'object-src' },
    { tag: 'form', attrName: 'action', directive: 'form-action' },
  ];
export const cspGate: Gate = (c) => {
  const f = mk('csp');
  const out: QaFinding[] = [];
  for (const m of strictnessProblems(c.policy))
    out.push(
      f(
        'policy',
        'error',
        `policy: ${m}`,
        undefined,
        'the host must send the platform policy (ADR-060 §5)',
      ),
    );
  const policy = parseCsp(c.policy);
  for (const p of c.htmlFiles) {
    const origin = 'https://site.invalid';
    walk(p.doc.root, (e) => {
      if (e.tag === 'script') {
        const type = (attr(e, 'type') ?? '').toLowerCase();
        const inline = e.children.some((x) => typeof x === 'string' && x.trim() !== '');
        const data = type === 'application/ld+json' || type === 'application/json';
        if (attr(e, 'src') === undefined && inline && !data)
          out.push(
            f(
              'inline_script',
              'error',
              'an inline <script> (blocked by script-src)',
              p.path,
              'move it to a first-party file under assets/',
            ),
          );
      }
      if (e.tag === 'style')
        out.push(
          f(
            'inline_style',
            'error',
            'an inline <style> block (blocked by style-src)',
            p.path,
            'use the stylesheet',
          ),
        );
      if (e.tag === 'base')
        out.push(f('base', 'error', 'a <base> element (base-uri is none)', p.path));
      if (e.tag === 'meta' && /refresh/i.test(attr(e, 'http-equiv') ?? '')) {
        const m = /url\s*=\s*(\S+)/i.exec(attr(e, 'content') ?? '');
        if (m?.[1] && EXTERNAL.test(m[1]))
          out.push(f('refresh_external', 'error', `meta refresh to ${m[1].slice(0, 60)}`, p.path));
      }
      for (const name of Object.keys(e.attrs)) {
        if (/^on[a-z]+$/.test(name))
          out.push(
            f(
              'inline_handler',
              'error',
              `<${e.tag} ${name}=…> inline event handler`,
              p.path,
              'attach handlers from the first-party script',
            ),
          );
        if (name === 'style' && e.attrs.style)
          out.push(
            f(
              'style_attr',
              'error',
              `<${e.tag} style=…> inline style attribute (blocked by style-src)`,
              p.path,
              'use classes',
            ),
          );
        if (name === 'srcdoc')
          out.push(f('srcdoc', 'error', `<${e.tag} srcdoc> embeds a document`, p.path));
        const v = e.attrs[name];
        if (
          typeof v === 'string' &&
          /^\s*javascript:/i.test(v) &&
          ['href', 'src', 'action', 'formaction', 'data'].includes(name)
        )
          out.push(f('javascript_url', 'error', `<${e.tag} ${name}="javascript:…">`, p.path));
      }
      for (const r of FETCHERS) {
        if (e.tag !== r.tag || (r.when && !r.when(e))) continue;
        const url = attr(e, r.attrName);
        if (!url || url.startsWith('#')) continue;
        if (!cspAllows(policy, r.directive, url, origin))
          out.push(
            f(
              'blocked',
              'error',
              `<${e.tag} ${r.attrName}="${url.slice(0, 80)}"> is blocked by ${r.directive}`,
              p.path,
              `host the file inside the site, or (forms) use the platform forms origin`,
            ),
          );
      }
      // external fetches that carry no tag rule: preconnect/dns-prefetch leak a visit to a third party
      if (
        e.tag === 'link' &&
        /preconnect|dns-prefetch|prefetch|prerender/i.test(attr(e, 'rel') ?? '') &&
        EXTERNAL.test(attr(e, 'href') ?? '')
      )
        out.push(
          f('third_party_hint', 'error', `link rel=${attr(e, 'rel')} to a third party`, p.path),
        );
    });
  }
  // stylesheets: no @import of, and no url() to, another origin; no expression()/javascript: in CSS
  for (const file of c.files) {
    if (!file.path.endsWith('.css')) continue;
    const css = c.text(file.path)!;
    for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi))
      out.push(
        f('css_import', 'error', `@import ${m[1]!.slice(0, 60)} in a stylesheet`, file.path),
      );
    for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const u = m[1]!.trim();
      if (u.startsWith('#') || u.startsWith('data:')) continue;
      if (EXTERNAL.test(u))
        out.push(f('css_external', 'error', `url(${u.slice(0, 60)}) in a stylesheet`, file.path));
    }
    if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(css))
      out.push(f('css_script', 'error', 'script-capable construct in a stylesheet', file.path));
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// size: Lighthouse-style budgets (per-file, per-page transfer, total, file count)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const gz = (b: Uint8Array) => gzipSync(b, { level: 6 }).length;
export const sizeGate: Gate = (c) => {
  const f = mk('size');
  const out: QaFinding[] = [];
  const b = c.budgets;
  let total = 0;
  for (const file of c.files) {
    total += file.bytes.length;
    const p = file.path;
    const n = file.bytes.length;
    if (p.endsWith('.html') && n > b.maxHtmlBytes)
      out.push(
        f(
          'html',
          'error',
          `${n} bytes exceeds the ${b.maxHtmlBytes}-byte page budget`,
          p,
          'split the page or trim sections',
        ),
      );
    else if (p.endsWith('.css') && n > b.maxCssBytes)
      out.push(
        f('css', 'error', `${n} bytes exceeds the ${b.maxCssBytes}-byte stylesheet budget`, p),
      );
    else if (/\.m?js$/.test(p) && n > b.maxJsBytes)
      out.push(f('js', 'error', `${n} bytes exceeds the ${b.maxJsBytes}-byte script budget`, p));
    else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(p) && n > b.maxImageBytes)
      out.push(
        f(
          'image',
          'error',
          `${n} bytes exceeds the ${b.maxImageBytes}-byte image budget`,
          p,
          'compress or resize the image',
        ),
      );
  }
  if (total > b.maxTotalBytes)
    out.push(f('total', 'error', `the artifact is ${total} bytes (budget ${b.maxTotalBytes})`));
  if (c.files.length > b.maxFiles)
    out.push(f('files', 'error', `${c.files.length} files (budget ${b.maxFiles})`));
  // transfer weight of one page: gzip(html) + gzip of the stylesheets/scripts/images it references
  for (const p of c.pages) {
    const refs = new Set<string>();
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/') + 1) : '';
    walk(p.doc.root, (e) => {
      const u =
        e.tag === 'link' && /stylesheet/i.test(attr(e, 'rel') ?? '')
          ? attr(e, 'href')
          : e.tag === 'script' || e.tag === 'img'
            ? attr(e, 'src')
            : undefined;
      if (!u || EXTERNAL.test(u)) return;
      const clean = u.split(/[?#]/)[0]!;
      const joined = clean.startsWith('/') ? clean.slice(1) : normalizeRel(`${dir}${clean}`);
      if (joined && c.byPath.has(joined)) refs.add(joined);
    });
    let weight = gz(c.byPath.get(p.path)!.bytes);
    for (const r of refs) {
      const bytes = c.byPath.get(r)!.bytes;
      weight += /\.(png|jpe?g|webp|gif)$/i.test(r) ? bytes.length : gz(bytes);
    }
    if (weight > b.maxPageTransferBytes)
      out.push(
        f(
          'transfer',
          'error',
          `loading the page transfers about ${weight} bytes (budget ${b.maxPageTransferBytes})`,
          p.path,
        ),
      );
  }
  return out;
};
function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// rtl: direction, language, logical CSS, translated content
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);
export const rtlGate: Gate = (c) => {
  const f = mk('rtl');
  const out: QaFinding[] = [];
  for (const p of c.pages) {
    const html = byTag(p.doc.root, 'html')[0];
    if (!html) continue;
    const want = RTL_LOCALES.has(p.locale!) ? 'rtl' : 'ltr';
    const dir = attr(html, 'dir')?.toLowerCase();
    if (dir !== want)
      out.push(
        f(
          'dir',
          'error',
          `<html dir="${dir ?? ''}"> on a ${p.locale} page (expected ${want})`,
          p.path,
          `set dir="${want}"`,
        ),
      );
    const body = byTag(p.doc.root, 'body')[0];
    const text = body ? textOf(body) : '';
    const ar = (text.match(ARABIC) ?? []).length;
    const la = (text.match(LATIN) ?? []).length;
    if (p.locale === 'ar' && ar + la > 0 && ar / (ar + la) < 0.5)
      out.push(
        f(
          'untranslated',
          'error',
          `an Arabic page whose letters are only ${Math.round((100 * ar) / (ar + la))}% Arabic`,
          p.path,
          'translate the content',
        ),
      );
    if (p.locale === 'en' && ar + la > 0 && ar / (ar + la) > 0.2)
      out.push(
        f(
          'untranslated',
          'error',
          `an English page with ${Math.round((100 * ar) / (ar + la))}% Arabic letters`,
          p.path,
        ),
      );
    // inline direction overrides that fight the document direction
    walk(p.doc.root, (e) => {
      const d = attr(e, 'dir')?.toLowerCase();
      if (
        e.tag !== 'html' &&
        d &&
        d !== 'auto' &&
        d !== want &&
        !['bdi', 'bdo', 'span', 'a', 'code', 'time', 'bdi'].includes(e.tag)
      )
        out.push(
          f('dir_override', 'warning', `<${e.tag} dir="${d}"> inside a ${want} page`, p.path),
        );
    });
  }
  for (const file of c.files)
    if (file.path.endsWith('.css'))
      for (const m of lintPhysicalDirectionCss(c.text(file.path)!))
        out.push(
          f('physical_css', 'error', m, file.path, 'use logical properties (inline-start/end)'),
        );
  // every locale serves the same pages
  const slugs = (l: string) => new Set(c.pages.filter((p) => p.locale === l).map((p) => p.slug));
  const base = c.locales[0] ? slugs(c.locales[0]) : new Set<string>();
  for (const l of c.locales.slice(1))
    for (const s of base)
      if (!slugs(l).has(s))
        out.push(
          f('locale_parity', 'error', `page "${s}" exists in ${c.locales[0]} but not in ${l}`),
        );
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// seo: metadata a search engine and a share card need
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export const seoGate: Gate = (c) => {
  const f = mk('seo');
  const out: QaFinding[] = [];
  const titles = new Map<string, string[]>();
  let canonicalSeen = false;
  for (const p of c.pages) {
    const metas = byTag(p.doc.root, 'meta');
    const meta = (k: 'name' | 'property', v: string) => metas.find((m) => attr(m, k) === v);
    const title = textOf(byTag(p.doc.root, 'title')[0] ?? ({ children: [] } as unknown as El));
    if (title) {
      if (title.length < 10 || title.length > 70)
        out.push(
          f(
            'title_length',
            'warning',
            `title is ${title.length} characters (10–70 is best)`,
            p.path,
          ),
        );
      const key = `${p.locale}\0${title}`;
      titles.set(key, [...(titles.get(key) ?? []), p.path]);
    }
    const desc = attr(meta('name', 'description') ?? ({ attrs: {} } as El), 'content')?.trim();
    if (!desc)
      out.push(f('description', 'error', 'no meta description', p.path, 'add seo.description'));
    else if (desc.length < 50 || desc.length > 180)
      out.push(
        f(
          'description_length',
          'warning',
          `description is ${desc.length} characters (50–180 is best)`,
          p.path,
        ),
      );
    const robots = attr(meta('name', 'robots') ?? ({ attrs: {} } as El), 'content') ?? '';
    const noindex = /noindex/i.test(robots);
    if (c.mode === 'publish' && noindex)
      out.push(f('noindex', 'error', 'a published page is marked noindex', p.path));
    if (c.mode === 'preview' && !noindex)
      out.push(f('preview_indexable', 'error', 'a preview page is indexable', p.path));
    const canon = byTag(p.doc.root, 'link').find((l) => attr(l, 'rel') === 'canonical');
    if (canon) {
      canonicalSeen = true;
      if (!/^https:\/\//.test(attr(canon, 'href') ?? ''))
        out.push(f('canonical', 'error', 'canonical is not an absolute https URL', p.path));
      if (!meta('property', 'og:title') || !meta('property', 'og:description'))
        out.push(f('open_graph', 'warning', 'Open Graph title/description missing', p.path));
      if (c.locales.length > 1) {
        const alts = byTag(p.doc.root, 'link').filter(
          (l) => attr(l, 'rel') === 'alternate' && attr(l, 'hreflang'),
        );
        for (const l of c.locales)
          if (!alts.some((a) => attr(a, 'hreflang')!.split('-')[0] === l))
            out.push(f('hreflang', 'error', `no hreflang alternate for ${l}`, p.path));
      }
    }
    for (const s of byTag(p.doc.root, 'script'))
      if ((attr(s, 'type') ?? '').toLowerCase() === 'application/ld+json') {
        const body = s.children.filter((x): x is string => typeof x === 'string').join('');
        try {
          JSON.parse(body);
        } catch {
          out.push(f('jsonld', 'error', 'invalid JSON-LD', p.path));
        }
      }
  }
  for (const [key, paths] of titles)
    if (paths.length > 1)
      out.push(
        f(
          'duplicate_title',
          'error',
          `pages share the title "${key.split('\0')[1]!.slice(0, 60)}": ${paths.join(', ')}`,
          paths[0],
          'give every page its own title',
        ),
      );
  if (canonicalSeen) {
    if (!c.byPath.has('sitemap.xml'))
      out.push(f('sitemap', 'warning', 'canonical URLs but no sitemap.xml'));
    if (!c.byPath.has('robots.txt'))
      out.push(f('robots', 'warning', 'canonical URLs but no robots.txt'));
    const rb = c.text('robots.txt');
    if (rb && c.mode === 'publish' && /^\s*disallow:\s*\/\s*$/im.test(rb))
      out.push(f('robots_block', 'error', 'robots.txt disallows the whole site', 'robots.txt'));
  }
  // the root redirect must lead to a locale page
  const idx = c.htmlFiles.find((p) => p.path === 'index.html');
  if (!idx) out.push(f('index', 'error', 'no index.html at the site root'));
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// forms: contact forms post where the policy lets them, with named, labelled fields
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export const formsGate: Gate = (c) => {
  const f = mk('forms');
  const out: QaFinding[] = [];
  const policy = parseCsp(c.policy);
  for (const p of c.pages)
    for (const form of byTag(p.doc.root, 'form')) {
      const action = attr(form, 'action') ?? '';
      const method = (attr(form, 'method') ?? 'get').toLowerCase();
      if (method !== 'post')
        out.push(f('method', 'error', 'a form that does not use method="post"', p.path));
      if (!action) out.push(f('action', 'error', 'a form without an action', p.path));
      else if (!cspAllows(policy, 'form-action', action, 'https://site.invalid'))
        out.push(
          f(
            'action_blocked',
            'error',
            `form action ${action.slice(0, 80)} is blocked by form-action`,
            p.path,
            'post to the platform forms service',
          ),
        );
      else if (EXTERNAL.test(action) && !/\/v1\/public\/forms\//.test(action))
        out.push(
          f(
            'action_external',
            'error',
            `form posts to ${action.slice(0, 80)}, not the platform forms service`,
            p.path,
          ),
        );
      const controls = findAll(form, (e) => ['input', 'select', 'textarea'].includes(e.tag));
      for (const i of controls) {
        const t = (attr(i, 'type') ?? 'text').toLowerCase();
        if (['submit', 'button', 'reset'].includes(t)) continue;
        if (!attr(i, 'name'))
          out.push(f('field_name', 'error', 'a form control without a name', p.path));
        if (t === 'password')
          out.push(f('password', 'error', 'a password field in a generated site', p.path));
      }
      const hasSubmit =
        controls.some((i) => (attr(i, 'type') ?? '').toLowerCase() === 'submit') ||
        byTag(form, 'button').some((b) => (attr(b, 'type') ?? 'submit').toLowerCase() === 'submit');
      if (!hasSubmit) out.push(f('submit', 'error', 'a form without a submit button', p.path));
      for (const i of controls) {
        const t = (attr(i, 'type') ?? 'text').toLowerCase();
        const ac = attr(i, 'autocomplete');
        if (['email', 'tel'].includes(t) && !ac)
          out.push(
            f('autocomplete', 'warning', `a ${t} field without autocomplete (WCAG 1.3.5)`, p.path),
          );
      }
    }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// assets: images are real, safe and licensed-safe (placeholders or uploads: no remote imagery)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
function sniff(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length > 12 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
  )
    return 'webp';
  return null;
}
export const assetsGate: Gate = (c) => {
  const f = mk('assets');
  const out: QaFinding[] = [];
  const referenced = new Set<string>();
  for (const p of c.htmlFiles) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/') + 1) : '';
    walk(p.doc.root, (e) => {
      for (const k of ['src', 'href', 'data']) {
        const u = attr(e, k);
        if (!u || EXTERNAL.test(u) || u.startsWith('#')) continue;
        const clean = u.split(/[?#]/)[0]!;
        referenced.add(clean.startsWith('/') ? clean.slice(1) : normalizeRel(`${dir}${clean}`));
      }
      if (e.tag === 'img') {
        const src = attr(e, 'src') ?? '';
        if (EXTERNAL.test(src) && !src.startsWith('data:'))
          out.push(
            f(
              'remote_image',
              'error',
              `<img src="${src.slice(0, 80)}"> is a remote image (unlicensed, third-party request)`,
              p.path,
              'use a placeholder or an uploaded asset',
            ),
          );
        if (
          !attr(e, 'width') &&
          !attr(e, 'height') &&
          !/\b(aspect-|h-|size-)/.test(attr(e, 'class') ?? '')
        )
          out.push(
            f(
              'dimensions',
              'warning',
              `<img src="${src.slice(0, 60)}"> has no width/height (layout shift)`,
              p.path,
            ),
          );
      }
    });
  }
  for (const file of c.files) {
    const p = file.path;
    if (!p.startsWith('assets/')) continue;
    if (/\.(png|jpe?g|webp)$/i.test(p)) {
      const kind = sniff(file.bytes);
      const ext = /\.jpe?g$/i.test(p) ? 'jpeg' : p.split('.').pop()!.toLowerCase();
      if (kind !== ext)
        out.push(
          f(
            'mime_mismatch',
            'error',
            `${p} is not a real ${ext} image (content is ${kind ?? 'unknown'})`,
            p,
          ),
        );
    }
    if (/\.svg$/i.test(p)) {
      const svg = c.text(p) ?? '';
      if (
        /<script|\son[a-z]+\s*=|<foreignObject|javascript:|<iframe|<use[^>]+href\s*=\s*["']https?:/i.test(
          svg,
        )
      )
        out.push(
          f(
            'svg_unsafe',
            'error',
            `${p} contains script-capable or external content`,
            p,
            'SVG must be plain shapes and text',
          ),
        );
    }
    if (!/\.(png|jpe?g|webp|svg|gif|ico|woff2?|css|js|json|txt)$/i.test(p))
      out.push(f('unknown_type', 'warning', `${p} has an unexpected file type`, p));
    if (!referenced.has(p) && !/\.(css|js)$/.test(p) && !/^assets\/(favicon|og)/.test(p))
      out.push(f('unreferenced', 'warning', `${p} is not referenced by any page`, p));
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// completeness: a business website has the pages a business needs, in every locale, reachable from the navigation
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export const completenessGate: Gate = (c) => {
  const f = mk('completeness');
  const out: QaFinding[] = [];
  if (c.locales.length === 0)
    out.push(f('no_locale', 'error', 'no locale directory (ar/, en/, …) found'));
  for (const l of c.locales) {
    const mine = c.pages.filter((p) => p.locale === l);
    if (mine.length < c.minPages)
      out.push(
        f(
          'pages',
          'error',
          `${l}: ${mine.length} pages, at least ${c.minPages} are required`,
          undefined,
          'add the missing pages to the plan',
        ),
      );
    for (const s of c.requiredSlugs)
      if (!mine.some((p) => p.slug === s))
        out.push(f('required_page', 'error', `${l}: no "${s}" page`));
    const home = mine.find((p) => p.slug === 'home');
    if (!home) {
      out.push(f('home', 'error', `${l}: no home page (${l}/index.html)`));
      continue;
    }
    // every page is linked from the home page navigation
    const hrefs = new Set<string>();
    for (const a of byTag(home.doc.root, 'a')) {
      const h = (attr(a, 'href') ?? '').split(/[?#]/)[0]!;
      if (h && !EXTERNAL.test(h))
        hrefs.add(normalizeRel(h.startsWith('/') ? h.slice(1) : `${l}/${h}`));
    }
    for (const p of mine) {
      if (p.slug === 'home') continue;
      const ok = [...hrefs].some(
        (h) =>
          h === p.path ||
          h === p.path.replace(/index\.html$/, '').replace(/\/$/, '') ||
          `${h}/index.html` === p.path,
      );
      const rel = hrefs.has(p.path) || [...hrefs].some((h) => `${h}/index.html` === p.path);
      if (!ok && !rel)
        out.push(
          f(
            'unreachable',
            'error',
            `${l}: the "${p.slug}" page is not linked from the home page`,
            p.path,
            'add it to the navigation',
          ),
        );
    }
  }
  return out;
};

export type { PageInfo };

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// contrast: colour pairs of the design tokens (`--c-*` in the stylesheet) meet WCAG AA. A browser-free decision from the tokens; rendered contrast is the E2E's.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const PAIRS: [string, string, string][] = [
  ['--c-text', '--c-bg', 'text on background'],
  ['--c-muted-text', '--c-bg', 'muted text on background'],
  ['--c-muted-text', '--c-muted-bg', 'muted text on muted background'],
  ['--c-text', '--c-muted-bg', 'text on muted background'],
  ['--c-link', '--c-bg', 'link on background'],
  ['--c-link', '--c-muted-bg', 'link on muted background'],
  ['--c-on-primary', '--c-primary', 'text on primary'],
  ['--c-on-accent', '--c-accent', 'text on accent'],
];
export const contrastGate: Gate = (c) => {
  const f = mk('contrast');
  const out: QaFinding[] = [];
  const css = c.files
    .filter((x) => x.path.endsWith('.css'))
    .map((x) => c.text(x.path)!)
    .join('\n');
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--c-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) vars.set(m[1]!, m[2]!);
  if (vars.size === 0)
    return [
      f(
        'no_tokens',
        'warning',
        'no --c-* colour tokens in the stylesheets: contrast could not be decided here',
        undefined,
        'the rendered check belongs to the browser E2E',
      ),
    ];
  for (const [fg, bg, label] of PAIRS) {
    const a = vars.get(fg);
    const b = vars.get(bg);
    if (!a || !b) continue;
    const r = contrastRatio(a, b);
    if (r < 4.5)
      out.push(
        f(
          'low',
          'error',
          `${label}: ${a} on ${b} is ${r.toFixed(2)}:1 (WCAG AA needs 4.5:1)`,
          undefined,
          'change the brand colours',
        ),
      );
  }
  return out;
};
