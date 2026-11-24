import type { Locale } from '@nuzm/i18n';

/**
 * Pure helpers and the text of the provider insights screens (health, capability registry, usage, rate-card history, model discovery).
 *
 * The text lives HERE, not in the shared `@nuzm/i18n` message table, because that table is outside this workstream's files (a proposal to move these keys into it is in
 * `docs/parallel/sessions/CONTRACT-5-provider-insights-i18n.md`). Every key has an Arabic and an English text; a test asserts that none is missing or empty.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; status: number };

export interface HealthItem {
  key: string;
  status: 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
  samples: number;
  successPerMille: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  breaker: 'closed' | 'open' | 'half_open';
}
export interface RegistryItem {
  providerCode: string;
  modelId: string;
  providerEnabled: boolean;
  priced: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  effective: string[];
  pending: string[];
  capabilities: { capability: string; declared: boolean; effective: boolean; basis: string }[];
}
export interface UsageRow {
  providerCode: string;
  modelRef: string | null;
  day: string | null;
  calls: number;
  okCalls: number;
  errorCalls: number;
  estimatedCalls: number;
  tokensIn: string;
  tokensOut: string;
  credits: string;
  costMinor: string | null;
  costCurrency: string | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}
export interface UsageReport {
  from: string;
  to: string;
  groupBy: 'provider' | 'model' | 'day';
  truncated: boolean;
  rows: UsageRow[];
}
export interface RateVersion {
  id: string;
  version: string;
  recordedBy: string;
  recordedAt: string;
  models: Record<string, { creditsPerMillionInput: string; creditsPerMillionOutput: string }>;
  changes: { modelId: string; change: 'added' | 'removed' | 'changed' }[];
}
export interface Discovery {
  providerCode: string;
  live: true;
  checkedAt: string;
  confirmed: string[];
  unlistedByVendor: string[];
  notDeclared: { modelId: string; displayName?: string }[];
}
export interface ProviderOption {
  id: string;
  code: string;
  displayName: string;
}

/** `{ ok, status, data }` of an SDK call, reduced to what a section needs. */
export function toResult<T>(r: { response: { ok: boolean; status: number }; data?: T }): Result<T> {
  return r.response.ok && r.data !== undefined
    ? { ok: true, data: r.data }
    : { ok: false, status: r.response.status };
}

/** Whole-number per mille → "97.5%" without floating point (one decimal, rounded down). */
export function percentText(perMille: number | null): string {
  if (perMille === null || !Number.isInteger(perMille) || perMille < 0 || perMille > 1000)
    return '—';
  return `${Math.floor(perMille / 10)}.${perMille % 10}%`;
}
export const msText = (ms: number | null): string => (ms === null ? '—' : `${ms} ms`);

export const healthTone = (s: HealthItem['status']): 'success' | 'warn' | 'danger' | undefined =>
  s === 'healthy'
    ? 'success'
    : s === 'degraded'
      ? 'warn'
      : s === 'unhealthy'
        ? 'danger'
        : undefined;
export const breakerTone = (b: HealthItem['breaker']): 'success' | 'warn' | 'danger' =>
  b === 'closed' ? 'success' : b === 'half_open' ? 'warn' : 'danger';

/** The range a report is asked for: whole days ending now (UTC). */
export function usageRange(days: 7 | 30 | 90, now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() };
}
export const USAGE_RANGES = [7, 30, 90] as const;
export const USAGE_GROUPS = ['provider', 'model', 'day'] as const;

const EXPONENT: Record<string, number> = { USD: 2, SAR: 2, EUR: 2, GBP: 2, AED: 2, KWD: 3, JPY: 0 };
/** Minor units as an exact decimal string with the currency code (no floats). Unknown currencies show the raw minor units. */
export function moneyText(minor: string | null, currency: string | null): string {
  if (minor === null) return '—';
  if (!/^-?\d+$/.test(minor)) return '—';
  const cur = currency?.trim() ?? '';
  if (cur === '' || cur === 'MIXED') return minor;
  const exp = EXPONENT[cur];
  if (exp === undefined) return `${minor} ${cur} (minor units)`;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp);
  const frac = exp === 0 ? '' : `.${digits.slice(digits.length - exp)}`;
  return `${neg ? '-' : ''}${whole}${frac} ${cur}`;
}
export const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);
export const dateText = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC';
export const epochText = (ms: number | null): string =>
  ms === null ? '—' : new Date(ms).toISOString().slice(11, 19) + ' UTC';

