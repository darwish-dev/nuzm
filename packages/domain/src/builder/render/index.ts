import { validateSiteModel, type SiteModel } from '../site-model';
import { buildCss } from './css';
import {
  assetPath,
  FORMS_BASE_RE,
  pageFile,
  placeholderSvg,
  resolveBaseUrl,
  stripSlash,
} from './common';
import { SITE_JS } from './js';
import { computePalette } from './palette';
import { makeCtx, renderPage, renderRedirect } from './page';
import { buildRobots, buildSitemap } from './seo';
import type {
  RenderedFile,
  RenderIssue,
  RenderOptions,
  RenderResult,
  ResolvedOptions,
} from './types';
import { checkAltText, checkLinks, lintPhysicalDirectionCss, validateHtml } from './validate';

export type {
  RenderIssue,
  RenderIssueCode,
  RenderOptions,
  RenderResult,
  RenderedFile,
} from './types';
export { csp, seoReport } from './seo';
export {
  checkAltText,
  checkLinks,
  contrastIssues,
  contrastRatio,
  lintPhysicalDirectionCss,
  validateHtml,
  type HtmlIssue,
  type LinkIssue,
} from './validate';
export { pagePath, pageFile } from './common';

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
} as const;

/**
 * Trusted static renderer: a validated site model in, static files out. Deterministic (no clock, no randomness), pure, no I/O. Throws when the model is
 * invalid. Problems detected in the renderer's own output (validators run over everything generated) are returned in `issues`.
 */
export function renderSite(model: SiteModel, options: RenderOptions = {}): RenderResult {
  const problems = validateSiteModel(model);
  if (problems.length > 0)
    throw new Error(
      `Invalid site model: ${problems
        .slice(0, 5)
        .map((p) => `${p.path} ${p.message}`)
        .join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`,
    );
  const formsBaseRaw = options.formsBaseUrl ?? '';
  if (!FORMS_BASE_RE.test(formsBaseRaw))
    throw new RangeError('formsBaseUrl must be "" or an absolute http(s) URL');
  const opts: ResolvedOptions = {
    baseUrl: resolveBaseUrl(model, options.baseUrl),
    formsBase: stripSlash(formsBaseRaw),
    previewBanner: options.previewBanner === true,
  };
  const issues: RenderIssue[] = [];
  const files: RenderedFile[] = [];
  const pages: RenderResult['pages'] = [];
  const emitted = new Set<string>();
  const emit = (path: string, mime: string, content: string | Uint8Array) => {
    if (emitted.has(path)) return;
    emitted.add(path);
    files.push({ path, mime, content });
  };

  emit('index.html', MIME.html, renderRedirect(model, opts.baseUrl));

  const { palette, issues: contrast } = computePalette(model);
  for (const c of contrast)
    issues.push({
      code: 'contrast',
      severity: 'warning',
      message: `${c.pair}: ${c.fg} on ${c.bg} is ${c.ratio}:1 (WCAG AA needs ${c.required}:1); black or white text was used instead`,
      file: 'assets/styles.css',
    });
  const css = buildCss(model, palette);
  emit('assets/styles.css', MIME.css, css);
  emit('assets/site.js', MIME.js, SITE_JS);

  for (const a of model.assets) {
    if (a.source === 'placeholder') emit(assetPath(a), MIME.svg, placeholderSvg(a));
    else {
      const bytes = a.contentHash ? options.assetBytes?.[a.contentHash] : undefined;
      if (bytes) emit(assetPath(a), a.mime ?? 'application/octet-stream', bytes);
      else
        issues.push({
          code: 'missing_asset_bytes',
          severity: 'error',
          message: `no bytes provided for uploaded asset ${a.id}`,
          file: assetPath(a),
        });
    }
  }

  for (const locale of model.locales)
    for (const page of model.pages) {
      const { html, title } = renderPage(makeCtx(model, locale, page, opts, issues));
      const path = pageFile(locale, page.slug);
      emit(path, MIME.html, html);
      pages.push({ pageId: page.id, locale, path, title });
    }

  if (opts.baseUrl) {
    emit('sitemap.xml', MIME.xml, buildSitemap(model, opts.baseUrl));
    emit('robots.txt', MIME.txt, buildRobots(opts.baseUrl));
  } else
    issues.push({
      code: 'no_base_url',
      severity: 'info',
      message:
        'no absolute baseUrl: canonical, hreflang, Open Graph, sitemap.xml and robots.txt were not generated',
    });

  // self-check: run every validator over what was just generated
  const htmlFiles = files.filter((f) => f.path.endsWith('.html'));
  for (const f of htmlFiles) {
    const html = f.content as string;
    for (const i of validateHtml(html))
      issues.push({
        code: 'html',
        severity: 'error',
        message: `${i.code}: ${i.message}`,
        file: f.path,
      });
    for (const i of checkAltText(html))
      issues.push({
        code: 'alt',
        severity: 'error',
        message: `${i.code}: ${i.message}`,
        file: f.path,
      });
  }
  for (const l of checkLinks(files))
    issues.push({
      code: 'link',
      severity: 'error',
      message: `${l.href}: ${l.message}`,
      file: l.file,
    });
  for (const m of lintPhysicalDirectionCss(css))
    issues.push({
      code: 'css_direction',
      severity: 'error',
      message: m,
      file: 'assets/styles.css',
    });

  // the utility classes the pages use: the server compiles exactly these from the Tailwind source (deterministic: unique and sorted)
  const used = new Set<string>();
  for (const f of htmlFiles)
    for (const m of (f.content as string).matchAll(/\sclass="([^"]*)"/g))
      for (const c of (m[1] ?? '').split(/\s+/)) if (c) used.add(c);

  return { files, pages, issues, tailwind: { source: css, candidates: [...used].sort() } };
}
