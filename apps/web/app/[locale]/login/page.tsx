import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, Card, LocaleSwitch, PageTitle } from '@nuzm/ui';
import { LoginForm } from '../../../components/AuthForms';
import { safeNext } from '../../../lib/auth';

export default async function Login({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { locale } = await params;
  const { error, returnTo: rt } = await searchParams;
  if (!isLocale(locale)) notFound();
  // only same-site relative paths are followed (the API validates returnTo again for the identity-provider flow)
  const next = safeNext(rt, `/${locale}`);
  const returnTo = encodeURIComponent(next);
  return (
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <PageTitle>{t(locale, 'login.title')}</PageTitle>
      <Card>
        <p>{t(locale, 'login.body')}</p>
        {error && (
          <p role="alert" className="nz-error-text">
            {t(locale, 'login.error')}
          </p>
        )}
        <LoginForm locale={locale} next={next} />
        <p>
          <a href={`/${locale}/forgot-password`}>{t(locale, 'login.forgot')}</a>
        </p>
        <p>
          {t(locale, 'login.noAccount')}{' '}
          <a href={`/${locale}/register`}>{t(locale, 'login.register')}</a>
        </p>
        <hr />
        <ButtonLink variant="secondary" href={`/v1/auth/oidc/login?returnTo=${returnTo}`}>
          {t(locale, 'login.sso')}
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
