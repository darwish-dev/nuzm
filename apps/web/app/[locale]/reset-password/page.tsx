import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthShell } from '../../../components/AuthShell';
import { ResetForm } from '../../../components/AuthForms';

export default async function ResetPassword({
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
    <AuthShell locale={locale} variant="help" title={t(locale, 'reset.title')}>
      {token ? (
        <ResetForm locale={locale} token={token} />
      ) : (
        <>
          <p className="nz-error-text">{t(locale, 'reset.invalid')}</p>
          <a href={`/forgot-password`}>{t(locale, 'forgot.title')}</a>
        </>
      )}
    </AuthShell>
  );
}
