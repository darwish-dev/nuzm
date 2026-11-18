import { mockArchitecture, assembleModel, mockRequirementsTurn } from './mock-agents';
import { renderSite, seoReport } from './render';
import { validateSiteModel, type SiteModel } from './site-model';
import type { Architecture, Requirements } from './artifacts';

/**
 * Evaluation harness (M09 S41.5, AC-M09-12). 40 prompts (20 Arabic, 20 English) over the 8 site categories. Each generated site gets AUTOMATED checks; the human rubric
 * (blinded, owner-approved reviewers, ≥ 10 sampled sites) is a separate record that this code never fills in. The a11y / SEO / performance numbers here are PROXIES computed
 * from the rendered output (not Lighthouse): a real run needs a browser and the owner's thresholds. With the scripted mock model the report proves PLUMBING only and
 * says `modelQuality: 'NOT VERIFIED'`.
 */
export const CATEGORIES = [
  'restaurant',
  'clinic',
  'retail',
  'portfolio',
  'services',
  'education',
  'ngo',
  'landing',
] as const;
const SUBJECT: Record<(typeof CATEGORIES)[number], { ar: string[]; en: string[] }> = {
  restaurant: {
    ar: [
      'مطعم عائلي في الرياض يقدم أطباقًا شعبية',
      'مقهى مختص في جدة يقدم القهوة والحلويات',
      'مطعم بحري في الدمام',
    ],
    en: [
      'A family restaurant in Riyadh serving traditional dishes',
      'A specialty coffee shop in Jeddah with desserts',
      'A seafood restaurant in Dammam',
    ],
  },
  clinic: {
    ar: ['عيادة أسنان في الخبر', 'مركز طبي للأسرة في المدينة المنورة', 'عيادة جلدية في الرياض'],
    en: [
      'A dental clinic in Khobar',
      'A family medical centre in Madinah',
      'A dermatology clinic in Riyadh',
    ],
  },
  retail: {
    ar: ['متجر عطور وعود في الرياض', 'متجر ملابس أطفال إلكتروني', 'متجر تمور فاخرة في القصيم'],
    en: [
      'A perfume and oud shop in Riyadh',
      'An online kids clothing store',
      'A premium dates shop in Qassim',
    ],
  },
  portfolio: {
    ar: ['مصممة جرافيك مستقلة', 'مصور فوتوغرافي للمناسبات', 'مهندس معماري يعرض مشاريعه'],
    en: [
      'A freelance graphic designer',
      'An event photographer',
      'An architect showing selected projects',
    ],
  },
  services: {
    ar: ['شركة صيانة وتكييف في جدة', 'مكتب محاسبة للشركات الصغيرة', 'خدمات تنظيف منازل في الرياض'],
    en: [
      'An AC maintenance company in Jeddah',
      'An accounting office for small businesses',
      'A home cleaning service in Riyadh',
    ],
  },
  education: {
    ar: ['أكاديمية لتعليم البرمجة للأطفال', 'معهد لغة إنجليزية في الرياض', 'مركز دروس خصوصية'],
    en: [
      'A coding academy for kids',
      'An English language institute in Riyadh',
      'A tutoring centre',
    ],
  },
  ngo: {
    ar: ['جمعية خيرية لإطعام الأسر', 'جمعية لرعاية الأيتام', 'مبادرة تطوعية لتنظيف الشواطئ'],
    en: [
      'A charity feeding families',
      'An orphan care association',
      'A volunteer beach clean-up initiative',
    ],
  },
  landing: {
    ar: ['تطبيق جوال لتوصيل الخضار', 'دورة تدريبية عن التسويق الرقمي', 'منتج جديد لتبريد المياه'],
    en: [
      'A grocery delivery mobile app',
      'A digital marketing course',
      'A new water cooling product',
    ],
  },
};
export interface EvalPrompt {
  id: string;
  category: (typeof CATEGORIES)[number];
  lang: 'ar' | 'en';
  text: string;
}
/** 8 categories × 5 prompts = 40; 20 Arabic and 20 English (odd categories: 3 ar + 2 en, even: 2 ar + 3 en). */
export const EVAL_PROMPTS: readonly EvalPrompt[] = CATEGORIES.flatMap((cat, ci) => {
  const nAr = ci % 2 === 0 ? 3 : 2;
  const ar = SUBJECT[cat].ar.slice(0, nAr).map((t, i) => ({
    id: `${cat}-ar-${i + 1}`,
    category: cat,
    lang: 'ar' as const,
    text: `أريد موقعًا لـ ${t}. اجعله بسيطًا واحترافيًا.`,
  }));
  const en = SUBJECT[cat].en.slice(0, 5 - nAr).map((t, i) => ({
    id: `${cat}-en-${i + 1}`,
    category: cat,
    lang: 'en' as const,
    text: `I need a website for ${t}. Keep it simple and professional.`,
  }));
  return [...ar, ...en];
});

/** PROPOSALS pending the owner's approval (D-18/D-32); the report flags breaches against them without deciding anything. */
export const EVAL_THRESHOLDS = {
  htmlErrorFreeSites: 0.95,
  a11yScore: 90,
  seoScore: 90,
  performanceScore: 80,
  requirementCoverage: 0.9,
  humanRubricMean: 4.0,
} as const;

