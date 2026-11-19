import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthShell } from '../../../components/AuthShell';
import { VerifyEmail } from '../../../components/AuthForms';

export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  const { token } = await searchParams;
  if (!isLocale(locale)) notFound();
  return (
    <AuthShell locale={locale} variant="help" title={t(locale, 'verify.title')}>
      {token ? (
        <VerifyEmail locale={locale} token={token} />
      ) : (
        <p className="nz-error-text">{t(locale, 'verify.invalid')}</p>
      )}
    </AuthShell>
  );
}
