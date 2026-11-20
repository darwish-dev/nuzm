import { createHash } from 'node:crypto';
import { ProblemException } from '../../../common/errors';
import { UUID } from '@nuzm/domain';
export { UUID };

export type Row = Record<string, unknown>;
export const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

export function reqUuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID.test(v))
    throw new ProblemException('validation_failed', `${name} must be a UUID`);
  return v.toLowerCase();
}
export function reqText(v: unknown, name: string, min = 1, max = 1000): string {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max)
    throw new ProblemException(
      'validation_failed',
      `${name} is required (${min}..${max} characters)`,
    );
  return v.trim();
}
export function optText(v: unknown, name: string, max = 1000): string | undefined {
  if (v === undefined || v === null) return undefined;
  return reqText(v, name, 1, max);
}
export function oneOf<T extends string>(v: unknown, name: string, list: readonly T[]): T {
  if (typeof v !== 'string' || !list.includes(v as T))
    throw new ProblemException('validation_failed', `${name} must be one of ${list.join(', ')}`);
  return v as T;
}
export function body(b: unknown): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b))
    throw new ProblemException('validation_failed', 'a JSON object body is required');
  return b as Record<string, unknown>;
}
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;

/** Canonical JSON (sorted keys) so equal catalogs hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Keys that look like they carry a credential VALUE: never accepted by any provider endpoint (only `credentialRef: vault://…`). */
export const CREDENTIAL_KEY =
  /(secret|password|passwd|token|api[-_]?key|access[-_]?key|private[-_]?key|credential(?!Ref)|authorization)/i;
export function rejectCredentialValues(b: Record<string, unknown>): void {
  for (const k of Object.keys(b))
    if (CREDENTIAL_KEY.test(k))
      throw new ProblemException(
        'credential_value_rejected',
        `field "${k}" looks like a credential value; send a vault reference in credentialRef instead`,
      );
}
