import type { SiteModel } from '../site-model';
import { AA_NORMAL } from './contrast';
import { attrOf, tokenize, VOID, type Attr, type Token } from './html-scan';
import { computePalette, type ContrastIssue } from './palette';
import type { RenderedFile } from './types';

export { contrastRatio } from './contrast';

export interface HtmlIssue {
  code: string;
  message: string;
  /** character offset in the input */
  index?: number;
}
export interface LinkIssue {
  file: string;
  href: string;
  message: string;
}

const FORBIDDEN_TAGS = new Set([
  'iframe',
  'object',
  'embed',
  'applet',
  'frame',
  'frameset',
  'base',
]);
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'srcset',
  'data',
  'ping',
]);
/** end tags that may be implied by HTML; the generator always closes them, but foreign input may omit them */
const OPTIONAL_END = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'option',
  'thead',
  'tbody',
  'tfoot',
]);
const NO_LABEL_INPUT = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** Decode the entities a browser would decode inside an attribute before interpreting a URL. */
function decodeAttr(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) =>
      String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)),
    )
    .replace(/&#(\d+);?/g, (_, d: string) =>
      String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)),
    )
    .replace(
      /&(colon|tab|newline);/gi,
      (_, n: string) => ({ colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase()] ?? '',
    )
    .replace(
      /&(amp|lt|gt|quot|apos);/gi,
      (_, n: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n.toLowerCase()] ?? '',
    );
}
/** URL as the browser would see it for scheme purposes: entities decoded, whitespace/control/zero-width characters removed. */
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g;
const scheme = (v: string) => decodeAttr(v).replace(STRIP, '').toLowerCase();
const DANGEROUS_SCHEME = /^(javascript|vbscript|data):/;

function isLdJson(attrs: Attr[]): boolean {
  const t = attrs.find((a) => a.name === 'type')?.value;
  return t !== null && t !== undefined && t.trim().toLowerCase() === 'application/ld+json';
}

/**
 * Validates one HTML document (or fragment with `{ fragment: true }`). Security rules (the CSP-compatible subset the renderer promises):
 * no script except `application/ld+json` data blocks and first-party `<script src>`, no `on*` handlers, no `style` attributes or `<style>`, no
 * `javascript:`/`vbscript:`/`data:` URLs, no frames/objects/base, `target=_blank` needs `rel=noopener`. Structure rules: balanced tags, unique ids,
 * resolvable label/aria references, one `<h1>`, no heading level skips, lang/dir, title, viewport, charset, one `<main>`.
 */
