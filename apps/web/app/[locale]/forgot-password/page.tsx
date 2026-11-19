import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthShell } from '../../../components/AuthShell';
import { ForgotForm } from '../../../components/AuthForms';

export default async function ForgotPassword({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <AuthShell
      locale={locale}
      variant="help"
      title={t(locale, 'forgot.title')}
      sub={t(locale, 'forgot.body')}
    >
      <ForgotForm locale={locale} />
      <p className="nzc-split-links">
        <a href={`/${locale}/login`}>{t(locale, 'action.signin')}</a>
      </p>
    </AuthShell>
  );
}
