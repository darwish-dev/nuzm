import { parseColor, type Rgba } from '../design/color';

/**
 * Eligibility, scoring and strategy for library retrieval and recommendation (S-K5, ADR-065 points 7 and 8). Pure functions: the same facts and settings give the same
 * ranking and the same explanation. Order of operations is fixed and permission-first:
 *   1. HARD FILTERS (`evaluateEligibility`): licence, publication, reuse permission, platform and framework compatibility, adaptation-mode needs. A resource that fails any of
 *      them is never ranked; every reason is reported.
 *   2. WEIGHTED MODEL (`scoreCandidate`, D-48): functional 25, framework 20, architecture 20, design 15, quality 10, reuse efficiency 10 by default, editable with an audit
 *      trail. Only the dimensions the requirement actually exercises (and that have evidence) count, and the weights are renormalised over them; the share of the configured
 *      weight that was exercised is reported as `confidence`. A dimension with no evidence is "not measured", never a number.
 *   3. STRATEGY (`decide`): an explicit user choice is honoured or explained, never silently replaced.
 */
export type Platform = 'WEB' | 'MOBILE' | 'BACKEND' | 'FULL_STACK' | 'CROSS_PLATFORM';
export const PLATFORM_LIST: readonly Platform[] = [
  'WEB',
  'MOBILE',
  'BACKEND',
  'FULL_STACK',
  'CROSS_PLATFORM',
];
export type Mode = 'STRICT' | 'ADAPTIVE' | 'CREATIVE';
export const MODES: readonly Mode[] = ['STRICT', 'ADAPTIVE', 'CREATIVE'];
export type Strategy = 'AUTO_SELECT' | 'USER_SELECTED' | 'ADMIN_DEFAULT' | 'GENERATE_FROM_SCRATCH';
export const STRATEGIES: readonly Strategy[] = [
  'AUTO_SELECT',
  'USER_SELECTED',
  'ADMIN_DEFAULT',
  'GENERATE_FROM_SCRATCH',
];
export type Usage = 'FULL_STARTER' | 'COMPONENTS' | 'ARCHITECTURE_ONLY';
export type DimensionId =
  'functional' | 'framework' | 'architecture' | 'design' | 'quality' | 'reuse';
export const DIMENSIONS: readonly DimensionId[] = [
  'functional',
  'framework',
  'architecture',
  'design',
  'quality',
  'reuse',
];
export type Weights = Record<DimensionId, number>;
export interface EngineSettings {
  weights: Weights;
  /** 0-100: the lowest score `AUTO_SELECT` accepts; below it the answer is "generate from scratch". */
  minScore: number;
}
export const DEFAULT_SETTINGS: EngineSettings = {
  weights: { functional: 25, framework: 20, architecture: 20, design: 15, quality: 10, reuse: 10 },
  minScore: 35,
};
/** Weights are integers 0-100 that sum to 100; the minimum score is an integer 0-100. */
export function validateSettings(
  x: unknown,
): { ok: true; value: EngineSettings } | { ok: false; error: string } {
  const o = x as { weights?: Record<string, unknown>; minScore?: unknown } | null;
  if (!o || typeof o !== 'object' || !o.weights || typeof o.weights !== 'object')
    return { ok: false, error: 'weights are required' };
  const w = {} as Weights;
  let sum = 0;
  for (const d of DIMENSIONS) {
    const v = o.weights[d];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100)
      return { ok: false, error: `weight ${d} must be an integer from 0 to 100` };
    w[d] = v;
    sum += v;
  }
  if (Object.keys(o.weights).some((k) => !(DIMENSIONS as readonly string[]).includes(k)))
    return { ok: false, error: 'unknown weight' };
  if (sum !== 100)
    return { ok: false, error: `weights must add up to 100 (they add up to ${sum})` };
  const m = o.minScore;
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 100)
    return { ok: false, error: 'minScore must be an integer from 0 to 100' };
  return { ok: true, value: { weights: w, minScore: m } };
}