export function validateHtml(html: string, opts: { fragment?: boolean } = {}): HtmlIssue[] {
  const issues: HtmlIssue[] = [];
  const add = (code: string, message: string, index?: number) =>
    issues.push({ code, message, index });
  const tokens = tokenize(html);
  const stack: string[] = [];
  const ids = new Map<string, number>();
  const refs: { attr: string; id: string; index: number }[] = [];
  const labelFor = new Set<string>();
  const inputs: { id?: string | null; labelled: boolean; index: number }[] = [];
  const headings: number[] = [];
  // a state object (not `let`s): the closure below mutates it and TypeScript would otherwise narrow the locals to their initial values
  const S = {
    sawDoctype: false,
    sawHtml: false,
    lang: undefined as string | null | undefined,
    dir: undefined as string | null | undefined,
    title: '',
    charset: false,
    viewport: false,
    mains: 0,
  };

  for (const t of tokens) {
    if (t.kind === 'error') add('malformed', t.message, t.index);
    else if (t.kind === 'doctype') S.sawDoctype = /^doctype html\s*$/i.test(t.text.trim());
    else if (t.kind === 'end') {
      const at = stack.lastIndexOf(t.name);
      if (at === -1) add('unmatched_end_tag', `</${t.name}> has no matching start tag`, t.index);
      else {
        const dropped = stack.splice(at);
        dropped.shift();
        const bad = dropped.filter((d) => !OPTIONAL_END.has(d));
        if (bad.length > 0)
          add(
            'unclosed_tag',
            `<${bad[bad.length - 1]}> is not closed before </${t.name}>`,
            t.index,
          );
      }
    } else if (t.kind === 'start') {
      startTag(t);
    }
  }
  for (const s of stack) if (!OPTIONAL_END.has(s)) add('unclosed_tag', `<${s}> is never closed`);

  function startTag(t: Extract<Token, { kind: 'start' }>): void {
    const { name, attrs, index } = t;
    const get = (n: string) => attrs.find((a) => a.name === n)?.value;
    const seen = new Set<string>();
    for (const a of attrs) {
      if (seen.has(a.name))
        add('duplicate_attribute', `<${name}> repeats attribute ${a.name}`, index);
      seen.add(a.name);
      if (a.name.startsWith('on'))
        add('inline_event_handler', `<${name}> has event handler attribute ${a.name}`, index);
      if (a.name === 'style') add('inline_style', `<${name}> has a style attribute`, index);
      const v = a.value ?? '';
      if (v.includes('<'))
        add('raw_lt_in_attribute', `<${name} ${a.name}> contains an unescaped "<"`, index);
      if (URL_ATTRS.has(a.name) && DANGEROUS_SCHEME.test(scheme(v)))
        add('unsafe_url', `<${name} ${a.name}> uses a javascript:, vbscript: or data: URL`, index);
      if (
        a.name === 'srcset' &&
        /(javascript|vbscript|data):/i.test(decodeAttr(v).replace(STRIP, ''))
      )
        add('unsafe_url', `<${name} srcset> contains an unsafe URL`, index);
    }
    const id = get('id');
    if (id !== undefined && id !== null) {
      if (id === '' || /\s/.test(id))
        add('invalid_id', `<${name}> has an empty or whitespace id`, index);
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const r of ['aria-labelledby', 'aria-controls', 'aria-describedby']) {
      const v = get(r);
      if (v) for (const x of v.split(/\s+/)) refs.push({ attr: r, id: x, index });
    }
    if (FORBIDDEN_TAGS.has(name)) add('forbidden_tag', `<${name}> is not allowed`, index);
    if (get('target') === '_blank' && !/\bnoopener\b/.test(get('rel') ?? ''))
      add(
        'target_blank_noopener',
        `<${name} target="_blank"> needs rel="noopener noreferrer"`,
        index,
      );

    switch (name) {
      case 'script': {
        const src = get('src');
        if (src !== undefined && src !== null) {
          if (!/^\/[^/\\]/.test(src) || t.raw?.trim())
            add('script_not_allowed', 'only first-party external scripts are allowed', index);
        } else if (!isLdJson(attrs))
          add(
            'script_not_allowed',
            'inline <script> is only allowed with type="application/ld+json"',
            index,
          );
        else {
          const body = t.raw ?? '';
          if (body.includes('<')) add('ldjson_unsafe', 'JSON-LD block contains a raw "<"', index);
          try {
            JSON.parse(body);
          } catch {
            add('ldjson_invalid', 'JSON-LD block is not valid JSON', index);
          }
        }
        stack.push(name); // raw-text element: the tokenizer emits the matching end tag next
        return;
      }
      case 'style':
        add('inline_style', '<style> elements are not allowed (CSP style-src self)', index);
        stack.push(name);
        return;
      case 'textarea':
        inputs.push({
          id,
          labelled:
            stack.includes('label') ||
            attrs.some((a) => a.name === 'aria-label' || a.name === 'aria-labelledby'),
          index,
        });
        stack.push(name);
        return;
      case 'title':
        S.title = t.raw ?? '';
        stack.push(name);
        return;
      case 'html':
        S.sawHtml = true;
        S.lang = get('lang');
        S.dir = get('dir');
        break;
      case 'main':
        S.mains++;
        break;
      case 'meta': {
        const he = get('http-equiv');
        if (he !== undefined && he !== null && he.toLowerCase() !== 'refresh')
          add('forbidden_meta', `meta http-equiv=${he} is not allowed`, index);
        if (get('charset')) S.charset = true;
        if (get('name') === 'viewport') S.viewport = true;
        break;
      }
      case 'label': {
        const f = get('for');
        if (f) {
          labelFor.add(f);
          refs.push({ attr: 'for', id: f, index });
        }
        break;
      }
      case 'input': {
        const type = (get('type') ?? 'text').toLowerCase();
        if (!NO_LABEL_INPUT.has(type))
          inputs.push({
            id,
            labelled:
              stack.includes('label') ||
              attrs.some((a) => a.name === 'aria-label' || a.name === 'aria-labelledby'),
            index,
          });
        break;
      }
      default:
        if (/^h[1-6]$/.test(name)) headings.push(Number(name[1]));
    }
    if (!VOID.has(name) && !t.selfClosing) stack.push(name);
  }

  for (const [id, n] of ids) if (n > 1) add('duplicate_id', `id "${id}" is used ${n} times`);
  for (const r of refs)
    if (!ids.has(r.id))
      add('dangling_reference', `${r.attr} points to missing id "${r.id}"`, r.index);
  for (const inp of inputs)
    if (!inp.labelled && !(inp.id && labelFor.has(inp.id)))
      add(
        'unlabelled_input',
        'form control has no <label for>, aria-label or wrapping label',
        inp.index,
      );

  if (!opts.fragment) {
    const { lang, dir } = S;
    if (!S.sawDoctype) add('missing_doctype', 'document must start with <!doctype html>');
    if (!S.sawHtml) add('missing_html', 'no <html> element');
    if (!lang) add('missing_lang', '<html> needs a lang attribute');
    if (dir !== 'rtl' && dir !== 'ltr') add('missing_dir', '<html> needs dir="rtl" or dir="ltr"');
    else if (lang && /^ar\b/i.test(lang) && dir !== 'rtl')
      add('dir_mismatch', 'Arabic pages need dir="rtl"');
    else if (lang && /^en\b/i.test(lang) && dir !== 'ltr')
      add('dir_mismatch', 'English pages need dir="ltr"');
    if (S.title.trim() === '') add('missing_title', 'document needs a non-empty <title>');
    if (!S.charset) add('missing_charset', 'document needs <meta charset>');
    if (!S.viewport) add('missing_viewport', 'document needs a viewport meta');
    if (S.mains !== 1) add('main_count', `document needs exactly one <main> (found ${S.mains})`);
    const h1s = headings.filter((h) => h === 1).length;
    if (h1s !== 1) add('h1_count', `document needs exactly one <h1> (found ${h1s})`);
    if (headings.length > 0 && headings[0] !== 1)
      add('heading_order', 'the first heading must be <h1>');
  }
  headings.forEach((h, i) => {
    const prev = headings[i - 1];
    if (prev !== undefined && h > prev + 1)
      add('heading_skip', `heading level jumps from h${prev} to h${h}`);
  });
  return issues;
}

