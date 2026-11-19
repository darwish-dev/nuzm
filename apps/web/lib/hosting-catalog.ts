/**
 * Pure helpers of the hosting screens: which hosting TYPE a plan belongs to, the comparison rows read from a plan's own quotas, and the ways to add
 * a website. Nothing here invents a plan, a price or a feature: types are a grouping of the plans the API returns, rows come from the plan quotas
 * and runtimes, and a method that the platform cannot do yet says so.
 */

export const HOSTING_TYPES = ['web', 'cloud', 'webapp', 'agency'] as const;
export type HostingType = (typeof HOSTING_TYPES)[number];

/** The shape of `GET /v1/hosting/plans` that these helpers read. */
export interface CatalogPlan {
  id: string;
  key: string;
  name: { ar: string; en: string };
  quotas: {
    diskMb: number;
    inodes: number;
    bandwidthGb: number;
    dbCount: number;
    sitesCount: number;
    maxProcesses?: number;
  };
  runtimes: string[];
  price?: { amountMinor?: string; currency?: string; placeholder?: boolean } | null;
}

/**
 * A plan key is `<type>-<tier>` (web-start, cloud-pro, agency-50...). A key with no known type prefix is plain web hosting, so a plan created
 * before types existed is still listed.
 */
export function typeOfPlan(key: string): HostingType {
  const head = key.split('-')[0] ?? '';
  return (HOSTING_TYPES as readonly string[]).includes(head) ? (head as HostingType) : 'web';
}

/** Types that have at least one plan, in the fixed display order, each with its plans smallest first. */
export function typesWithPlans(
  plans: CatalogPlan[],
): { type: HostingType; plans: CatalogPlan[] }[] {
  return HOSTING_TYPES.map((type) => ({
    type,
    plans: plans
      .filter((p) => typeOfPlan(p.key) === type)
      .sort((a, b) => a.quotas.diskMb - b.quotas.diskMb || a.key.localeCompare(b.key)),
  })).filter((g) => g.plans.length > 0);
}

export const gbText = (mb: number): string =>
  mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`;
/** 2_000_000 → "2M": file-count limits read better short. */
export const countText = (n: number): string =>
  n >= 1_000_000
    ? `${Math.round((n / 1_000_000) * 10) / 10}M`
    : n >= 1000
      ? `${Math.round(n / 100) / 10}K`
      : String(n);

export const RUNTIME_GROUPS = [
  { id: 'static', match: 'static', label: 'Static' },
  { id: 'php', match: 'php', label: 'PHP' },
  { id: 'nodejs', match: 'nodejs', label: 'Node.js' },
  { id: 'python', match: 'python', label: 'Python' },
] as const;
/** Whether a plan offers a runtime family (`php` matches `php:8.3`). */
export const offersRuntime = (p: Pick<CatalogPlan, 'runtimes'>, family: string): boolean =>
  p.runtimes.some((r) => r === family || r.startsWith(`${family}:`));

export type CompareRowId =
  | 'sites'
  | 'storage'
  | 'traffic'
  | 'databases'
  | 'files'
  | 'processes'
  | 'static'
  | 'php'
  | 'nodejs'
  | 'python';
export type CompareValue =
  { kind: 'text'; value: string } | { kind: 'yes' } | { kind: 'no' } | { kind: 'unknown' };

/** One comparison row for one plan, read from the plan itself. A limit the plan does not state is `unknown`, never a guess. */
export function compareValue(p: CatalogPlan, row: CompareRowId): CompareValue {
  const q = p.quotas;
  const text = (v: string): CompareValue => ({ kind: 'text', value: v });
  switch (row) {
    case 'sites':
      return text(String(q.sitesCount));
    case 'storage':
      return text(gbText(q.diskMb));
    case 'traffic':
      return text(`${q.bandwidthGb} GB`);
    case 'databases':
      return text(String(q.dbCount));
    case 'files':
      return text(countText(q.inodes));
    case 'processes':
      return q.maxProcesses === undefined ? { kind: 'unknown' } : text(String(q.maxProcesses));
    default:
      return offersRuntime(p, row) ? { kind: 'yes' } : { kind: 'no' };
  }
}
export const COMPARE_ROWS: CompareRowId[] = [
  'sites',
  'storage',
  'traffic',
  'databases',
  'files',
  'processes',
  'static',
  'php',
  'nodejs',
  'python',
];

// ---- ways to add a website ----------------------------------------------------------------------------------------------------------

export type SiteMethod = 'ai' | 'wordpress' | 'static' | 'php' | 'nodejs';
export interface MethodInfo {
  id: SiteMethod;
  /** The runtime family a plan must offer; the AI builder has none (it makes its own project). */
  runtime?: 'static' | 'php' | 'nodejs';
  /** False while the platform cannot do it yet: shown, never selectable. */
  available: boolean;
}
export const SITE_METHODS: MethodInfo[] = [
  { id: 'ai', available: true },
  { id: 'wordpress', available: false },
  { id: 'static', runtime: 'static', available: true },
  { id: 'php', runtime: 'php', available: true },
  { id: 'nodejs', runtime: 'nodejs', available: true },
];
export const isSiteMethod = (v: unknown): v is SiteMethod =>
  typeof v === 'string' && SITE_METHODS.some((m) => m.id === v);
export const methodInfo = (id: SiteMethod): MethodInfo => SITE_METHODS.find((m) => m.id === id)!;

/** The runtimes of a plan that a method can use (`php` → php:8.3, php:8.2); empty when the plan cannot host the method. */
export const runtimesFor = (method: MethodInfo, p: Pick<CatalogPlan, 'runtimes'>): string[] =>
  method.runtime
    ? p.runtimes.filter((r) => r === method.runtime || r.startsWith(`${method.runtime}:`))
    : [];
