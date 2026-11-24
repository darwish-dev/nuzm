import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted, no whitespace. The same value always serializes to the same string, so a hash of it is a fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');
export const fingerprint = (value: unknown): string => sha256Hex(canonicalJson(value));
