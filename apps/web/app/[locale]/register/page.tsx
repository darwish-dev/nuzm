import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthLogo } from '../../../components/BrandLogo';
import { Card, LocaleSwitch, PageTitle } from '@nuzm/ui';
import { RegisterForm } from '../../../components/AuthForms';
import { OnboardingSteps } from '../../../components/OnboardingSteps';

export default async function Register({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <AuthLogo href={`/${locale}`} />
      <OnboardingSteps locale={locale} current={1} />
      <PageTitle>{t(locale, 'register.title')}</PageTitle>
      <Card>
        <p>{t(locale, 'onb.account.sub')}</p>
        <RegisterForm locale={locale} />
        <p>
          {t(locale, 'register.haveAccount')}{' '}
          <a href={`/${locale}/login`}>{t(locale, 'action.signin')}</a>
        </p>
      </Card>
      <p>
        <LocaleSwitch
          current={locale}
          locales={['ar', 'en']}
          labels={{ ar: 'العربية', en: 'English' }}
        />
      </p>
    </main>
  );
}
