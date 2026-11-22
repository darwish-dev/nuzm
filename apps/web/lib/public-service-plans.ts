import type { Locale } from '@nuzm/i18n';
import { SERVICES } from './site-content';

/** A plan as `GET /v1/public/hosting-plans` returns it: what the owner published (limits and price), nothing else. */
export interface PublicPlan {
  key: string;
  name: { ar: string; en: string };
  quotas: { diskMb: number; bandwidthGb: number; dbCount: number; sitesCount: number };
  runtimes: string[];
  price: { amountMinor: string; currency: string };
}

export type PlanGroup = 'web' | 'webapp' | 'agency' | 'cloud';

/** Which plan families each service page shows. A service that is not listed shows no plans: there is no published price list for it. */
export const SERVICE_PLAN_GROUPS: Record<string, PlanGroup[]> = {
  hosting: ['web', 'webapp', 'agency'],
  cloud: ['cloud'],
};

export const groupOf = (key: string): PlanGroup | null =>
  key.startsWith('webapp-')
    ? 'webapp'
    : key.startsWith('web-')
      ? 'web'
      : key.startsWith('agency-')
        ? 'agency'
        : key.startsWith('cloud-')
          ? 'cloud'
          : null;

export const GROUP_TITLE: Record<PlanGroup, { ar: string; en: string }> = {
  web: { ar: 'استضافة المواقع', en: 'Website hosting' },
  webapp: { ar: 'تطبيقات الويب', en: 'Web apps' },
  agency: { ar: 'الوكالات', en: 'Agencies' },
  cloud: { ar: 'الاستضافة السحابية', en: 'Cloud hosting' },
};

/** The plans of one service page, grouped in the page's order and cheapest first; a service with no plan families gets an empty list. */
export function plansForService(
  slug: string,
  plans: PublicPlan[],
): { group: PlanGroup; plans: PublicPlan[] }[] {
  return (SERVICE_PLAN_GROUPS[slug] ?? [])
    .map((group) => ({
      group,
      plans: plans
        .filter((p) => groupOf(p.key) === group)
        .sort((a, b) => Number(BigInt(a.price.amountMinor) - BigInt(b.price.amountMinor))),
    }))
    .filter((g) => g.plans.length > 0);
}

/** `9900` SAR minor units in a locale's own currency format (integer minor units in, never floats stored: this is display only). */
export function formatPlanPrice(amountMinor: string, currency: string, locale: Locale): string {
  const major = Number(BigInt(amountMinor) / 100n) + Number(BigInt(amountMinor) % 100n) / 100;
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(major);
}

const RUNTIME_NAMES: Record<string, string> = {
  php: 'PHP',
  nodejs: 'Node.js',
  python: 'Python',
  static: 'Static',
};
export const runtimeKinds = (runtimes: string[]): string[] => [
  ...new Set(runtimes.map((r) => RUNTIME_NAMES[r.split(':')[0]!] ?? r.split(':')[0]!)),
];

/** The limits of a plan as short lines in the page's language. */
export function planFeatures(p: PublicPlan, locale: Locale): string[] {
  const gb = (mb: number) => Math.round((mb / 1024) * 10) / 10;
  const n = (v: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US').format(v);
  const q = p.quotas;
  return locale === 'ar'
    ? [
        `${n(q.sitesCount)} ${q.sitesCount === 1 ? 'موقع' : 'مواقع'}`,
        `${n(gb(q.diskMb))} جيجابايت تخزين`,
        `${n(q.bandwidthGb)} جيجابايت نقل شهريًا`,
        `${n(q.dbCount)} قاعدة بيانات`,
      ]
    : [
        `${n(q.sitesCount)} ${q.sitesCount === 1 ? 'website' : 'websites'}`,
        `${n(gb(q.diskMb))} GB storage`,
        `${n(q.bandwidthGb)} GB bandwidth a month`,
        `${n(q.dbCount)} ${q.dbCount === 1 ? 'database' : 'databases'}`,
      ];
}

/** Server side: the published plans, or none when the API is unreachable (the page then simply has no plans section; nothing is ever invented). */
export async function fetchPublicPlans(): Promise<PublicPlan[]> {
  const { API_ORIGIN } = await import('./server');
  try {
    const res = await fetch(`${API_ORIGIN}/v1/public/hosting-plans`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: PublicPlan[] };
    return Array.isArray(body.items) ? body.items : [];
  } catch {
    return [];
  }
}

export const PLAN_SERVICES = Object.keys(SERVICE_PLAN_GROUPS).filter((s) =>
  SERVICES.some((x) => x.slug === s),
);
