import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, Card, LocaleSwitch, PageTitle } from '@nuzm/ui';

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
  // only same-site relative paths are offered back to the API (which validates returnTo again)
  const safe = rt && rt.startsWith('/') && !rt.startsWith('//') ? rt : `/${locale}`;
  const returnTo = encodeURIComponent(safe);
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
        <ButtonLink href={`/v1/auth/oidc/login?returnTo=${returnTo}`}>
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
