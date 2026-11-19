import type { Asset, FormDef, Locale, Page, SiteModel } from '../site-model';

export interface RenderOptions {
  /** absolute https base, overrides `model.seo.baseUrl` */
  baseUrl?: string;
  /** absolute (https?://host[:port][/path]) or ''; the form action is `${formsBaseUrl}/v1/public/forms/${formId}` */
  formsBaseUrl?: string;
  /** adds a "preview, not published" banner and `noindex` */
  previewBanner?: boolean;
  /** bytes of uploaded assets by contentHash */
  assetBytes?: Record<string, Uint8Array>;
}
export interface RenderedFile {
  path: string;
  mime: string;
  content: string | Uint8Array;
}
export type RenderIssueCode =
  | 'html'
  | 'link'
  | 'alt'
  | 'css_direction'
  | 'contrast'
  | 'unsafe_url'
  | 'missing_asset_bytes'
  | 'no_base_url';
export interface RenderIssue {
  code: RenderIssueCode;
  /** `error`: output is defective; `warning`: output rendered but adjusted/degraded; `info`: nothing is wrong, something is simply absent */
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
}
export interface RenderResult {
  files: RenderedFile[];
  /** `path` is the generated file path, e.g. `ar/about/index.html` */
  pages: { pageId: string; locale: Locale; path: string; title: string }[];
  issues: RenderIssue[];
  /**
   * `assets/styles.css` in `files` is the Tailwind SOURCE until the server compiles it: `compile(source, candidates)` (apps/api) yields the final stylesheet, which
   * replaces that file. Candidates are every class used by the generated pages, sorted.
   */
  tailwind: { source: string; candidates: string[] };
}

/** Options after validation/normalisation. */
export interface ResolvedOptions {
  baseUrl?: string;
  formsBase: string;
  previewBanner: boolean;
}
export interface RenderCtx {
  model: SiteModel;
  locale: Locale;
  page: Page;
  opts: ResolvedOptions;
  assets: Map<string, Asset>;
  forms: Map<string, FormDef>;
  issues: RenderIssue[];
  /** mutable per-page render state */
  state: { images: number; heroH1: boolean };
}
