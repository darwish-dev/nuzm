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

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------
 * The plan sections of the services pages, as plain data (built on the server, rendered by the tabs component)
 * ------------------------------------------------------------------------------------------------------------------------------------------------------------ */

export interface PlanCardData {
  key: string;
  name: string;
  sub?: string;
  price: string;
  unit: string;
  features: string[];
  runs?: { name: string; on: boolean }[];
  ctaLabel: string;
  ctaHref: string;
  fine: string;
}
export interface PlanGroupData {
  id: string;
  title: string;
  cards: PlanCardData[];
}
export interface PublicComputePlan {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  bandwidth?: string;
  price: { amountMinor: string; currency: string };
  regions: string[];
}
export interface PublicUsagePrice {
  meterId: string;
  model: 'flat' | 'graduated' | 'volume';
  unitPriceMinor: string | null;
  tiers: { upTo: string | null; unitPriceMinor: string }[] | null;
  includedAllowance: string;
}

const get = async <T>(path: string): Promise<T | null> => {
  const { API_ORIGIN } = await import('./server');
  try {
    const res = await fetch(`${API_ORIGIN}${path}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};
export const fetchComputePlans = async (): Promise<PublicComputePlan[]> =>
  (await get<{ items?: PublicComputePlan[] }>('/v1/public/compute-plans'))?.items ?? [];
export const fetchUsagePrices = async (): Promise<{
  currency: string;
  items: PublicUsagePrice[];
}> =>
  (await get<{ currency: string; items: PublicUsagePrice[] }>('/v1/public/usage-prices')) ?? {
    currency: 'SAR',
    items: [],
  };

/** A price in minor units that may carry a fraction (a rate per message, per GB): `0.1` SAR minor units is SAR 0.001. */
export function formatMinorRate(minor: string, currency: string, locale: Locale): string {
  const major = Number(minor) / 100;
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(major);
}

const REGION_LABEL: Record<string, { ar: string; en: string }> = {
  in_kingdom: { ar: 'داخل المملكة', en: 'Inside the Kingdom' },
  gcc: { ar: 'دول الخليج', en: 'GCC' },
  eu: { ar: 'أوروبا', en: 'Europe' },
  other: { ar: 'مناطق أخرى', en: 'Other regions' },
};

const t = (locale: Locale, en: string, ar: string) => (locale === 'ar' ? ar : en);
const num = (locale: Locale, n: number) =>
  new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', { maximumFractionDigits: 1 }).format(
    n,
  );

export function hostingGroups(slug: string, plans: PublicPlan[], locale: Locale): PlanGroupData[] {
  return plansForService(slug, plans).map(({ group, plans: list }) => ({
    id: group,
    title: GROUP_TITLE[group][locale],
    cards: list.map((p) => {
      const kinds = runtimeKinds(p.runtimes);
      const features = planFeatures(p, locale);
      return {
        key: p.key,
        name: p.name[locale],
        sub: `${features[0]} · ${features[1]}`,
        price: formatPlanPrice(p.price.amountMinor, p.price.currency, locale),
        unit: t(locale, '/mo', '/شهر'),
        features,
        runs: ['PHP', 'Node.js', 'Python', 'Static'].map((name) => ({
          name,
          on: kinds.includes(name),
        })),
        ctaLabel: t(locale, 'Choose plan', 'اختر الباقة'),
        ctaHref: '/hosting/sites/new',
        fine: t(
          locale,
          'Billed monthly, per site. Availability for your account and region is confirmed before you buy.',
          'تُحاسَب شهريًا لكل موقع. يُؤكَّد توفّر الباقة لحسابك ومنطقتك قبل الشراء.',
        ),
      };
    }),
  }));
}

export function serverGroups(plans: PublicComputePlan[], locale: Locale): PlanGroupData[] {
  if (plans.length === 0) return [];
  return [
    {
      id: 'servers',
      title: t(locale, 'Virtual servers', 'الخوادم الافتراضية'),
      cards: plans.map((p) => {
        const memGb = p.memoryMb / 1024;
        return {
          key: `${p.vcpu}-${p.memoryMb}-${p.diskGb}`,
          name: `${num(locale, p.vcpu)} vCPU`,
          sub: t(
            locale,
            `${num(locale, memGb)} GB memory · ${num(locale, p.diskGb)} GB disk`,
            `${num(locale, memGb)} جيجابايت ذاكرة · ${num(locale, p.diskGb)} جيجابايت قرص`,
          ),
          price: formatPlanPrice(p.price.amountMinor, p.price.currency, locale),
          unit: t(locale, '/mo', '/شهر'),
          features: [
            t(locale, `${num(locale, p.vcpu)} vCPU`, `${num(locale, p.vcpu)} نواة معالجة`),
            t(locale, `${num(locale, memGb)} GB memory`, `${num(locale, memGb)} جيجابايت ذاكرة`),
            t(locale, `${num(locale, p.diskGb)} GB disk`, `${num(locale, p.diskGb)} جيجابايت قرص`),
            ...(p.bandwidth
              ? [t(locale, `${p.bandwidth} transfer`, `${p.bandwidth} نقل بيانات`)]
              : []),
            t(locale, 'Regions: ', 'المناطق: ') +
              p.regions.map((r) => REGION_LABEL[r]?.[locale] ?? r).join(t(locale, ', ', '، ')),
          ],
          ctaLabel: t(locale, 'Choose server', 'اختر الخادم'),
          ctaHref: '/compute/offers',
          fine: t(
            locale,
            'Billed monthly. Data residency, quota and availability are checked for your account when you order.',
            'تُحاسَب شهريًا. تُفحص إقامة البيانات والحصة والتوفّر لحسابك عند الطلب.',
          ),
        };
      }),
    },
  ];
}

/** Pay-as-you-use rates (email, storage, AI) as cards; only meters the API returned are shown. */
export function usageGroups(
  slug: string,
  usage: { currency: string; items: PublicUsagePrice[] },
  locale: Locale,
): PlanGroupData[] {
  const c = usage.currency;
  const by = new Map(usage.items.map((i) => [i.meterId, i]));
  const rate = (minor: string) => formatMinorRate(minor, c, locale);
  const fine = t(
    locale,
    'Pay for what you use, billed from your wallet. Your account’s own rates are shown before you pay.',
    'تدفع مقابل ما تستخدمه، من محفظتك. تظهر أسعار حسابك قبل الدفع.',
  );
  const card = (
    key: string,
    name: string,
    sub: string,
    price: string,
    unit: string,
    features: string[],
    ctaHref: string,
  ): PlanCardData => ({
    key,
    name,
    sub,
    price,
    unit,
    features,
    ctaLabel: t(locale, 'Get started', 'ابدأ الآن'),
    ctaHref,
    fine,
  });
  const cards: PlanCardData[] = [];
  const msg = by.get('email.transactional_messages');
  if (slug === 'email' && msg?.unitPriceMinor) {
    const per1k = String(Number(msg.unitPriceMinor) * 1000);
    const allowance = Number(msg.includedAllowance);
    cards.push(
      card(
        'email',
        t(locale, 'Transactional email', 'البريد التشغيلي'),
        t(locale, 'Messages sent from your domain', 'رسائل ترسَل من نطاقك'),
        rate(per1k),
        t(locale, '/ 1,000 messages', '/ ١٬٠٠٠ رسالة'),
        [
          ...(allowance > 0
            ? [
                t(
                  locale,
                  `First ${num(locale, allowance)} messages included`,
                  `أول ${num(locale, allowance)} رسالة مشمولة`,
                ),
              ]
            : []),
          t(locale, 'Send from your own domain', 'أرسل من نطاقك الخاص'),
        ],
        '/email/domains',
      ),
    );
  }
  const store = by.get('storage.object_gb_months');
  const egress = by.get('network.egress_gb');
  if (slug === 'data' && store?.tiers?.length) {
    const [first, ...rest] = store.tiers;
    cards.push(
      card(
        'storage',
        t(locale, 'Object storage', 'تخزين الكائنات'),
        t(locale, 'Files, backups and media', 'ملفات ونسخ احتياطية ووسائط'),
        rate(first!.unitPriceMinor),
        t(locale, '/ GB / month', '/ جيجابايت / شهر'),
        [
          first!.upTo
            ? t(
                locale,
                `Up to ${num(locale, Number(first!.upTo))} GB at this rate`,
                `حتى ${num(locale, Number(first!.upTo))} جيجابايت بهذا السعر`,
              )
            : '',
          ...rest.map((r) =>
            t(
              locale,
              `Beyond that: ${rate(r.unitPriceMinor)} per GB`,
              `بعد ذلك: ${rate(r.unitPriceMinor)} لكل جيجابايت`,
            ),
          ),
        ].filter(Boolean),
        '/storage/buckets',
      ),
    );
  }
  if (slug === 'data' && egress?.tiers?.length) {
    let from = 0;
    cards.push(
      card(
        'egress',
        t(locale, 'Data transfer out', 'نقل البيانات للخارج'),
        t(locale, 'Traffic leaving the platform', 'حركة بيانات تخرج من المنصة'),
        rate(egress.tiers[0]!.unitPriceMinor),
        t(locale, '/ GB', '/ جيجابايت'),
        egress.tiers.map((r) => {
          const line = r.upTo
            ? t(
                locale,
                `${num(locale, from)}–${num(locale, Number(r.upTo))} GB: ${rate(r.unitPriceMinor)} per GB`,
                `${num(locale, from)}–${num(locale, Number(r.upTo))} جيجابايت: ${rate(r.unitPriceMinor)} لكل جيجابايت`,
              )
            : t(
                locale,
                `Over ${num(locale, from)} GB: ${rate(r.unitPriceMinor)} per GB`,
                `فوق ${num(locale, from)} جيجابايت: ${rate(r.unitPriceMinor)} لكل جيجابايت`,
              );
          from = r.upTo ? Number(r.upTo) : from;
          return line;
        }),
        '/storage/buckets',
      ),
    );
  }
  const ai = by.get('ai.credits_consumed');
  if (slug === 'ai-builder' && ai?.unitPriceMinor) {
    cards.push(
      card(
        'ai',
        t(locale, 'AI credits', 'أرصدة الذكاء الاصطناعي'),
        t(
          locale,
          'Used when AI builds and edits for you',
          'تُستهلك عندما يبني الذكاء الاصطناعي ويعدّل لك',
        ),
        rate(ai.unitPriceMinor),
        t(locale, '/ credit', '/ رصيد'),
        [
          t(locale, 'Credits are used by the builder and chat', 'يستهلك المنشئ والمحادثة الأرصدة'),
          t(locale, 'Your balance is always shown before a run', 'يظهر رصيدك دائمًا قبل كل تشغيل'),
        ],
        '/builder/projects',
      ),
    );
  }
  return cards.length
    ? [{ id: 'usage', title: t(locale, 'Pay as you use', 'ادفع حسب استخدامك'), cards }]
    : [];
}

/** Everything a service page's plan section shows, or an empty list when nothing has been published for it. */
export async function plansForPage(slug: string, locale: Locale): Promise<PlanGroupData[]> {
  if (slug === 'hosting' || slug === 'cloud')
    return hostingGroups(slug, await fetchPublicPlans(), locale);
  if (slug === 'vps') return serverGroups(await fetchComputePlans(), locale);
  if (slug === 'email' || slug === 'data' || slug === 'ai-builder')
    return usageGroups(slug, await fetchUsagePrices(), locale);
  return [];
}
