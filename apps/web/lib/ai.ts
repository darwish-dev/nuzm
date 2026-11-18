/** Pure helpers of the customer AI screens (UI-M09-10 usage and credits, UI-M09-11 budgets). No I/O: unit-tested in `ai.spec.ts`. */

/** Digit grouping for an integer string ("1234567" → "1,234,567"); string arithmetic only, credits can exceed 2^53. */
export const groupDigits = (s: string): string => {
  const neg = s.startsWith('-');
  const d = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, '');
  return `${neg ? '-' : ''}${d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
};

export interface UsageModelRow {
  modelRef: string;
  calls: number;
  tokensIn: string;
  tokensOut: string;
  credits: string;
}
export interface UsageProjectRow {
  projectId: string | null;
  calls: number;
  credits: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const intStr = (v: unknown): string => (typeof v === 'string' && /^\d+$/.test(v) ? v : '0');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The API types the usage rows loosely (free-form objects): read them defensively, drop anything that is not a row. */
export function modelRows(rows: unknown[]): UsageModelRow[] {
  return rows.filter(isObj).map((r) => ({
    modelRef: typeof r.modelRef === 'string' ? r.modelRef : '—',
    calls: count(r.calls),
    tokensIn: intStr(r.tokensIn),
    tokensOut: intStr(r.tokensOut),
    credits: intStr(r.credits),
  }));
}
export function projectRows(rows: unknown[]): UsageProjectRow[] {
  return rows.filter(isObj).map((r) => ({
    projectId: typeof r.projectId === 'string' ? r.projectId : null,
    calls: count(r.calls),
    credits: intStr(r.credits),
  }));
}

/** Usage rows sorted by credits spent, largest first (BigInt compare: no float on money-like values). */
export const byCreditsDesc = <T extends { credits: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (BigInt(b.credits) > BigInt(a.credits) ? 1 : -1));

/** Credits to request in a top-up quote: a positive integer string of at most 15 digits, or null. */
export const parseTopUpCredits = (text: string): string | null =>
  /^[1-9]\d{0,14}$/.test(text.trim()) ? text.trim() : null;

/** Roles that may request a top-up quote: the permission the API checks for POST /v1/quotes. */
export const TOPUP_PERMISSION = 'quote:create';
/** Roles that may change budgets: the permission the API checks for PUT /v1/ai/budgets. */
export const BUDGET_WRITE_PERMISSION = 'ai:budgets:write';
/** Roles that may switch auto-apply on (the API answers 403 otherwise). */
export const AUTO_APPLY_PERMISSION = 'ai:write';

/* ------------------------------------------------------------------ budgets */

export interface BudgetDocDto {
  dailyCredits?: number | null;
  runMaxCredits?: number | null;
  runMaxTokens?: number | null;
  totalCredits?: number | null;
  totalTokens?: number | null;
  alertThresholds?: number[];
  logBodies?: boolean;
  bodyRetentionDays?: number | null;
  autoApplyLowRisk?: boolean;
}
export interface ProjectCapDto {
  projectId: string;
  totalCredits?: number | null;
  totalTokens?: number | null;
}

export const ORG_CAPS = [
  'dailyCredits',
  'runMaxCredits',
  'runMaxTokens',
  'totalCredits',
  'totalTokens',
] as const;
export type OrgCap = (typeof ORG_CAPS)[number];

export interface ProjectCapForm {
  projectId: string;
  totalCredits: string;
  totalTokens: string;
}
export interface BudgetForm {
  caps: Record<OrgCap, string>;
  thresholds: string;
  logBodies: boolean;
  retentionDays: string;
  autoApply: boolean;
  projects: ProjectCapForm[];
}

const capText = (v: number | null | undefined): string =>
  v === null || v === undefined ? '' : String(v);

/** The form state of the budgets the API returned (a never-set budget has no caps and the default thresholds). */
export function budgetForm(org: BudgetDocDto, projects: ProjectCapDto[]): BudgetForm {
  return {
    caps: {
      dailyCredits: capText(org.dailyCredits),
      runMaxCredits: capText(org.runMaxCredits),
      runMaxTokens: capText(org.runMaxTokens),
      totalCredits: capText(org.totalCredits),
      totalTokens: capText(org.totalTokens),
    },
    thresholds: (org.alertThresholds ?? [50, 80, 100]).join(', '),
    logBodies: org.logBodies === true,
    retentionDays: capText(org.bodyRetentionDays),
    autoApply: org.autoApplyLowRisk === true,
    projects: projects.map((p) => ({
      projectId: p.projectId,
      totalCredits: capText(p.totalCredits),
      totalTokens: capText(p.totalTokens),
    })),
  };
}

/** A cap: empty = no cap (null), otherwise a non-negative integer up to 1e12 (the API's limit). `undefined` = not valid. */
export function parseCap(text: string, max = 1e12): number | null | undefined {
  const v = text.trim();
  if (v === '') return null;
  if (!/^\d{1,13}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
}

/** Up to six distinct integers from 1 to 100, comma-separated. Null = not valid. */
export function parseThresholds(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) return null;
  return new Set(nums).size === nums.length ? nums.sort((a, b) => a - b) : null;
}

export type BudgetError = 'cap' | 'thresholds' | 'retention' | 'projectCap';

/**
 * The PUT body of the budgets form, or the first thing wrong with it. Prompt-body logging needs a retention period of 1..365 days (D-34),
 * which the API enforces too; project caps may be left empty (= no cap for that project).
 */
export function budgetBody(f: BudgetForm): {
  body?: { org: BudgetDocDto; projects: ProjectCapDto[] };
  error?: BudgetError;
} {
  const org: BudgetDocDto = {};
  for (const k of ORG_CAPS) {
    const v = parseCap(f.caps[k]);
    if (v === undefined) return { error: 'cap' };
    org[k] = v;
  }
  const th = parseThresholds(f.thresholds);
  if (!th) return { error: 'thresholds' };
  const retention = parseCap(f.retentionDays, 365);
  if (retention === undefined || (f.logBodies && (retention === null || retention < 1)))
    return { error: 'retention' };
  const projects: ProjectCapDto[] = [];
  for (const p of f.projects) {
    const c = parseCap(p.totalCredits);
    const k = parseCap(p.totalTokens);
    if (c === undefined || k === undefined) return { error: 'projectCap' };
    projects.push({ projectId: p.projectId, totalCredits: c, totalTokens: k });
  }
  return {
    body: {
      org: {
        ...org,
        alertThresholds: th,
        logBodies: f.logBodies,
        // the retention period is only kept while bodies are logged
        bodyRetentionDays: f.logBodies ? retention : null,
        autoApplyLowRisk: f.autoApply,
      },
      projects,
    },
  };
}

/** The ETag header value for the budget version the form was loaded with (`"0"` = never set). */
export const budgetsIfMatch = (version: number): string => `"${version}"`;

/** Which projects can still get a cap: the organization's projects minus those that already have a row. */
export const projectsWithoutCap = (
  all: { id: string; name: string }[],
  rows: ProjectCapForm[],
): { id: string; name: string }[] => all.filter((p) => !rows.some((r) => r.projectId === p.id));