/** Every `<img>` needs a non-empty alt (decorative images must be explicit: `alt=""` together with role="presentation" or aria-hidden="true"). */
export function checkAltText(html: string): HtmlIssue[] {
  const out: HtmlIssue[] = [];
  for (const t of tokenize(html)) {
    if (t.kind !== 'start' || t.name !== 'img') continue;
    const alt = attrOf(t, 'alt');
    const decorative = attrOf(t, 'role') === 'presentation' || attrOf(t, 'aria-hidden') === 'true';
    if (alt === undefined)
      out.push({ code: 'alt_missing', message: '<img> has no alt attribute', index: t.index });
    else if ((alt ?? '').trim() === '' && !decorative)
      out.push({
        code: 'alt_empty',
        message: '<img> has an empty alt and is not marked decorative',
        index: t.index,
      });
  }
  return out;
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
function normalizePath(p: string): string | undefined {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.pop() === undefined) return undefined;
    } else out.push(seg);
  }
  return out.join('/');
}
/**
 * Checks internal `href`/`src` (and meta refresh targets) of the generated HTML files: the target must be a generated file (directory URLs resolve to
 * index.html) and a `#fragment` must exist as an id in the target document. External (scheme, `//`) links are not checked.
 */
export function checkLinks(files: RenderedFile[]): LinkIssue[] {
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const idCache = new Map<string, Set<string>>();
  const tokensOf = new Map<string, Token[]>();
  const htmlFiles = files.filter((f) => f.path.endsWith('.html') && typeof f.content === 'string');
  for (const f of htmlFiles) tokensOf.set(f.path, tokenize(f.content as string));
  const idsOf = (path: string): Set<string> => {
    let s = idCache.get(path);
    if (!s) {
      s = new Set();
      for (const t of tokensOf.get(path) ?? [])
        if (t.kind === 'start') {
          const id = attrOf(t, 'id');
          if (id) s.add(id);
        }
      idCache.set(path, s);
    }
    return s;
  };
  const issues: LinkIssue[] = [];
  for (const f of htmlFiles) {
    const check = (href: string) => {
      const raw = decodeAttr(href).trim();
      if (raw === '' || EXTERNAL.test(raw)) return;
      const [beforeFrag = '', frag] = raw.split('#', 2) as [string, string | undefined];
      const pathPart = beforeFrag.split('?')[0] ?? '';
      let target: string | undefined;
      if (pathPart === '') target = f.path;
      else {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathPart);
        } catch {
          issues.push({ file: f.path, href, message: 'malformed percent-encoding' });
          return;
        }
        const joined = normalizePath(decoded.startsWith('/') ? decoded : `${dir}${decoded}`);
        if (joined === undefined) {
          issues.push({ file: f.path, href, message: 'path escapes the site root' });
          return;
        }
        const dirLike = decoded.endsWith('/') || joined === '';
        const candidates = dirLike
          ? [`${joined}${joined ? '/' : ''}index.html`]
          : [joined, `${joined}/index.html`];
        target = candidates.find((c) => byPath.has(c));
        if (target === undefined) {
          issues.push({ file: f.path, href, message: 'does not resolve to a generated file' });
          return;
        }
      }
      if (frag !== undefined && frag !== '' && frag !== 'top' && target.endsWith('.html')) {
        let want: string;
        try {
          want = decodeURIComponent(frag);
        } catch {
          want = frag;
        }
        if (!idsOf(target).has(want))
          issues.push({ file: f.path, href, message: `anchor #${want} not found in ${target}` });
      }
    };
    for (const t of tokensOf.get(f.path) ?? []) {
      if (t.kind !== 'start') continue;
      const h = attrOf(t, 'href');
      if ((t.name === 'a' || t.name === 'link' || t.name === 'area') && typeof h === 'string')
        check(h);
      const s = attrOf(t, 'src');
      if (typeof s === 'string' && ['img', 'script', 'source', 'track'].includes(t.name)) check(s);
      if (t.name === 'meta' && attrOf(t, 'http-equiv')?.toLowerCase() === 'refresh') {
        const m = /url\s*=\s*(\S+)/i.exec(attrOf(t, 'content') ?? '');
        if (m?.[1]) check(m[1]);
      }
    }
  }
  return issues;
}

