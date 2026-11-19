import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink } from '@nuzm/ui';
import { AdminLoginForm } from '../../../components/AdminLoginForm';
import { AuthShell, OrDivider } from '../../../components/AuthShell';

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
  const next = `/${locale}/organizations`;
  const returnTo = encodeURIComponent(`${adminOrigin}${next}`);
  return (
    <AuthShell
      locale={locale}
      title={t(locale, 'login.admin.title')}
      sub={t(locale, 'anc.login.help')}
    >
      {error && (
        <p role="alert" className="nz-error-text">
          {t(locale, error === 'forbidden' ? 'login.error.forbidden' : 'login.error')}
        </p>
      )}
      <AdminLoginForm locale={locale} next={next} />
      <OrDivider locale={locale} />
      <ButtonLink variant="secondary" href={`/v1/auth/oidc/login?realm=admin&returnTo=${returnTo}`}>
        {t(locale, 'login.sso')}
      </ButtonLink>
    </AuthShell>
  );
}
