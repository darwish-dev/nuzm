import { ProblemException } from '../../../common/errors';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;
export const hint = (e: unknown): string | undefined => (e as { hint?: string }).hint;
export const AGENCY_FLAG = 'agency.enabled';
export const RESELLER_FLAG = 'reseller.enabled';
export const badRequest = (detail: string, errors?: unknown[]) =>
  new ProblemException('validation_failed', detail, errors);