// ───────────────────────────── text ─────────────────────────────
type Dict = Record<string, string>;
const en: Dict = {
  'ins.title': 'Provider health, capabilities and usage',
  'ins.help':
    'Read-only views. Health shows this API process only and starts again after a restart. Nothing here enables a provider or verifies a capability.',
  'ins.loading': 'Loading…',
  'ins.err.title': 'This section could not be loaded',
  'ins.err.body': 'Try again in a moment. The other sections are not affected.',
  'ins.forbidden.title': 'You cannot view this section',
  'ins.forbidden.body': 'It needs the permission to read the AI configuration.',
  'ins.health.title': 'Provider health',
  'ins.health.scope':
    'Numbers of the serving API process only; they do not combine several instances.',
  'ins.health.empty': 'No calls have been made by this process yet',
  'ins.health.emptyBody': 'Health appears after the first model call.',
  'ins.health.key': 'Provider or model',
  'ins.health.status': 'Status',
  'ins.health.samples': 'Samples',
  'ins.health.success': 'Successful',
  'ins.health.latency': 'Latency p50 / p95',
  'ins.health.lastError': 'Last error',
  'ins.health.circuit': 'Circuit',
  'ins.status.unknown': 'Unknown',
  'ins.status.healthy': 'Healthy',
  'ins.status.degraded': 'Degraded',
  'ins.status.unhealthy': 'Unhealthy',
  'ins.breaker.closed': 'Closed',
  'ins.breaker.open': 'Open: calls paused',
  'ins.breaker.half_open': 'Testing one call',
  'ins.reg.title': 'Capability registry',
  'ins.reg.help':
    'What the router may rely on for each model. A capability that is declared but not yet backed by recorded evidence is listed as pending and is never offered.',
  'ins.reg.empty': 'No provider with a registered adapter is configured',
  'ins.reg.emptyBody': 'Configure a provider first.',
  'ins.reg.provider': 'Provider',
  'ins.reg.model': 'Model',
  'ins.reg.limits': 'Context / max output (tokens)',
  'ins.reg.priced': 'Rate card entry',
  'ins.reg.caps': 'Capabilities',
  'ins.reg.effective': 'in use',
  'ins.reg.pending': 'pending',
  'ins.reg.disabled': 'Provider disabled',
  'ins.reg.noPrice': 'No rate card entry: never offered',
  'ins.reg.yes': 'Yes',
  'ins.reg.no': 'No',
  'ins.basis.adapter_declared': 'declared by the adapter',
  'ins.basis.dev_reference': 'development reference',
  'ins.basis.evidence_verified': 'verified by recorded evidence',
  'ins.basis.not_declared': 'not declared',
  'ins.basis.contract_too_old': 'the adapter contract is too old',
  'ins.basis.needs_tool_use': 'needs tool use first',
  'ins.basis.no_evidence': 'no verified evidence yet',
  'ins.basis.evidence_other_contract': 'the evidence is for another contract',
  'ins.use.title': 'Usage report',
  'ins.use.help':
    'Our cost at the provider price from the usage records, not what customers paid. Token and money totals are exact integers.',
  'ins.use.range': 'Period',
  'ins.use.days': 'Last {n} days',
  'ins.use.group': 'Group by',
  'ins.use.group.provider': 'Provider',
  'ins.use.group.model': 'Model',
  'ins.use.group.day': 'Day',
  'ins.use.show': 'Show usage',
  'ins.use.empty': 'No usage in this period',
  'ins.use.emptyBody': 'Try a longer period.',
  'ins.use.truncated':
    'The report was cut at its row limit. Choose a shorter period or a coarser grouping.',
  'ins.use.col.provider': 'Provider',
  'ins.use.col.model': 'Model',
  'ins.use.col.day': 'Day',
  'ins.use.col.calls': 'Calls (ok / error)',
  'ins.use.col.estimated': 'Estimated',
  'ins.use.col.tokens': 'Tokens in / out',
  'ins.use.col.credits': 'Credits',
  'ins.use.col.cost': 'Our cost',
  'ins.use.col.latency': 'Latency p50 / p95',
  'ins.use.mixed': 'Mixed currencies: not added up',
  'ins.rc.title': 'Rate card history',
  'ins.rc.help':
    'Every saved version of a provider rate card, oldest changes last. The history is append-only.',
  'ins.rc.provider': 'Provider',
  'ins.rc.choose': 'Choose a provider',
  'ins.rc.show': 'Show history',
  'ins.rc.empty': 'No versions recorded for this provider',
  'ins.rc.version': 'Version',
  'ins.rc.recorded': 'Recorded',
  'ins.rc.by': 'By',
  'ins.rc.models': 'Models',
  'ins.rc.changes': 'Changes',
  'ins.rc.added': 'added',
  'ins.rc.removed': 'removed',
  'ins.rc.changed': 'changed',
  'ins.rc.none': 'first version',
  'ins.disc.title': 'Model discovery',
  'ins.disc.help':
    'Asks the provider which models its key can see. A live, read-only request: no prompt is sent and nothing is billed. It is not capability verification, and a model the adapter does not declare is never offered.',
  'ins.disc.run': 'Ask the provider for its models',
  'ins.disc.refused':
    'This provider cannot be asked for its models: it has no model listing, or live calls to it are not approved in this environment yet.',
  'ins.disc.failed':
    'The provider did not list its models. Check the key and that live calls are approved.',
  'ins.disc.done': 'Checked {when}',
  'ins.disc.confirmed': 'Confirmed by the provider',
  'ins.disc.unlisted': 'Declared by the adapter but not listed by the provider',
  'ins.disc.notDeclared': 'Listed by the provider but not declared (never offered)',
  'ins.disc.none': 'none',
  'ins.disc.live': 'Live request',
};
const ar: Dict = {
  'ins.title': 'صحة المزوّدين وقدراتهم واستهلاكهم',
  'ins.help':
    'عروض للقراءة فقط. تعرض الصحة عملية الواجهة الحالية فقط وتبدأ من جديد بعد إعادة التشغيل. لا شيء هنا يفعّل مزوّداً أو يتحقق من قدرة.',
  'ins.loading': 'جارٍ التحميل…',
  'ins.err.title': 'تعذّر تحميل هذا القسم',
  'ins.err.body': 'حاول مجدداً بعد قليل. الأقسام الأخرى غير متأثرة.',
  'ins.forbidden.title': 'لا يمكنك عرض هذا القسم',
  'ins.forbidden.body': 'يتطلب صلاحية قراءة إعدادات الذكاء الاصطناعي.',
  'ins.health.title': 'صحة المزوّدين',
  'ins.health.scope': 'أرقام عملية الواجهة الحالية فقط؛ ولا تجمع عدة نسخ.',
  'ins.health.empty': 'لم تُجرِ هذه العملية أي مكالمة بعد',
  'ins.health.emptyBody': 'تظهر الصحة بعد أول مكالمة إلى نموذج.',
  'ins.health.key': 'المزوّد أو النموذج',
  'ins.health.status': 'الحالة',
  'ins.health.samples': 'العينات',
  'ins.health.success': 'نسبة النجاح',
  'ins.health.latency': 'زمن الاستجابة p50 / p95',
  'ins.health.lastError': 'آخر خطأ',
  'ins.health.circuit': 'الدائرة',
  'ins.status.unknown': 'غير معروفة',
  'ins.status.healthy': 'سليم',
  'ins.status.degraded': 'متراجع',
  'ins.status.unhealthy': 'غير سليم',
  'ins.breaker.closed': 'مغلقة',
  'ins.breaker.open': 'مفتوحة: المكالمات متوقفة',
  'ins.breaker.half_open': 'اختبار مكالمة واحدة',
  'ins.reg.title': 'سجل القدرات',
  'ins.reg.help':
    'ما يمكن للموجِّه الاعتماد عليه لكل نموذج. القدرة المعلنة التي لا يدعمها دليل مسجّل بعد تظهر كمعلّقة ولا تُعرض أبداً.',
  'ins.reg.empty': 'لا يوجد مزوّد مُعدّ له محوّل مسجّل',
  'ins.reg.emptyBody': 'أعدّ مزوّداً أولاً.',
  'ins.reg.provider': 'المزوّد',
  'ins.reg.model': 'النموذج',
  'ins.reg.limits': 'السياق / أقصى مخرجات (رموز)',
  'ins.reg.priced': 'بند في بطاقة الأسعار',
  'ins.reg.caps': 'القدرات',
  'ins.reg.effective': 'مستخدمة',
  'ins.reg.pending': 'معلّقة',
  'ins.reg.disabled': 'المزوّد معطّل',
  'ins.reg.noPrice': 'لا بند في بطاقة الأسعار: لا يُعرض أبداً',
  'ins.reg.yes': 'نعم',
  'ins.reg.no': 'لا',
  'ins.basis.adapter_declared': 'معلنة من المحوّل',
  'ins.basis.dev_reference': 'مرجع تطويري',
  'ins.basis.evidence_verified': 'موثّقة بدليل مسجّل',
  'ins.basis.not_declared': 'غير معلنة',
  'ins.basis.contract_too_old': 'عقد المحوّل قديم',
  'ins.basis.needs_tool_use': 'تتطلب استخدام الأدوات أولاً',
  'ins.basis.no_evidence': 'لا دليل موثّق بعد',
  'ins.basis.evidence_other_contract': 'الدليل لعقد آخر',
  'ins.use.title': 'تقرير الاستهلاك',
  'ins.use.help':
    'تكلفتنا بسعر المزوّد من سجلات الاستهلاك، وليس ما دفعه العملاء. مجاميع الرموز والمبالغ أعداد صحيحة دقيقة.',
  'ins.use.range': 'الفترة',
  'ins.use.days': 'آخر {n} يوماً',
  'ins.use.group': 'التجميع حسب',
  'ins.use.group.provider': 'المزوّد',
  'ins.use.group.model': 'النموذج',
  'ins.use.group.day': 'اليوم',
  'ins.use.show': 'عرض الاستهلاك',
  'ins.use.empty': 'لا استهلاك في هذه الفترة',
  'ins.use.emptyBody': 'جرّب فترة أطول.',
  'ins.use.truncated': 'اقتُطع التقرير عند حدّ الصفوف. اختر فترة أقصر أو تجميعاً أوسع.',
  'ins.use.col.provider': 'المزوّد',
  'ins.use.col.model': 'النموذج',
  'ins.use.col.day': 'اليوم',
  'ins.use.col.calls': 'المكالمات (ناجحة / خطأ)',
  'ins.use.col.estimated': 'مقدَّرة',
  'ins.use.col.tokens': 'الرموز داخل / خارج',
  'ins.use.col.credits': 'الأرصدة',
  'ins.use.col.cost': 'تكلفتنا',
  'ins.use.col.latency': 'زمن الاستجابة p50 / p95',
  'ins.use.mixed': 'عملات مختلطة: لا تُجمع',
  'ins.rc.title': 'سجل بطاقة الأسعار',
  'ins.rc.help': 'كل نسخة محفوظة من بطاقة أسعار المزوّد، والأحدث أولاً. السجل للإضافة فقط.',
  'ins.rc.provider': 'المزوّد',
  'ins.rc.choose': 'اختر مزوّداً',
  'ins.rc.show': 'عرض السجل',
  'ins.rc.empty': 'لا نسخ مسجّلة لهذا المزوّد',
  'ins.rc.version': 'النسخة',
  'ins.rc.recorded': 'وقت التسجيل',
  'ins.rc.by': 'بواسطة',
  'ins.rc.models': 'النماذج',
  'ins.rc.changes': 'التغييرات',
  'ins.rc.added': 'أُضيف',
  'ins.rc.removed': 'أُزيل',
  'ins.rc.changed': 'تغيّر',
  'ins.rc.none': 'النسخة الأولى',
  'ins.disc.title': 'اكتشاف النماذج',
  'ins.disc.help':
    'يسأل المزوّد عن النماذج التي يراها مفتاحه. طلب حيّ للقراءة فقط: لا يُرسل أي مطالبة ولا يُحاسَب عليه. ليس تحققاً من القدرات، والنموذج الذي لا يعلنه المحوّل لا يُعرض أبداً.',
  'ins.disc.run': 'اسأل المزوّد عن نماذجه',
  'ins.disc.refused':
    'لا يمكن سؤال هذا المزوّد عن نماذجه: ليس له قائمة نماذج، أو أن المكالمات الحيّة إليه غير معتمدة في هذه البيئة بعد.',
  'ins.disc.failed': 'لم يُعد المزوّد قائمة نماذجه. تحقق من المفتاح ومن اعتماد المكالمات الحيّة.',
  'ins.disc.done': 'جرى الفحص {when}',
  'ins.disc.confirmed': 'مؤكَّدة من المزوّد',
  'ins.disc.unlisted': 'معلنة من المحوّل لكن غير مدرجة لدى المزوّد',
  'ins.disc.notDeclared': 'مدرجة لدى المزوّد لكن غير معلنة (لا تُعرض أبداً)',
  'ins.disc.none': 'لا شيء',
  'ins.disc.live': 'طلب حيّ',
};
export const INSIGHT_TEXT = { en, ar } as const;
export type InsightKey = keyof typeof en;

/** The text of a key in a locale; `{name}` placeholders are replaced from `params`. A missing key shows the key (a test makes sure none is missing). */
export function ti(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const table: Dict = locale === 'ar' ? ar : en;
  const raw = table[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ''));
}
