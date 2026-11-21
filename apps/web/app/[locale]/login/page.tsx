import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink } from '@nuzm/ui';
import { AuthShell, OrDivider } from '../../../components/AuthShell';
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
  const next = safeNext(rt, `/${locale}/console`);
  const returnTo = encodeURIComponent(next);
  return (
    <AuthShell
      locale={locale}
      variant="login"
      title={t(locale, 'login.title')}
      sub={t(locale, 'login.body')}
    >
      {error && (
        <p role="alert" className="nz-error-text">
          {t(locale, 'login.error')}
        </p>
      )}
      <ButtonLink variant="secondary" href={`/v1/auth/oidc/login?returnTo=${returnTo}`}>
        {t(locale, 'login.sso')}
      </ButtonLink>
      <OrDivider locale={locale} />
      <LoginForm locale={locale} next={next} />
      <p className="nzc-split-links">
        <a href={`/${locale}/forgot-password`}>{t(locale, 'login.forgot')}</a>
      </p>
      <p className="nzc-split-links">
        {t(locale, 'login.noAccount')}{' '}
        <a href={`/${locale}/register`}>{t(locale, 'login.register')}</a>
      </p>
    </AuthShell>
  );
}
