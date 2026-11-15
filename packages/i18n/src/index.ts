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

const messages = {
  ar: {
    'app.web.title': 'نظم — لوحة العميل',
    'app.admin.title': 'نظم — لوحة الإدارة',
    'app.shell.placeholder': 'هيكل أولي فقط. لا توجد ميزات بعد.',
    'app.locale.switch': 'English',
  },
  en: {
    'app.web.title': 'Nuzm — Customer Console',
    'app.admin.title': 'Nuzm — Admin Console',
    'app.shell.placeholder': 'Shell only. No features yet.',
    'app.locale.switch': 'العربية',
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof messages)['en'];

export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key];
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