// ---- compatibility ---------------------------------------------------------------------------------------------------------------
/** How well a resource's platform serves a requested one (1 = exactly; absent = incompatible). */
export const PLATFORM_FIT: Record<Platform, Partial<Record<Platform, number>>> = {
  WEB: { WEB: 1, FULL_STACK: 0.8, CROSS_PLATFORM: 0.6 },
  MOBILE: { MOBILE: 1, CROSS_PLATFORM: 0.8 },
  BACKEND: { BACKEND: 1, FULL_STACK: 0.8 },
  FULL_STACK: { FULL_STACK: 1 },
  CROSS_PLATFORM: { CROSS_PLATFORM: 1, MOBILE: 0.7 },
};
const ALIAS: Record<string, string> = {
  next: 'nextjs',
  'next.js': 'nextjs',
  nest: 'nestjs',
  'nest.js': 'nestjs',
  node: 'nodejs',
  'node.js': 'nodejs',
  'react.js': 'react',
  reactjs: 'react',
  tailwindcss: 'tailwind',
  'vue.js': 'vue',
  vuejs: 'vue',
  express: 'expressjs',
};
export const frameworkId = (s: string): string => {
  const k = s.toLowerCase().trim();
  return ALIAS[k] ?? k;
};

// ---- hard filters ----------------------------------------------------------------------------------------------------------------
export type Reason =
  | 'archived'
  | 'not_active'
  | 'not_published'
  | 'no_active_version'
  | 'license_not_allowed'
  | 'no_reuse_permission'
  | 'platform_incompatible'
  | 'framework_incompatible'
  | 'mode_needs_starter'
  | 'mode_needs_components'
  | 'ai_processing_not_allowed'
  | 'pinned_version_unavailable';
