import { csp as platformCsp, type SiteModel } from '@nuzm/domain';
import type { ArtifactFile } from './artifact';
import { parseHtml, type ParsedHtml } from './html';
import { DEFAULT_BUDGETS, type QaBudgets, type QaOptions } from './types';

export interface PageInfo {
  path: string;
  /** `ar`, `en`, … from the first path segment; null for a file outside any locale directory */
  locale: string | null;
  /** `home` for the locale root, else the path between the locale and `index.html` */
  slug: string;
  html: string;
  doc: ParsedHtml;
}
export interface QaContext {
  files: ArtifactFile[];
  byPath: Map<string, ArtifactFile>;
  text: (p: string) => string | undefined;
  pages: PageInfo[];
  /** every .html file, including the root redirect */
  htmlFiles: PageInfo[];
  locales: string[];
  policy: string;
  formsOrigin: string | undefined;
  budgets: QaBudgets;
  mode: 'publish' | 'preview';
  minPages: number;
  requiredSlugs: string[];
}

const LOCALE_DIR = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
const dec = new TextDecoder('utf-8');

/** The policy the platform sends for a site (ADR-060): derived from the same `csp()` the preview and the host use, with a stand-in model that has a contact form iff a forms origin is given. */
export function defaultPolicy(formsOrigin?: string): string {
  const stand = {
    pages: formsOrigin ? [{ sections: [{ type: 'contact_form' }] }] : [],
  } as unknown as SiteModel;
  return platformCsp(stand, formsOrigin ? { formsBaseUrl: formsOrigin } : {});
}

export function buildContext(files: ArtifactFile[], opts: QaOptions = {}): QaContext {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const textCache = new Map<string, string>();
  const text = (p: string) => {
    const f = byPath.get(p);
    if (!f) return undefined;
    let t = textCache.get(p);
    if (t === undefined) {
      t = dec.decode(f.bytes);
      textCache.set(p, t);
    }
    return t;
  };
  const htmlFiles: PageInfo[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.html')) continue;
    const html = text(f.path)!;
    const segs = f.path.split('/');
    const locale = segs.length > 1 && LOCALE_DIR.test(segs[0]!) ? segs[0]! : null;
    const rest = locale ? segs.slice(1) : segs;
    if (rest[rest.length - 1] === 'index.html') rest.pop();
    htmlFiles.push({
      path: f.path,
      locale,
      slug: locale ? rest.join('/') || 'home' : rest.join('/'),
      html,
      doc: parseHtml(html),
    });
  }
  const pages = htmlFiles.filter((p) => p.locale !== null);
  const locales = opts.locales ?? [...new Set(pages.map((p) => p.locale!))].sort();
  const formsOrigin = opts.formsOrigin;
  return {
    files,
    byPath,
    text,
    pages,
    htmlFiles,
    locales,
    policy: opts.policy ?? defaultPolicy(formsOrigin),
    formsOrigin,
    budgets: { ...DEFAULT_BUDGETS, ...(opts.budgets ?? {}) },
    mode: opts.mode ?? 'publish',
    minPages: opts.minPages ?? 1,
    requiredSlugs: opts.requiredSlugs ?? [],
  };
}
