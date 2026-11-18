import type { MessageKey } from '@nuzm/i18n';

/** Same limits as the API (ADR-008); the API stays the authority, this only gives instant feedback. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordIssue = 'too_short' | 'too_long' | 'same_as_email';

export function clientPasswordIssue(pw: string, email?: string): PasswordIssue | null {
  const n = [...pw].length;
  if (n < PASSWORD_MIN) return 'too_short';
  if (n > PASSWORD_MAX) return 'too_long';
  if (email && pw.toLowerCase() === email.trim().toLowerCase()) return 'same_as_email';
  return null;
}

export const passwordIssueKey = (i: PasswordIssue): MessageKey => `password.err.${i}`;

/** Only same-site relative paths are followed after sign-in (the API validates returnTo again for the OIDC flow). */
export function safeNext(raw: string | null | undefined, fallback: string): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')
    ? raw
    : fallback;
}

interface ProblemBody {
  code?: string;
  errors?: { field?: string; message?: string }[];
}
export const problemCode = (e: unknown): string | undefined => (e as ProblemBody | undefined)?.code;
export const problemField = (e: unknown, field: string): boolean =>
  Boolean((e as ProblemBody | undefined)?.errors?.some((x) => x.field === field));
