/** Pure helpers of the customer privacy screens (UI-M04-01..06). No I/O: unit-tested in `privacy.spec.ts`. */

export const DSR_TYPES = ['access', 'correction', 'deletion', 'portability'] as const;
export type DsrType = (typeof DSR_TYPES)[number];
export const RESIDENCY_MODES = [
  'in_kingdom_only',
  'allow_listed',
  'unrestricted_with_assessment',
] as const;
export type ResidencyMode = (typeof RESIDENCY_MODES)[number];

type Tone = 'success' | 'danger' | 'warn' | undefined;
export const slaTone = (s: string): Tone =>
  s === 'overdue' || s === 'escalated' ? 'danger' : s === 'warning' ? 'warn' : undefined;
export const statusTone = (s: string): Tone =>
  s === 'fulfilled'
    ? 'success'
    : s === 'rejected'
      ? 'danger'
      : s === 'partially_fulfilled'
        ? 'warn'
        : undefined;
export const exportTone = (s: string): Tone =>
  s === 'succeeded' ? 'success' : s === 'failed' || s === 'expired' ? 'danger' : 'warn';

/** "personal=AE,BH; financial=SA" → { personal: ["AE","BH"], financial: ["SA"] }; null when anything is malformed (a country must be two capitals). */
export function parseCountries(text: string): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const part of text
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = /^([a-z][a-z-]{1,40})\s*=\s*(.+)$/.exec(part);
    if (!m) return null;
    const list = [
      ...new Set(
        m[2]!
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (list.length === 0 || list.length > 60 || list.some((c) => !/^[A-Z]{2}$/.test(c)))
      return null;
    out[m[1]!] = list;
  }
  return out;
}
export const formatCountries = (m: Record<string, string[]>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v.join(',')}`)
    .join('; ');

/**
 * The one-switch "AI features" choice of the residency screen. The AI model runs in the United States, so AI features need the organization to
 * allow customer content in US; everything else in the policy is kept.
 */
export const AI_CLASS = 'customer-content';
export const AI_COUNTRY = 'US';
export const aiAllowed = (mode: ResidencyMode, countries: Record<string, string[]>) =>
  mode === 'allow_listed' && (countries[AI_CLASS] ?? []).includes(AI_COUNTRY);

/** The policy body after switching AI features on or off: on lists US for customer content; off removes it (back to in-Kingdom when nothing is left). */
export function aiPolicy(
  mode: ResidencyMode,
  countries: Record<string, string[]>,
  on: boolean,
): { mode: ResidencyMode; allowedCountriesByClass: Record<string, string[]> } {
  const kept = mode === 'allow_listed' ? { ...countries } : {};
  const list = (kept[AI_CLASS] ?? []).filter((c) => c !== AI_COUNTRY);
  if (on) kept[AI_CLASS] = [...list, AI_COUNTRY];
  else if (list.length > 0) kept[AI_CLASS] = list;
  else delete kept[AI_CLASS];
  if (Object.keys(kept).length === 0)
    return { mode: 'in_kingdom_only', allowedCountriesByClass: {} };
  return { mode: 'allow_listed', allowedCountriesByClass: kept };
}

/** A subject reference as typed by an administrator: opaque ids only (never an email or a name). */
export const validSubject = (v: string) => /^[A-Za-z0-9:_.-]{1,128}$/.test(v.trim());

/** The body of a new request, or the first field that is wrong. */
export function requestBody(f: {
  type: DsrType;
  subject: string;
  attestation: string;
  text: string;
  displayName: string;
}): { body?: Record<string, unknown>; error?: 'subject' | 'attestation' | 'patch' | 'text' } {
  const subject = f.subject.trim();
  if (subject && !validSubject(subject)) return { error: 'subject' };
  if (subject && f.attestation.trim().length < 10) return { error: 'attestation' };
  if (f.type === 'correction' && f.displayName.trim() === '') return { error: 'patch' };
  if (f.text.length > 2000) return { error: 'text' };
  const details: Record<string, unknown> = {};
  if (f.text.trim()) details.text = f.text.trim();
  if (f.type === 'correction') details.patch = { displayName: f.displayName.trim() };
  return {
    body: {
      type: f.type,
      ...(subject ? { subjectRef: subject, identityAttestation: f.attestation.trim() } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    },
  };
}