export interface SiteMetrics {
  htmlErrors: number;
  a11yScore: number;
  seoScore: number;
  performanceScore: number;
  requirementCoverage: number;
  valid: boolean;
}
export function evaluateSite(model: SiteModel, req: Requirements): SiteMetrics {
  const valid = validateSiteModel(model).length === 0;
  const out = renderSite(model, {
    baseUrl: 'https://eval.example.test',
    formsBaseUrl: 'https://api.example.test/p/eval',
  });
  const errors = out.issues.filter((i) => i.severity === 'error');
  const a11yIssues = out.issues.filter(
    (i) =>
      ['error', 'warning'].includes(i.severity) &&
      /alt|contrast|heading|label|lang|dir|aria/i.test(`${i.code} ${i.message}`),
  ).length;
  const seo = seoReport(model, out).score;
  // performance proxy: total page weight and external requests (the output makes none by construction)
  const htmlBytes = out.files
    .filter((f) => f.path.endsWith('.html'))
    .map((f) => (typeof f.content === 'string' ? f.content.length : f.content.length));
  const avg = htmlBytes.length ? htmlBytes.reduce((a, b) => a + b, 0) / htmlBytes.length : 0;
  const performance = Math.max(
    0,
    Math.min(100, Math.round(100 - Math.max(0, avg - 30_000) / 1000)),
  );
  const slugs = new Set(model.pages.map((p) => p.slug));
  const checks = [
    req.pages.every(
      (k) => slugs.has(k === 'home' ? 'home' : k) || model.pages.some((p) => p.id === k),
    ),
    req.languages.every((l) => model.locales.includes(l)),
    !req.integrations.includes('contact_form') || model.forms.length > 0,
    !req.integrations.includes('map') ||
      model.pages.some((p) => p.sections.some((s) => s.type === 'map')),
  ];
  return {
    htmlErrors: errors.length,
    a11yScore: Math.max(0, 100 - a11yIssues * 10),
    seoScore: seo,
    performanceScore: performance,
    requirementCoverage: checks.filter(Boolean).length / checks.length,
    valid,
  };
}

export interface EvalReport {
  createdAt: string;
  model: string;
  modelQuality: 'NOT VERIFIED' | 'VERIFIED';
  sites: number;
  byLanguage: { ar: number; en: number };
  metrics: Record<keyof typeof EVAL_THRESHOLDS, number | null>;
  breaches: string[];
  thresholds: typeof EVAL_THRESHOLDS;
  rubric: { status: 'PENDING'; note: string };
  notes: string[];
  perSite: { id: string; metrics: SiteMetrics }[];
}
export type SiteGenerator = (p: EvalPrompt) => {
  requirements: Requirements;
  architecture: Architecture;
  model: SiteModel;
};

/** The scripted mock "generator": requirements (defaults) → architecture → assembled model. PLUMBING ONLY: never evidence of model quality. */
export const mockGenerator: SiteGenerator = (p) => {
  const requirements = mockRequirementsTurn({ description: p.text, skip: true }).requirements!;
  const architecture = mockArchitecture(requirements);
  return { requirements, architecture, model: assembleModel(requirements, architecture) };
};

export function runEvaluation(
  generate: SiteGenerator,
  o: { model: string; verifiedModel?: boolean; prompts?: readonly EvalPrompt[] },
): EvalReport {
  const prompts = o.prompts ?? EVAL_PROMPTS;
  const per = prompts.map((p) => {
    const g = generate(p);
    return { id: p.id, lang: p.lang, metrics: evaluateSite(g.model, g.requirements) };
  });
  const n = per.length;
  const share = (f: (m: SiteMetrics) => boolean) => per.filter((x) => f(x.metrics)).length / n;
  const metrics = {
    htmlErrorFreeSites: share((m) => m.htmlErrors === 0),
    a11yScore: share((m) => m.a11yScore >= EVAL_THRESHOLDS.a11yScore),
    seoScore: share((m) => m.seoScore >= EVAL_THRESHOLDS.seoScore),
    performanceScore: share((m) => m.performanceScore >= EVAL_THRESHOLDS.performanceScore),
    requirementCoverage: per.reduce((a, x) => a + x.metrics.requirementCoverage, 0) / n,
    humanRubricMean: null,
  } as EvalReport['metrics'];
  const breaches: string[] = [];
  if ((metrics.htmlErrorFreeSites ?? 0) < EVAL_THRESHOLDS.htmlErrorFreeSites)
    breaches.push('htmlErrorFreeSites');
  if ((metrics.a11yScore ?? 0) < 0.9) breaches.push('a11yScore');
  if ((metrics.seoScore ?? 0) < 0.9) breaches.push('seoScore');
  if ((metrics.performanceScore ?? 0) < 0.8) breaches.push('performanceScore');
  if ((metrics.requirementCoverage ?? 0) < EVAL_THRESHOLDS.requirementCoverage)
    breaches.push('requirementCoverage');
  return {
    createdAt: new Date().toISOString(),
    model: o.model,
    modelQuality: o.verifiedModel ? 'VERIFIED' : 'NOT VERIFIED',
    sites: n,
    byLanguage: {
      ar: per.filter((x) => x.lang === 'ar').length,
      en: per.filter((x) => x.lang === 'en').length,
    },
    metrics,
    breaches,
    thresholds: EVAL_THRESHOLDS,
    rubric: {
      status: 'PENDING',
      note: 'Blinded human rubric on ≥ 10 sampled sites by owner-approved reviewers is not part of this report (BLOCKED until HG-09-01/D-18 and reviewers).',
    },
    notes: [
      'a11y, SEO and performance are PROXIES computed from the rendered output, not Lighthouse',
      'thresholds are PROPOSALS pending owner approval',
      o.verifiedModel
        ? 'real model'
        : 'scripted mock model: plumbing only, not evidence of quality',
    ],
    perSite: per.map((x) => ({ id: x.id, metrics: x.metrics })),
  };
}
