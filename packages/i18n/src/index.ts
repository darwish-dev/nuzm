import { messages } from './messages';

export type Locale = 'ar' | 'en';
export const locales: readonly Locale[] = ['ar', 'en'];
// D-32 (decided 2026-11-15): Arabic default, English supported.
export const defaultLocale: Locale = 'ar';

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export type MessageKey = keyof (typeof messages)['en'];

export type MessageParams = Record<string, string | number>;

/** Look up a message and fill `{param}` placeholders (no string concatenation in components). */
export function t(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

/** Same lookup for dynamic keys (e.g. `role.${role}`); falls back to the raw value when untranslated. */
export function tDynamic(
  locale: Locale,
  key: string,
  fallback: string,
  params: MessageParams = {},
): string {
  return key in messages.en ? t(locale, key as MessageKey, params) : fallback;
}

/** `{param}` names used by a message; both locales must use the same set. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

/** Mismatched placeholders between locales (guards translation drift). */
export function placeholderMismatches(): string[] {
  return (Object.keys(messages.en) as MessageKey[]).filter(
    (k) => placeholders(messages.en[k]).join() !== placeholders(messages.ar[k]).join(),
  );
}

const TZ = 'Asia/Riyadh'; // docs/13 §5 default; user override arrives with profile settings
/** Display a UTC ISO timestamp in the user's locale (Gregorian; Hijri is an optional later flag, D-32). */
export function formatDateTime(iso: string, locale: Locale, timeZone = TZ): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

/** Message keys must exist in every locale (guards translation drift). */
export function missingKeys(): string[] {
  const en = Object.keys(messages.en);
  const ar = Object.keys(messages.ar);
  return [...en.filter((k) => !ar.includes(k)), ...ar.filter((k) => !en.includes(k))];
}

const MINOR_DIGITS: Record<string, number> = { SAR: 2, USD: 2, EUR: 2 };

/**
 * Format an integer minor-unit amount string (docs/04 money rule) for display.
 * Throws if the amount is not a safe integer string; no floating-point money math is stored.
 */
export function formatMinor(amountMinor: string, currency: string, locale: Locale): string {
  if (!/^-?\d+$/.test(amountMinor)) throw new Error('amountMinor must be an integer string');
  const digits = MINOR_DIGITS[currency];
  if (digits === undefined) throw new Error(`unsupported currency ${currency}`);
  const n = Number(amountMinor);
  if (!Number.isSafeInteger(n)) throw new Error('amount exceeds display range');
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  }).format(n / 10 ** digits);
}