export interface Permissions {
  licenseVerdict: string;
  reuseScope: string;
  componentReuse: boolean;
  starterEligible: boolean;
  architectureReference: boolean;
  aiProcessing: boolean;
}
export interface Requirement {
  text?: string;
  platform?: Platform;
  frameworks?: string[];
  /** When true a resource missing any requested framework is excluded; otherwise frameworks only score. */
  frameworksRequired?: boolean;
  category?: string;
  plan?: string;
  mode: Mode;
  design?: {
    darkMode?: boolean;
    rtl?: boolean;
    arabicFont?: boolean;
    tailwind?: boolean;
    primaryColor?: string;
  };
  strategy?: Strategy;
  /** The resource the person chose (strategy USER_SELECTED). */
  resourceId?: string;
  /** The generation will send source to a model: the resource must permit AI processing (D-49). */
  requiresAiProcessing?: boolean;
}
export interface EligibilityInput {
  deleted: boolean;
  status: string;
  visibility: string;
  versionState: string | null;
  versionLicense: string | null;
  platform: string | null;
  /** Frameworks the staff entered plus the ones detection proved. */
  frameworks: string[];
  perms: Permissions | null;
  pinnedVersionId?: string | null;
  versionId?: string | null;
}
export interface Eligibility {
  eligible: boolean;
  reasons: Reason[];
}
export function allowedUsages(p: Permissions | null): Usage[] {
  if (!p) return [];
  const out: Usage[] = [];
  if (p.starterEligible && p.reuseScope === 'FULL_STARTER') out.push('FULL_STARTER');
  if (p.componentReuse && (p.reuseScope === 'COMPONENTS' || p.reuseScope === 'FULL_STARTER'))
    out.push('COMPONENTS');
  if (
    p.reuseScope !== 'NONE' &&
    (p.architectureReference || out.length > 0 || p.reuseScope === 'ARCHITECTURE_ONLY')
  )
    out.push('ARCHITECTURE_ONLY');
  return out;
}
export function recommendedUsage(p: Permissions | null, mode: Mode): Usage | null {
  const a = allowedUsages(p);
  if (!a.length) return null;
  if (mode === 'STRICT') return a.includes('FULL_STARTER') ? 'FULL_STARTER' : null;
  if (mode === 'ADAPTIVE')
    return a.includes('FULL_STARTER')
      ? 'FULL_STARTER'
      : a.includes('COMPONENTS')
        ? 'COMPONENTS'
        : null;
  return a.includes('ARCHITECTURE_ONLY') ? 'ARCHITECTURE_ONLY' : a[0]!;
}
export function evaluateEligibility(c: EligibilityInput, req: Requirement): Eligibility {
  const r: Reason[] = [];
  if (c.deleted || c.status === 'ARCHIVED') r.push('archived');
  else {
    if (c.status !== 'ACTIVE') r.push('not_active');
    if (!c.versionState || c.versionState !== 'ACTIVE') r.push('no_active_version');
  }
  if (c.visibility !== 'PLATFORM_PUBLISHED') r.push('not_published');
  if (c.versionLicense !== 'ALLOWED' || c.perms?.licenseVerdict !== 'ALLOWED')
    r.push('license_not_allowed');
  if (!c.perms || c.perms.reuseScope === 'NONE') r.push('no_reuse_permission');
  else if (req.mode === 'STRICT' && recommendedUsage(c.perms, 'STRICT') === null)
    r.push('mode_needs_starter');
  else if (req.mode === 'ADAPTIVE' && recommendedUsage(c.perms, 'ADAPTIVE') === null)
    r.push('mode_needs_components');
  if (req.platform) {
    const fit = c.platform ? PLATFORM_FIT[req.platform][c.platform as Platform] : undefined;
    if (fit === undefined) r.push('platform_incompatible'); // unknown is unsupported
  }
  if (req.frameworksRequired && req.frameworks?.length) {
    const have = new Set(c.frameworks.map(frameworkId));
    if (!req.frameworks.every((f) => have.has(frameworkId(f)))) r.push('framework_incompatible');
  }
  if (req.requiresAiProcessing && !c.perms?.aiProcessing) r.push('ai_processing_not_allowed');
  if (c.pinnedVersionId && c.versionId && c.pinnedVersionId !== c.versionId)
    r.push('pinned_version_unavailable');
  return { eligible: r.length === 0, reasons: r };
}

