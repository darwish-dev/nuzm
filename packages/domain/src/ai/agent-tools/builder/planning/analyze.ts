import { FEATURES } from './features';
import { PROFILES } from './profiles';
import { UNSUPPORTED_STACKS } from './profiles-core';
import {
  PLAN_LIMITS,
  type Bilingual,
  type Locale,
  type ProductType,
  type RequirementAnalysis,
} from './types';

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ARABIC = /[؀-ۿ]/g;

/** Lower-cases Latin text and folds Arabic spelling variants (diacritics, tatweel, alef forms, ya/alef-maqsura, ta-marbuta) so keywords match however they are typed. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase();
}

export function detectLocale(s: string): Locale {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 'en';
  return (s.match(ARABIC)?.length ?? 0) / letters.length > 0.3 ? 'ar' : 'en';
}

const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reCache = new Map<string, RegExp>();
function hits(text: string, en: readonly string[], ar: readonly string[]): number {
  let n = 0;
  for (const k of en) {
    const key = k.toLowerCase();
    let re = reCache.get(key);
    if (!re) {
      // Latin keywords match on word boundaries ("cart" is not "carting"); a hyphen or space inside is literal
      re = new RegExp(`(?<![a-z0-9])${esc(key)}(?![a-z0-9])`);
      reCache.set(key, re);
    }
    if (re.test(text)) n += key.includes(' ') || key.includes('-') ? 2 : 1;
  }
  for (const k of ar) {
    const nk = normalizeText(k);
    if (nk && text.includes(nk)) n += nk.includes(' ') ? 2 : 1;
  }
  return n;
}

export interface AnalyzeOptions {
  locale?: Locale;
  /** the project type the customer already chose in the UI: it breaks a tie and adds weight, it never overrides clear text */
  hint?: ProductType;
}

/**
 * Reads a customer's requirement text (DATA: never an instruction) into a structured analysis. Deterministic and bounded: the text is cut at `maxRequirementChars` (reported),
 * every match is a fixed keyword, and every string in the result comes from fixed tables, never from the text.
 */
export function analyzeRequirements(raw: string, opts: AnalyzeOptions = {}): RequirementAnalysis {
  const truncated = raw.length > PLAN_LIMITS.maxRequirementChars;
  const text = normalizeText(truncated ? raw.slice(0, PLAN_LIMITS.maxRequirementChars) : raw);
  const locale = opts.locale ?? detectLocale(raw);

  const scored = Object.values(PROFILES)
    .map((p) => ({ type: p.type, score: hits(text, p.en, p.ar) + (opts.hint === p.type ? 3 : 0) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (a.type < b.type ? -1 : 1));
  const ambiguities: RequirementAnalysis['ambiguities'] = [];
  const questions: RequirementAnalysis['questions'] = [];
  let productType: ProductType;
  if (scored.length === 0) {
    productType = opts.hint ?? 'webapp';
    ambiguities.push({
      id: 'product_type_unclear',
      text: {
        en: 'The text does not say what kind of product this is; a web application is assumed.',
        ar: 'لا يحدد النص نوع المنتج؛ افتُرض تطبيق ويب.',
      },
    });
  } else {
    productType = scored[0]!.type;
    if (scored[1] && scored[1].score === scored[0]!.score && opts.hint !== scored[0]!.type)
      ambiguities.push({
        id: 'product_type_tie',
        text: {
          en: `The text fits both "${scored[0]!.type}" and "${scored[1].type}" equally; "${scored[0]!.type}" is used.`,
          ar: `يناسب النص النوعين "${scored[0]!.type}" و"${scored[1].type}" بالتساوي؛ استُخدم "${scored[0]!.type}".`,
        },
      });
  }
  const profile = PROFILES[productType];

  const features = FEATURES.filter((f) => hits(text, f.en, f.ar) > 0)
    .map((f) => f.id)
    .slice(0, PLAN_LIMITS.maxFeatures);
  const implied = profile.impliedFeatures.filter((f) => !features.includes(f));

  const notes: Bilingual[] = [];
  const all = new Set([...features, ...implied]);
  if (all.has('invoices'))
    notes.push({
      en: 'Invoices are generated as documents only. Tax or e-invoicing (ZATCA) compliance is NOT claimed and needs the owner and a tax advisor.',
      ar: 'تُنشأ الفواتير كوثائق فقط. لا يُدَّعى الامتثال الضريبي أو للفوترة الإلكترونية (زاتكا) ويتطلب المالك ومستشاراً ضريبياً.',
    });
  if (all.has('payments') || all.has('subscriptions'))
    notes.push({
      en: 'Payments are wired in test mode only; the provider and credentials are chosen and supplied by the owner and no live charge is generated.',
      ar: 'يُربط الدفع بوضع تجريبي فقط؛ يختار المالك المزود ويوفر بيانات الاعتماد ولا تُولَّد عمليات حقيقية.',
    });
  if (all.has('maps') || all.has('chat'))
    notes.push({
      en: 'Third-party services (maps, messaging) are added as disabled integrations until the owner provides accounts.',
      ar: 'تُضاف الخدمات الخارجية (الخرائط والرسائل) كتكاملات معطلة حتى يوفر المالك الحسابات.',
    });

  const pick = profile.stacks.find(
    (s) =>
      hits(
        text,
        s.keywords.filter((k) => k !== 'typescript' && k !== 'static' && k !== 'plain'),
        [],
      ) > 0,
  );
  const requestedStack: string | null = pick?.id ?? null;
  const unsupported = UNSUPPORTED_STACKS.filter((u) => hits(text, u.keywords, []) > 0);
  for (const u of unsupported)
    notes.push({
      en: `${u.name} is not generated by Nuzm templates; the plan uses the supported default and says so.`,
      ar: `لا تُولِّد قوالب نظم ${u.name}؛ تستخدم الخطة الافتراضي المدعوم وتوضح ذلك.`,
    });

  for (const q of profile.questions)
    if (!q.unlessFeature || !all.has(q.unlessFeature)) questions.push({ id: q.id, text: q.text });

  const signal = (scored[0]?.score ?? 0) * 2 + features.length;
  return {
    locale,
    truncated,
    productType,
    candidates: scored,
    features,
    impliedFeatures: implied,
    requestedStack,
    ambiguities,
    questions,
    notes,
    confidence: text.trim().length === 0 ? 0 : Math.round(Math.min(1, signal / 10) * 100) / 100,
  };
}

/** Names of unsupported stacks the text asks for (used by the plan to raise a risk). */
export function unsupportedStacksIn(raw: string): string[] {
  const text = normalizeText(raw.slice(0, PLAN_LIMITS.maxRequirementChars));
  return UNSUPPORTED_STACKS.filter((u) => hits(text, u.keywords, []) > 0).map((u) => u.name);
}
