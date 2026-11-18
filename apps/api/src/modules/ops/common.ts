import { ProblemException } from '../../common/errors';

export type Row = Record<string, unknown>;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Incident and ops records exclude raw personal data (M12 §9): refuse e-mail addresses and long digit runs (phone, card, national id). */
const PII = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /(?:\d[ -]?){9,}/];
export function assertNoPii(field: string, v: unknown): void {
  if (typeof v === 'string' && PII.some((r) => r.test(v)))
    throw new ProblemException(
      'validation_failed',
      'ops records must not contain personal data (use ids)',
      [{ field, message: 'looks like personal data (an e-mail address or a long number)' }],
    );
}
export const fail = (field: string, message: string): never => {
  throw new ProblemException('validation_failed', message, [{ field, message }]);
};
export const str = (
  body: Row,
  k: string,
  min: number,
  max: number,
  required = true,
): string | undefined => {
  const v = body[k];
  if (v === undefined || v === null) return required ? fail(k, `${k} is required`) : undefined;
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max)
    return fail(k, `${k} must be ${min}-${max} characters`);
  assertNoPii(k, v);
  return v.trim();
};