// ---- scoring ---------------------------------------------------------------------------------------------------------------------
/** How much a match counts, by where it was found. */
export const MATCH_WEIGHT: Record<string, number> = {
  SUMMARY: 1,
  FEATURE: 1,
  COMPONENT: 0.9,
  META: 0.8,
  DOC_SECTION: 0.7,
  SYMBOL: 0.6,
  API: 0.6,
  DESIGN: 0.4,
};
export interface DnaLike {
  traits?: { darkMode?: boolean; rtl?: boolean; arabicFont?: boolean; tailwind?: boolean };
  palette?: { mode: string; roles?: { role: string; hex: string | null }[] }[];
}
export interface ArchitectureLike {
  layers?: unknown[];
  cycles?: unknown[];
  entryReachability?: { roots: number; analysedFiles: number; unreachable: number } | null;
  stats?: { files?: number };
}
export interface ScoreInput {
  req: Requirement;
  /** Best match weight per term group that matched (a group that matched nothing is absent); `groups` is the number of groups of the requirement. */
  functional: { groups: number; matched: { group: string; weight: number }[] } | null;
  frameworks: string[];
  platform: string | null;
  architecture: ArchitectureLike | null;
  componentCount: number;
  dna: DnaLike | null;
  quality: { dimension: string; score: number | null }[];
  perms: Permissions | null;
}
export interface DimensionScore {
  dimension: DimensionId;
  /** The configured weight (percent). */
  weight: number;
  /** The weight after renormalising over the applicable dimensions (percent, one decimal). */
  effectiveWeight: number;
  /** 0-1, or null when the dimension does not apply or has no evidence. */
  score: number | null;
  applicable: boolean;
  /** Points this dimension adds to the final 0-100 score. */
  points: number;
  /** A machine code the UI translates: why it applies or not, and what it found. */
  note: string;
  detail?: Record<string, unknown>;
}
export interface Scored {
  /** True when the requirement states needs (text, frameworks, design) and the resource meets none of them: the score is 0 whatever its structure, quality or permissions. */
  gated: boolean;
  /** 0-100, one decimal. */
  score: number;
  /** Share (0-100) of the configured weight that was exercised by the requirement and had evidence. */
  confidence: number;
  dimensions: DimensionScore[];
}
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function lab(c: Rgba): [number, number, number] {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
/** Colour distance (CIE76) of two colours in 0-1 closeness: 1 identical, 0 at 60 or more apart. */
export function colourCloseness(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return clamp01(1 - Math.hypot(l1 - l2, a1 - a2, b1 - b2) / 60);
}

export function scoreCandidate(i: ScoreInput, s: EngineSettings): Scored {
  const dims: Omit<DimensionScore, 'effectiveWeight' | 'points' | 'weight'>[] = [];

  // functional: how many of the requirement's concept groups the resource covers, weighted by where they were found
  if (i.functional && i.functional.groups > 0) {
    const cov = i.functional.matched.reduce((a, m) => a + m.weight, 0) / i.functional.groups;
    dims.push({
      dimension: 'functional',
      applicable: true,
      score: clamp01(cov),
      note: 'functional.coverage',
      detail: { groups: i.functional.groups, matched: i.functional.matched.length },
    });
  } else
    dims.push({
      dimension: 'functional',
      applicable: false,
      score: null,
      note: 'functional.no_text',
    });

  // framework: share of the requested frameworks the resource has
  const asked = [...new Set((i.req.frameworks ?? []).map(frameworkId))];
  if (asked.length) {
    const have = new Set(i.frameworks.map(frameworkId));
    const hit = asked.filter((f) => have.has(f));
    dims.push({
      dimension: 'framework',
      applicable: true,
      score: hit.length / asked.length,
      note: 'framework.share',
      detail: { requested: asked.length, matched: hit.length },
    });
  } else
    dims.push({
      dimension: 'framework',
      applicable: false,
      score: null,
      note: 'framework.none_requested',
    });

  // architecture: the structure the analysis proved (modular layers, no import cycles, reachable code, analysed components) and the platform fit
  const parts: { w: number; v: number }[] = [];
  const a = i.architecture;
  if (a && i.componentCount > 0) {
    const layers = Array.isArray(a.layers) ? a.layers.length : 0;
    const cycles = Array.isArray(a.cycles) ? a.cycles.length : 0;
    const er = a.entryReachability;
    const reach = er && er.analysedFiles > 0 ? 1 - er.unreachable / er.analysedFiles : null;
    const structure =
      (layers >= 2 ? 0.25 : layers === 1 ? 0.12 : 0) +
      0.25 * Math.max(0, 1 - cycles / 5) +
      (reach === null ? 0 : 0.25 * clamp01(reach)) +
      0.25;
    parts.push({ w: 0.6, v: clamp01(structure) });
  }
  if (i.req.platform && i.platform) {
    const fit = PLATFORM_FIT[i.req.platform][i.platform as Platform];
    if (fit !== undefined) parts.push({ w: 0.4, v: fit });
  }
  if (parts.length) {
    const tw = parts.reduce((x, p) => x + p.w, 0);
    dims.push({
      dimension: 'architecture',
      applicable: true,
      score: parts.reduce((x, p) => x + p.w * p.v, 0) / tw,
      note:
        parts.length === 2
          ? 'architecture.structure_and_fit'
          : a && i.componentCount > 0
            ? 'architecture.structure'
            : 'architecture.platform_fit',
    });
  } else
    dims.push({
      dimension: 'architecture',
      applicable: false,
      score: null,
      note: 'architecture.not_analysed',
    });

  // design: the hints the requirement gives against the Design DNA; a hint the DNA cannot answer counts as unmet
  const d = i.req.design;
  const hints: { id: string; v: number }[] = [];
  if (d) {
    const t = i.dna?.traits;
    if (d.darkMode !== undefined)
      hints.push({ id: 'darkMode', v: t ? (t.darkMode === d.darkMode ? 1 : 0) : 0 });
    if (d.rtl !== undefined) hints.push({ id: 'rtl', v: t ? (t.rtl === d.rtl ? 1 : 0) : 0 });
    if (d.arabicFont !== undefined)
      hints.push({ id: 'arabicFont', v: t ? (t.arabicFont === d.arabicFont ? 1 : 0) : 0 });
    if (d.tailwind !== undefined)
      hints.push({ id: 'tailwind', v: t ? (t.tailwind === d.tailwind ? 1 : 0) : 0 });
    if (d.primaryColor) {
      const want = parseColor(d.primaryColor);
      const base = i.dna?.palette?.find((p) => p.mode === 'base') ?? i.dna?.palette?.[0];
      const hex = base?.roles?.find((r) => r.role === 'primary')?.hex;
      const have = hex ? parseColor(hex) : null;
      hints.push({ id: 'primaryColor', v: want && have ? colourCloseness(want, have) : 0 });
    }
  }
  if (hints.length)
    dims.push({
      dimension: 'design',
      applicable: true,
      score: hints.reduce((x, h) => x + h.v, 0) / hints.length,
      note: i.dna ? 'design.hints' : 'design.no_dna',
      detail: { hints: hints.map((h) => ({ id: h.id, score: round(h.v, 2) })) },
    });
  else dims.push({ dimension: 'design', applicable: false, score: null, note: 'design.no_hints' });

  // quality: measured dimensions only (each with its evidence); nothing measured = not measured, not zero
  const measured = i.quality.filter((q) => q.score !== null) as {
    dimension: string;
    score: number;
  }[];
  if (measured.length)
    dims.push({
      dimension: 'quality',
      applicable: true,
      score: clamp01(measured.reduce((x, q) => x + q.score, 0) / measured.length / 100),
      note: 'quality.measured',
      detail: { measured: measured.length },
    });
  else
    dims.push({
      dimension: 'quality',
      applicable: false,
      score: null,
      note: 'quality.not_measured',
    });

  // reuse efficiency: how much of the package the permissions let the platform reuse
  const scopeValue: Record<string, number> = {
    FULL_STARTER: 1,
    COMPONENTS: 0.7,
    ARCHITECTURE_ONLY: 0.4,
    NONE: 0,
  };
  dims.push({
    dimension: 'reuse',
    applicable: !!i.perms,
    score: i.perms ? (scopeValue[i.perms.reuseScope] ?? 0) : null,
    note: i.perms ? 'reuse.scope' : 'reuse.no_permissions',
  });

  const all = DIMENSIONS.reduce((x, k) => x + s.weights[k], 0) || 1;
  const active = dims.filter((x) => x.applicable && s.weights[x.dimension] > 0);
  const activeW = active.reduce((x, y) => x + s.weights[y.dimension], 0);
  const out: DimensionScore[] = dims.map((x) => {
    const w = s.weights[x.dimension];
    const used = x.applicable && w > 0 && activeW > 0;
    const eff = used ? (w / activeW) * 100 : 0;
    return {
      ...x,
      weight: w,
      effectiveWeight: round(eff),
      points: used && x.score !== null ? round((eff / 100) * x.score * 100, 2) : 0,
    };
  });
  // the requirement-driven dimensions establish relevance; structure, quality and permissions only modulate it. A resource that meets none of what was asked is not
  // relevant, however well built: its score is 0 (and says so), so it can never be selected on its intrinsic qualities alone.
  const driven = dims.filter(
    (x) =>
      x.applicable &&
      (x.dimension === 'functional' || x.dimension === 'framework' || x.dimension === 'design'),
  );
  const gated = driven.length > 0 && driven.every((x) => x.score === 0);
  const score = activeW > 0 && !gated ? out.reduce((a2, x) => a2 + x.points, 0) : 0;
  return {
    score: round(score),
    confidence: round((activeW / all) * 100),
    gated,
    dimensions: gated ? out.map((x) => ({ ...x, points: 0 })) : out,
  };
}

// ---- strategy --------------------------------------------------------------------------------------------------------------------
export interface DefaultRule {
  platform: string;
  framework: string;
  category: string;
  plan: string;
  mode: string;
  resourceId: string;
  versionPin: string | null;
}
/** The most specific admin default that matches the requirement (`*` matches anything); ties go to the lower resource id so the answer is stable. */
export function pickDefault(rules: DefaultRule[], req: Requirement): DefaultRule | null {
  const fw = new Set((req.frameworks ?? []).map(frameworkId));
  let best: { r: DefaultRule; n: number } | null = null;
  for (const r of rules) {
    let n = 0;
    const field = (rule: string, ok: boolean) => {
      if (rule === '*') return true;
      if (!ok) return false;
      n++;
      return true;
    };
    if (
      field(r.platform, req.platform === r.platform) &&
      field(r.framework, fw.has(frameworkId(r.framework))) &&
      field(
        r.category,
        !!req.category && req.category.toLowerCase() === r.category.toLowerCase(),
      ) &&
      field(r.plan, !!req.plan && req.plan === r.plan) &&
      field(r.mode, req.mode === r.mode)
    )
      if (!best || n > best.n || (n === best.n && r.resourceId < best.r.resourceId))
        best = { r, n };
  }
  return best?.r ?? null;
}
export interface RankedLite {
  resourceId: string;
  score: number;
}
export interface StrategyDecision {
  strategy: Strategy;
  selectedResourceId: string | null;
  /** Machine codes the UI translates. */
  notes: string[];
}
export function decide(a: {
  requested: Strategy;
  resourceId?: string;
  ranked: RankedLite[];
  adminDefault: { resourceId: string; eligible: boolean } | null;
  minScore: number;
}): StrategyDecision {
  const notes: string[] = [];
  if (a.requested === 'GENERATE_FROM_SCRATCH')
    return {
      strategy: 'GENERATE_FROM_SCRATCH',
      selectedResourceId: null,
      notes: ['requested_scratch'],
    };
  if (a.requested === 'USER_SELECTED') {
    const mine = a.resourceId ? a.ranked.find((r) => r.resourceId === a.resourceId) : undefined;
    // never substituted: an unavailable or incompatible choice is explained, the alternatives are listed separately
    return mine
      ? {
          strategy: 'USER_SELECTED',
          selectedResourceId: mine.resourceId,
          notes: ['user_choice_honoured'],
        }
      : { strategy: 'USER_SELECTED', selectedResourceId: null, notes: ['user_choice_ineligible'] };
  }
  if (a.requested === 'ADMIN_DEFAULT') {
    if (a.adminDefault?.eligible)
      return {
        strategy: 'ADMIN_DEFAULT',
        selectedResourceId: a.adminDefault.resourceId,
        notes: ['admin_default_used'],
      };
    notes.push(a.adminDefault ? 'admin_default_ineligible' : 'admin_default_none');
  }
  const top = a.ranked[0];
  if (top && top.score >= a.minScore)
    return {
      strategy: 'AUTO_SELECT',
      selectedResourceId: top.resourceId,
      notes: [...notes, 'auto_selected'],
    };
  return {
    strategy: 'GENERATE_FROM_SCRATCH',
    selectedResourceId: null,
    notes: [...notes, top ? 'below_min_score' : 'no_eligible_resource'],
  };
}
