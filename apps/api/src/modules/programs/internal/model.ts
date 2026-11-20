import { ProblemException } from '../../../common/errors';
import { UUID, isUuid } from '@nuzm/domain';
export { UUID, isUuid };

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows
export const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;
export const hint = (e: unknown): string | undefined => (e as { hint?: string }).hint;
export const AGENCY_FLAG = 'agency.enabled';
export const RESELLER_FLAG = 'reseller.enabled';
export const badRequest = (detail: string, errors?: unknown[]) =>
  new ProblemException('validation_failed', detail, errors);
