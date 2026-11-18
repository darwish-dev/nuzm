/** Pure helpers of the customer domain screens (UI-M07-01..08). No I/O: unit-tested in `domains.spec.ts`. */
type Tone = 'success' | 'danger' | 'warn' | undefined;

export const domainTone = (s: string): Tone =>
  s === 'active'
    ? 'success'
    : s === 'failed' || s === 'expired' || s === 'renewal_at_risk'
      ? 'danger'
      : s === 'pending' || s === 'transferring' || s === 'redemption'
        ? 'warn'
        : undefined;

/** The i18n key of the reason a TLD is not sold: only the rules the UI knows get their own sentence. */
type ReasonKey =
  | 'dom.search.reason.policy.saudi_absent'
  | 'dom.search.reason.policy.not_in_portfolio'
  | 'dom.search.reason.registrar.not_listed'
  | 'dom.search.reason.other';
export const reasonKey = (rule: string): ReasonKey =>
  rule === 'policy.saudi_absent'
    ? 'dom.search.reason.policy.saudi_absent'
    : rule === 'policy.not_in_portfolio'
      ? 'dom.search.reason.policy.not_in_portfolio'
      : rule === 'registrar.not_listed'
        ? 'dom.search.reason.registrar.not_listed'
        : 'dom.search.reason.other';

export const daysLeft = (iso: string | null | undefined, now = Date.now()): number | null =>
  iso ? Math.ceil((Date.parse(iso) - now) / 86_400_000) : null;
export const expiringSoon = (
  iso: string | null | undefined,
  now = Date.now(),
  within = 60,
): boolean => {
  const d = daysLeft(iso, now);
  return d !== null && d <= within;
};

/** SAR amount from integer minor units as text (no float arithmetic). */
export const money = (minor: string, currency: string): string => {
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '').padStart(3, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
};

/** mm:ss until a quote expires; 'expired' as soon as the time is up. */
export const countdown = (expiresAt: string, now = Date.now()): string | null => {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export interface ContactForm {
  firstName: string;
  lastName: string;
  organization: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}
export const emptyContact = (): ContactForm => ({
  firstName: '',
  lastName: '',
  organization: '',
  email: '',
  phone: '',
  street: '',
  city: '',
  postalCode: '',
  country: 'SA',
});
export const contactBody = (c: ContactForm) => ({
  firstName: c.firstName.trim(),
  lastName: c.lastName.trim(),
  ...(c.organization.trim() ? { organization: c.organization.trim() } : {}),
  email: c.email.trim(),
  phone: c.phone.trim(),
  address: {
    street: c.street.trim(),
    city: c.city.trim(),
    postalCode: c.postalCode.trim(),
    country: c.country.trim().toUpperCase(),
  },
});

/** Parses the value field of the record editor: plain text for simple types, JSON for MX/SRV/CAA. Null = not valid JSON where JSON is needed. */
export function parseRecordValue(type: string, text: string): unknown | null {
  const v = text.trim();
  if (['MX', 'SRV', 'CAA'].includes(type)) {
    try {
      const j = JSON.parse(v) as unknown;
      return j && typeof j === 'object' ? j : null;
    } catch {
      return null;
    }
  }
  return v === '' ? null : v;
}
export const showValue = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The extensions offered as cards on the search page: the TLDs `spec/providers/tld-policy.yaml` lists as enabled (a spec test keeps the
 * two in sync). A card only starts a search; whether a name is sold and its price always come from the search answer, never from here.
 */
export const SOLD_TLDS = ['com', 'net', 'org'] as const;

/** `?tlds=com&tlds=net` or `?tlds=com,net` → `com,net` (what the search API takes); unknown or empty → undefined. */
export const tldsParam = (v: string | string[] | undefined): string | undefined => {
  const list = (Array.isArray(v) ? v : v ? [v] : [])
    .flatMap((x) => x.split(','))
    .map((x) => x.trim().replace(/^\./, '').toLowerCase())
    .filter((x) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(x));
  return list.length ? [...new Set(list)].join(',') : undefined;
};
