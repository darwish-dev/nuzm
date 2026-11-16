import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, Card, LocaleSwitch, PageTitle } from '@nuzm/ui';

export default async function Login({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  if (!isLocale(locale)) notFound();
  const adminOrigin = process.env.ADMIN_ORIGIN ?? 'http://127.0.0.1:3001';
  const returnTo = encodeURIComponent(`${adminOrigin}/${locale}/organizations`);
  return (
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <PageTitle>{t(locale, 'login.admin.title')}</PageTitle>
      <Card>
        <p>{t(locale, 'login.admin.body')}</p>
        {error && (
          <p role="alert" className="nz-error-text">
            {t(locale, error === 'forbidden' ? 'login.error.forbidden' : 'login.error')}
          </p>
        )}
        <ButtonLink href={`/v1/auth/oidc/login?realm=admin&returnTo=${returnTo}`}>
          {t(locale, 'action.signin')}
        </ButtonLink>
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