/**
 * CSS declarations that should be logical properties. Reports physical `left`/`right` insets, margin/padding/border/scroll-margin sides, physical corner
 * radii, `float`/`clear`/`text-align` with left/right. `allow` lists property names that are knowingly permitted (e.g. `border-left`).
 */
export function lintPhysicalDirectionCss(css: string, allow: string[] = []): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const PROP =
    /^(left|right|(margin|padding|scroll-margin|scroll-padding)-(left|right)|border-(left|right)(-(width|color|style))?|border-(top|bottom)-(left|right)-radius)$/;
  const VALUE_PROP = /^(float|clear|text-align|text-align-last)$/;
  for (const m of src.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]*)/g)) {
    const prop = (m[1] ?? '').toLowerCase();
    const value = (m[2] ?? '').trim();
    if (allow.includes(prop)) continue;
    if (PROP.test(prop) || (VALUE_PROP.test(prop) && /^(left|right)\b/i.test(value)))
      out.push(`${prop}: ${value}`);
  }
  return out;
}

export interface ContrastReport extends ContrastIssue {
  message: string;
}
/** User-controlled colour pairs that fail WCAG AA 4.5:1 (the renderer repairs them automatically but reports them). Empty = fine. */
export function contrastIssues(model: SiteModel): ContrastReport[] {
  return computePalette(model).issues.map((i) => ({
    ...i,
    message: `${i.pair}: ${i.fg} on ${i.bg} is ${i.ratio}:1, below ${AA_NORMAL}:1 (WCAG AA); the renderer used black or white text instead`,
  }));
}
