/** Pure helpers and shapes of the AI Studio panel (ADR-064). No I/O: tested in `ai-studio.spec.ts`. */
export const AI_STUDIO_FLAG = 'ai_studio.enabled';
export type StudioView = 'instructions' | 'skills' | 'github' | 'files' | 'claude';
export const STRENGTHS = ['must', 'should', 'never', 'may'] as const;
export type Strength = (typeof STRENGTHS)[number];

export interface InstructionRule {
  text: string;
  strength: Strength;
  key?: string;
}
export interface InstructionSection {
  id: string;
  title: string;
  rules: InstructionRule[];
}
export interface Instructions {
  projectId: string;
  version: number;
  projectLayer: InstructionSection[];
  customerLayer: InstructionSection[];
  customerBlock: string;
  baseline: { source: string; sections: InstructionSection[] }[];
  markdown: string;
  conflicts: unknown[];
  updatedAt: string | null;
  canSync: boolean;
}
export interface SkillRecommendation {
  install: string[];
  blocked: { slug: string; reason: string; detail?: string }[];
  reasons: Record<string, string>;
  installed: string[];
}
export interface GithubConnection {
  available: boolean;
  adapter: 'github-app' | 'fake' | null;
  connection: { accountLogin: string; state: string } | null;
  installUrl: string | null;
}
export interface GithubStatus {
  linked: {
    fullName: string;
    defaultBranch: string;
    private: boolean;
    lastSyncedSha: string | null;
  } | null;
  remoteTip: string | null;
  localChanged: boolean;
  remoteChanged: boolean;
}
export interface SearchResult {
  query: string;
  paths: string[];
  matches: { path: string; line: number; preview: string }[];
  truncated: boolean;
}
export interface ClaudeCodeStatus {
  enabled: boolean;
  complianceApproved: boolean;
  available: boolean;
  reason: 'flag_off' | 'compliance_pending' | null;
  session: { state: string; binaryVersion: string | null; errorCode: string | null } | null;
}

/** A section id the API accepts: unique within the layer. */
export function newSectionId(existing: readonly InstructionSection[]): string {
  let n = existing.length + 1;
  while (existing.some((s) => s.id === `section-${n}`)) n++;
  return `section-${n}`;
}
export const addSection = (v: InstructionSection[], title: string): InstructionSection[] => [
  ...v,
  { id: newSectionId(v), title, rules: [{ text: '', strength: 'should' }] },
];
export const addRule = (v: InstructionSection[], si: number): InstructionSection[] =>
  v.map((s, i) => (i === si ? { ...s, rules: [...s.rules, { text: '', strength: 'should' }] } : s));
export const removeRule = (v: InstructionSection[], si: number, ri: number): InstructionSection[] =>
  v.map((s, i) => (i === si ? { ...s, rules: s.rules.filter((_, j) => j !== ri) } : s));
export const setRule = (
  v: InstructionSection[],
  si: number,
  ri: number,
  patch: Partial<InstructionRule>,
): InstructionSection[] =>
  v.map((s, i) =>
    i === si ? { ...s, rules: s.rules.map((r, j) => (j === ri ? { ...r, ...patch } : r)) } : s,
  );

/** The `state` of the GitHub App installation callback, or null when the address does not carry a usable one. */
export function installCallback(q: Record<string, string | string[] | undefined>): {
  installationId: number;
  state: string;
} | null {
  const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x);
  const id = Number(one(q.installation_id));
  const state = one(q.state);
  if (!Number.isSafeInteger(id) || id <= 0 || !state || state.length > 2000) return null;
  return { installationId: id, state };
}
