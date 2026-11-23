/** Pure helpers of the customer template screens (S-K7: gallery, one template, recommendation, start from a template). No I/O: unit-tested in `templates.spec.ts`. */
import { tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';
import { problemKey, type BuilderProblem } from './builder';

/** Default off, per organization (ADR-065 addendum G): while it is off the whole surface answers 404 and the screens say "not available". */
export const TEMPLATES_FLAG = 'knowledge.customer_templates';

export type Template = Schemas['BuilderTemplate'];
export type TemplatePage = Schemas['BuilderTemplatePage'];
export type Candidate = Schemas['BuilderTemplateCandidate'];
export type Recommendation = Schemas['BuilderTemplateRecommendation'];
export type FromTemplateResult = Schemas['BuilderFromTemplateResult'];

export const MODES = ['STRICT', 'ADAPTIVE', 'CREATIVE'] as const;
export type AdaptationMode = (typeof MODES)[number];
export const PLATFORMS = ['WEB', 'MOBILE', 'BACKEND', 'FULL_STACK', 'CROSS_PLATFORM'] as const;

/** One query-string value, trimmed and bounded: anything else is dropped (the filter form never sends an object). */
export const text = (v: string | string[] | undefined, max = 120): string => {
  const s = (Array.isArray(v) ? v[0] : v) ?? '';
  return s.trim().slice(0, max);
};

/** The filters of the gallery, read from the URL (a bad platform is ignored, never forwarded). */
export function filtersOf(sp: Record<string, string | string[] | undefined>): {
  q: string;
  platform: string;
  framework: string;
  cursor: string;
} {
  const platform = text(sp.platform, 20);
  return {
    q: text(sp.q, 200),
    platform: (PLATFORMS as readonly string[]).includes(platform) ? platform : '',
    framework: text(sp.framework, 40),
    cursor: text(sp.cursor, 400),
  };
}

/** Query of the list call: only the filters that are set. */
export function listQuery(f: ReturnType<typeof filtersOf>): Record<string, string | number> {
  const q: Record<string, string | number> = { limit: 24 };
  if (f.q) q.q = f.q;
  if (f.platform) q.platform = f.platform;
  if (f.framework) q.framework = f.framework;
  if (f.cursor) q.cursor = f.cursor;
  return q;
}

/** `?q=…` link of the next page, keeping the filters. */
export function nextHref(locale: Locale, f: ReturnType<typeof filtersOf>, cursor: string): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.platform) p.set('platform', f.platform);
  if (f.framework) p.set('framework', f.framework);
  p.set('cursor', cursor);
  return `/${locale}/builder/templates?${p.toString()}`;
}

/** The reasons a refusal lists (`errors:[{field,message}]`), as codes only: they are mapped to sentences, the server text is never shown. */
export function reasonsOf(error: unknown): string[] {
  const list = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (x && typeof x === 'object' ? (x as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === 'string' && /^[a-z0-9_]{1,60}$/.test(m))
    .slice(0, 10);
}

/** A refusal of "start from a template", by its code (never the raw text). A pinned version that moved on has its own sentence. */
export function startProblemKey(p: BuilderProblem, reasons: string[]): MessageKey {
  if (p.code === 'knowledge_template_incompatible')
    return reasons.includes('pinned_version_unavailable')
      ? 'tpl.err.changed'
      : 'tpl.err.incompatible';
  if (p.code === 'change_rejected') return 'tpl.err.rejected';
  if (p.code === 'unsupported_capability') return 'tpl.err.unavailable';
  if (p.status === 404) return 'tpl.err.notfound';
  return problemKey(p);
}

/** Label of a reason code the engine gives (shared catalogue with the admin console); an unknown code is shown as is. */
export const reasonLabel = (locale: Locale, code: string): string =>
  tDynamic(locale, `kr.reason.${code}`, code);

/** Whole percent for a 0..100 score; never NaN. */
export const pct = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;

/** A colour that is safe to put in a style attribute: `#rgb`, `#rrggbb` or `#rrggbbaa`, nothing else. */
export const safeHex = (v: unknown): string | null =>
  typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : null;

/** The safe design summary of a template, typed (the API returns it as an open object). */
export interface DesignSummary {
  modes: string[];
  traits: { darkMode?: boolean; rtl?: boolean; tailwind?: boolean };
  roles: { role: string; hex: string }[];
  families: string[];
  baseUnit: number | null;
}
export function designOf(t: Template): DesignSummary | null {
  const d = t.design as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== 'object') return null;
  const strs = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  const roles = Array.isArray(d.roles)
    ? (d.roles as Record<string, unknown>[])
        .filter((r) => r && typeof r.role === 'string' && safeHex(r.hex))
        .slice(0, 12)
        .map((r) => ({ role: r.role as string, hex: r.hex as string }))
    : [];
  const traits = (d.traits && typeof d.traits === 'object' ? d.traits : {}) as Record<
    string,
    unknown
  >;
  return {
    modes: strs(d.modes, 4),
    traits: {
      ...(typeof traits.darkMode === 'boolean' ? { darkMode: traits.darkMode } : {}),
      ...(typeof traits.rtl === 'boolean' ? { rtl: traits.rtl } : {}),
      ...(typeof traits.tailwind === 'boolean' ? { tailwind: traits.tailwind } : {}),
    },
    roles,
    families: strs(d.families, 4),
    baseUnit: typeof d.baseUnit === 'number' && Number.isFinite(d.baseUnit) ? d.baseUnit : null,
  };
}

/** The request of the recommendation box. An empty text with no platform is not a request. */
export function recommendBody(i: {
  text: string;
  platform: string;
  mode: string;
}): Record<string, unknown> | null {
  const text = i.text.trim().slice(0, 2000);
  if (!text && !i.platform) return null;
  return {
    ...(text ? { text } : {}),
    ...((PLATFORMS as readonly string[]).includes(i.platform) ? { platform: i.platform } : {}),
    mode: (MODES as readonly string[]).includes(i.mode) ? i.mode : 'ADAPTIVE',
    limit: 6,
  };
}

/** A project name for a template: its name, at most 100 characters. */
export const defaultProjectName = (name: string | undefined): string =>
  (name ?? '').trim().slice(0, 100);
