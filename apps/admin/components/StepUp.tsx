'use client';
import { useStepUp as useUiStepUp } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { browserApi } from '../lib/client';

/** Verify the caller's enrolled TOTP factor (raises the session's MFA freshness). */
export async function verifyFactor(
  factorId: string,
  code: string,
): Promise<'ok' | 'bad_code' | 'locked'> {
  const r = await browserApi().POST('/v1/auth/mfa/factors/{id}/verification', {
    params: { path: { id: factorId } },
    body: { code },
  });
  if (r.response.ok) return 'ok';
  return r.response.status === 429 ? 'locked' : 'bad_code';
}

export function useStepUp(locale: Locale, factorId: string | null) {
  return useUiStepUp(
    {
      title: t(locale, 'mfa.challenge.title'),
      body: t(locale, 'mfa.challenge.body'),
      challenge: {
        code: t(locale, 'field.code'),
        verify: t(locale, 'action.verify'),
        errorCode: t(locale, 'mfa.error.code'),
        errorGeneric: t(locale, 'state.error.title'),
        locked: t(locale, 'mfa.error.locked'),
      },
    },
    factorId,
    verifyFactor,
  );
}
