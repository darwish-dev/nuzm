/** Types and helpers of the retrieval and recommendation console (S-K5, SCR-K-07). The shapes mirror the API responses. */
export const DIMENSIONS = [
  'functional',
  'framework',
  'architecture',
  'design',
  'quality',
  'reuse',
] as const;
export type DimensionId = (typeof DIMENSIONS)[number];
export const MODES = ['STRICT', 'ADAPTIVE', 'CREATIVE'] as const;
export const STRATEGIES = [
  'AUTO_SELECT',
  'USER_SELECTED',
  'ADMIN_DEFAULT',
  'GENERATE_FROM_SCRATCH',
] as const;
export const SEARCH_PLATFORMS = [
  'WEB',
  'MOBILE',
  'BACKEND',
  'FULL_STACK',
  'CROSS_PLATFORM',
] as const;
export const REASONS = [
  'archived',
  'not_active',
  'not_published',
  'no_active_version',
  'license_not_allowed',
  'no_reuse_permission',
  'platform_incompatible',
  'framework_incompatible',
  'mode_needs_starter',
  'mode_needs_components',
  'ai_processing_not_allowed',
  'pinned_version_unavailable',
  'not_found',
] as const;

export interface SearchHit {
  resourceId: string;
  versionId: string | null;
  versionSeq: number | null;
  name: string;
  description: string | null;
  resourceType: string;
  platform: string | null;
  frameworks: string[];
  category: string | null;
  tags: string[];
  status: string;
  relevance: number | null;
  matchedGroups: string[];
  matches: { kind: string; ref: string; title: string; snippet: string }[];
  components: { name: string; ref: string }[];
  eligibility: { eligible: boolean; reasons: string[] };
  license: { spdx: string | null; verdict: string };
}
export interface SearchResult {
  query: { text: string; groups: { key: string; from: string[]; concept: boolean }[] };
  total: number;
  items: SearchHit[];
}
export interface DimensionView {
  dimension: DimensionId;
  weight: number;
  effectiveWeight: number;
  score: number | null;
  applicable: boolean;
  points: number;
  note: string;
  detail?: Record<string, unknown>;
}
export interface RecommendedView {
  resourceId: string;
  versionId: string | null;
  versionSeq: number | null;
  name: string;
  resourceType: string;
  platform: string | null;
  frameworks: string[];
  category: string | null;
  score: number;
  confidence: number;
  gated: boolean;
  dimensions: DimensionView[];
  usage: { recommended: string | null; allowed: string[] };
  license: { spdx: string | null; verdict: string };
  matches: { kind: string; ref: string; title: string; snippet: string }[];
  components: { name: string; ref: string }[];
}
export interface RecommendationView {
  requirement: { groups: { key: string; from: string[]; concept: boolean }[] };
  settings: { weights: Record<string, number>; minScore: number; revision: number };
  decision: {
    requested: string;
    strategy: string;
    selectedResourceId: string | null;
    notes: string[];
  };
  selected: RecommendedView | null;
  userChoice: { resourceId: string; name: string | null; reasons: string[] } | null;
  adminDefault: { resourceId: string; eligible: boolean; reasons: string[] } | null;
  ranked: RecommendedView[];
  alternatives: RecommendedView[];
  excluded: { resourceId: string; name: string; reasons: string[] }[];
  stats: {
    considered: number;
    eligible: number;
    ranked: number;
    excluded: number;
    truncated: boolean;
  };
}
export interface EngineSettingsView {
  weights: Record<string, number>;
  minScore: number;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  defaults: { weights: Record<string, number>; minScore: number };
  isDefault: boolean;
}
export interface RevisionView {
  revision: number;
  value: { weights?: Record<string, number>; minScore?: number };
  previous: { weights?: Record<string, number>; minScore?: number } | null;
  changedBy: string | null;
  reason: string;
  createdAt: string | null;
}
export interface DefaultView {
  id: string;
  platform: string;
  framework: string;
  category: string;
  plan: string;
  mode: string;
  resourceId: string;
  resourceName: string | null;
  versionPin: string | null;
  updatedAt: string | null;
}

export const weightsTotal = (w: Record<string, number | string>) =>
  DIMENSIONS.reduce((a, d) => a + (Number.isFinite(Number(w[d])) ? Number(w[d]) : 0), 0);
/** A tri-state select value → the API value: '' leaves the hint out. */
export const triState = (v: string): boolean | undefined =>
  v === 'yes' ? true : v === 'no' ? false : undefined;
/** A requirement form → the request body; empty fields are left out. */
export function requirementBody(f: {
  text: string;
  platform: string;
  frameworks: string;
  frameworksRequired: boolean;
  mode: string;
  strategy: string;
  resourceId: string;
  requiresAi: boolean;
  dark: string;
  rtl: string;
  arabicFont: string;
  tailwind: string;
  primaryColor: string;
}): Record<string, unknown> {
  const b: Record<string, unknown> = { mode: f.mode, strategy: f.strategy };
  if (f.text.trim()) b.text = f.text.trim();
  if (f.platform) b.platform = f.platform;
  const fw = f.frameworks
    .split(/[,،\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (fw.length) b.frameworks = fw.slice(0, 10);
  if (f.frameworksRequired && fw.length) b.frameworksRequired = true;
  if (f.strategy === 'USER_SELECTED' && f.resourceId.trim()) b.resourceId = f.resourceId.trim();
  if (f.requiresAi) b.requiresAiProcessing = true;
  const design: Record<string, unknown> = {};
  for (const [k, v] of [
    ['darkMode', triState(f.dark)],
    ['rtl', triState(f.rtl)],
    ['arabicFont', triState(f.arabicFont)],
    ['tailwind', triState(f.tailwind)],
  ] as const)
    if (v !== undefined) design[k] = v;
  if (f.primaryColor.trim()) design.primaryColor = f.primaryColor.trim();
  if (Object.keys(design).length) b.design = design;
  return b;
}
