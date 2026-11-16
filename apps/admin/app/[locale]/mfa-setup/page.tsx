import { notFound, redirect } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MfaGate } from '../../../components/MfaGate';
import { serverApi } from '../../../lib/server';

/**
 * Outside the console layout on purpose: an admin session without MFA may only reach enrol/verify.
 * If the staff member already has a factor they are CHALLENGED; otherwise they enrol one.
 */
export default async function MfaPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  let factorId: string | null = null;
  try {
    await unwrap((await serverApi()).GET('/v1/me', {}));
    redirect(`/${locale}/organizations`); // already MFA-verified
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect(`/${locale}/login`);
    if (e instanceof ApiError && e.code === 'mfa_required') factorId = e.mfaFactorId ?? null;
    else throw e;
  }
  return (
    <main className="nz-main" style={{ maxInlineSize: 560, marginInline: 'auto' }}>
      <PageTitle>{t(locale, factorId ? 'mfa.challenge.title' : 'mfa.title')}</PageTitle>
      <p role="note">{t(locale, 'mfa.admin.required')}</p>
      <MfaGate locale={locale} factorId={factorId} next={`/${locale}/organizations`} />
    </main>
  );
}
