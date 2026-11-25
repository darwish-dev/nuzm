export type GateId =
  | 'structure'
  | 'html'
  | 'links'
  | 'csp'
  | 'size'
  | 'rtl'
  | 'contrast'
  | 'seo'
  | 'forms'
  | 'assets'
  | 'completeness'
  | 'a11y-axe';

export const ALL_GATES: readonly GateId[] = [
  'structure',
  'html',
  'links',
  'csp',
  'size',
  'rtl',
  'contrast',
  'seo',
  'forms',
  'assets',
  'completeness',
  'a11y-axe',
];

export interface QaFinding {
  gate: GateId;
  /** stable machine code, e.g. `csp.inline_script` */
  code: string;
  /** `error` fails the gate; `warning` is reported and never fails it */
  severity: 'error' | 'warning';
  file?: string;
  message: string;
  /** what to change, in words an agent (or a person) can act on */
  hint?: string;
}

export interface GateResult {
  gate: GateId;
  /** `skipped`: the gate could not run (a dependency is missing); it never counts as a pass in `qualified` */
  status: 'pass' | 'fail' | 'skipped';
  findings: QaFinding[];
  metrics: Record<string, number | string | boolean>;
  durationMs: number;
}

export interface QaBudgets {
  /** one HTML page, bytes */
  maxHtmlBytes: number;
  /** each stylesheet, bytes */
  maxCssBytes: number;
  /** each script, bytes */
  maxJsBytes: number;
  /** each image, bytes */
  maxImageBytes: number;
  /** the whole artifact, bytes */
  maxTotalBytes: number;
  /** gzip-compressed HTML + CSS + JS one page loads (Lighthouse-style transfer weight), bytes */
  maxPageTransferBytes: number;
  maxFiles: number;
}
export const DEFAULT_BUDGETS: QaBudgets = {
  maxHtmlBytes: 120 * 1024,
  maxCssBytes: 120 * 1024,
  maxJsBytes: 40 * 1024,
  maxImageBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxPageTransferBytes: 150 * 1024,
  maxFiles: 400,
};

export interface QaOptions {
  /** locales the site must serve; default: inferred from the top-level directories `ar/`, `en/` */
  locales?: string[];
  /** the CSP the host will send; default: the policy the platform sends (`defaultPolicy`) */
  policy?: string;
  /** the origin of the platform forms service (a contact form may post there); default none */
  formsOrigin?: string;
  budgets?: Partial<QaBudgets>;
  /** `publish` (default) forbids `noindex`; `preview` requires it */
  mode?: 'publish' | 'preview';
  /** pages per locale (default 1: any site; the business-website acceptance uses 5) */
  minPages?: number;
  /** page slugs that must exist in every locale (e.g. home, about, services, contact) */
  requiredSlugs?: string[];
  gates?: GateId[];
  /** run axe with this reader; `require` fails the gate when axe cannot be loaded instead of skipping it */
  axe?: 'auto' | 'require' | 'off';
}

export interface QaReport {
  schema: 'nuzm.website-qa/1';
  /** hash binding of the artifact that was checked (see `artifactManifest`) */
  rootHash: string;
  fileCount: number;
  totalBytes: number;
  locales: string[];
  pages: number;
  gates: GateResult[];
  counts: { errors: number; warnings: number };
  /** every requested gate ran and none failed */
  passed: boolean;
  /** `passed` AND no gate was skipped: the only value that may back a "QA passed" claim */
  qualified: boolean;
}
