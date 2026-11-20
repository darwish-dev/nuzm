/**
 * What the dashboard's status column shows, derived from the lists the page already reads (servers, domains, websites) and a few figures it has (unread
 * notifications, spending against the cap, whether the email address is confirmed). Pure functions of that data: nothing is invented, and a figure the member
 * may not see is `null` and its card is simply left out.
 */
export interface StatusRow {
  id: string;
  name: string;
  /** a short state word or date, already in the page language */
  detail: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  href: string;
}
export interface AttentionItem {
  id: string;
  tone: 'warn' | 'bad';
  /** the sentence, in the page language */
  text: string;
  href: string;
}

export const DOMAIN_SOON_DAYS = 30;
export const DOMAIN_PROBLEM_STATES = new Set([
  'expired',
  'redemption',
  'failed',
  'renewal_at_risk',
]);
export const SERVER_BAD = new Set(['failed']);
export const SITE_BAD = new Set(['failed', 'suspended']);

/** Domains that are active but expire within `DOMAIN_SOON_DAYS` days of `now` (a past date is already a problem state, counted there). */
export function expiringSoon(
  items: { state: string; expiresAt?: string | null }[],
  now: number,
): number {
  const horizon = now + DOMAIN_SOON_DAYS * 86_400_000;
  return items.filter((d) => {
    if (d.state !== 'active' || !d.expiresAt) return false;
    const at = Date.parse(d.expiresAt);
    return Number.isFinite(at) && at > now && at <= horizon;
  }).length;
}

export const problemCount = (items: { state: string }[], bad: Set<string>): number =>
  items.filter((i) => bad.has(i.state)).length;

/** Most serious first: failures, then things that will need action soon, then information. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  const rank = { bad: 0, warn: 1 } as const;
  return [...items].sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** A calendar day in the page language (UTC, so it is the same wherever the page is read). */
export function formatDay(iso: string, locale: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(iso));
}
