'use client';
import { MfaChallenge } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { MfaSetup } from './MfaSetup';
import { verifyFactor } from './StepUp';

/** Admin sign-in second step: challenge the enrolled factor, or enrol one when none exists yet. */
export function MfaGate({
  locale,
  factorId,
  next,
}: {
  locale: Locale;
  factorId: string | null;
  next: string;
}) {
  if (!factorId) return <MfaSetup locale={locale} next={next} />;
  return (
    <>
      <p>{t(locale, 'mfa.challenge.body')}</p>
      <MfaChallenge
        labels={{
          code: t(locale, 'field.code'),
          verify: t(locale, 'action.verify'),
          errorCode: t(locale, 'mfa.error.code'),
          errorGeneric: t(locale, 'state.error.title'),
          locked: t(locale, 'mfa.error.locked'),
        }}
        verify={(code) => verifyFactor(factorId, code)}
        onDone={() => window.location.assign(next)}
      />
    </>
  );
}
