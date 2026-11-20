import { domainToASCII } from 'node:url';
import { ProblemException } from '../../../common/errors';
import { UUID } from '@nuzm/domain';
export { UUID };

export type Row = Record<string, unknown>;
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;

export const DOMAINS_FLAG = 'domains.enabled';

/** Normalizes a user-typed domain label/name to lower-case punycode; null when it cannot be a registrable name. */
export function normalizeDomainName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '' || s.length > 253 || /[\s/\\?#@:%]/.test(s)) return null;
  const a = domainToASCII(s);
  if (a === '' || a.length > 253) return null;
  const labels = a.split('.');
  for (const l of labels) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  return a;
}

/** Splits `example.co.uk` into the registrable label and the TLD, choosing the LONGEST known TLD suffix. Unknown TLD => null. */
export function splitDomain(
  name: string,
  knownTlds: Iterable<string>,
): { label: string; tld: string } | null {
  let best: string | null = null;
  for (const t of knownTlds)
    if (name.endsWith(`.${t}`) && (best === null || t.length > best.length)) best = t;
  if (!best) return null;
  const label = name.slice(0, -(best.length + 1));
  return label !== '' && !label.includes('.') ? { label, tld: best } : null;
}

export function badRequest(detail: string, errors?: unknown[]): ProblemException {
  return new ProblemException('validation_failed', detail, errors);
}

/** Money helpers: integer minor units as strings/bigint only. */
export const bi = (v: unknown): bigint => BigInt(String(v));
