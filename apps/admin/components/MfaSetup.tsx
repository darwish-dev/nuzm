'use client';
import { MfaEnrol } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { browserApi } from '../lib/client';

export function MfaSetup({ locale, next }: { locale: Locale; next: string }) {
  const api = browserApi();
  return (
    <MfaEnrol
      labels={{
        intro: t(locale, 'mfa.intro'),
        start: t(locale, 'mfa.start'),
        qr: t(locale, 'mfa.qr'),
        manualKey: t(locale, 'mfa.manualKey'),
        code: t(locale, 'field.code'),
        verify: t(locale, 'action.verify'),
        done: t(locale, 'mfa.done'),
        errorCode: t(locale, 'mfa.error.code'),
        errorGeneric: t(locale, 'state.error.title'),
      }}
      lockedMessage={t(locale, 'mfa.error.locked')}
      start={async () => {
        const r = await api.POST('/v1/auth/mfa/factors', { body: { type: 'totp' } });
        if (!r.response.ok) throw new Error('enrol failed');
        return r.data as unknown as { id: string; secret: string; otpauthUri: string };
      }}
      verify={async (id, code) => {
        const r = await api.POST('/v1/auth/mfa/factors/{id}/verification', {
          params: { path: { id } },
          body: { code },
        });
        if (r.response.ok) return 'ok';
        return r.response.status === 429 ? 'locked' : 'bad_code';
      }}
      onDone={() => window.location.assign(next)}
    />
  );
}
