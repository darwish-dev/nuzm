'use client';
import { useRouter } from 'next/navigation';
import { MfaEnrol } from '@nuzm/ui';
import { t, type Locale } from '@nuzm/i18n';
import { browserApi } from '../lib/client';

export function MfaSetup({ locale }: { locale: Locale }) {
  const api = browserApi();
  const router = useRouter();
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
      // the account page's status badge and recovery-codes section read the factor from the server
      onDone={() => router.refresh()}
      lockedMessage={t(locale, 'mfa.error.locked')}
      start={async () => {
        const r = await api.POST('/v1/auth/mfa/factors', { body: { type: 'totp' } });
        if (!r.response.ok) throw new Error('enrol failed');
        const b = r.data as unknown as { id: string; secret: string; otpauthUri: string };
        return b;
      }}
      verify={async (id, code) => {
        const r = await api.POST('/v1/auth/mfa/factors/{id}/verification', {
          params: { path: { id } },
          body: { code },
        });
        if (r.response.ok) return 'ok';
        return r.response.status === 429 ? 'locked' : 'bad_code';
      }}
    />
  );
}
