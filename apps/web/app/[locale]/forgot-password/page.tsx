import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { AuthLogo } from '../../../components/BrandLogo';
import { Card, LocaleSwitch, PageTitle } from '@nuzm/ui';
import { ForgotForm } from '../../../components/AuthForms';

export default async function ForgotPassword({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <AuthLogo href={`/${locale}`} />
      <PageTitle>{t(locale, 'forgot.title')}</PageTitle>
      <Card>
        <p>{t(locale, 'forgot.body')}</p>
        <ForgotForm locale={locale} />
        <p>
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
