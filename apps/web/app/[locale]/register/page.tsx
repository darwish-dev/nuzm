import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthShell } from '../../../components/AuthShell';
import { RegisterForm } from '../../../components/AuthForms';

export default async function Register({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <AuthShell
      locale={locale}
      variant="register"
      step={1}
      title={t(locale, 'register.title')}
      sub={t(locale, 'onb.account.sub')}
    >
      <RegisterForm locale={locale} />
      <p className="nzc-split-links">
        {t(locale, 'register.haveAccount')} <a href={`/login`}>{t(locale, 'action.signin')}</a>
      </p>
    </AuthShell>
  );
}
