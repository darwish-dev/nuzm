import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Card, PageTitle } from '@nuzm/ui';
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
    <main className="nz-main" style={{ maxInlineSize: 480, marginInline: 'auto' }}>
      <PageTitle>{t(locale, 'reset.title')}</PageTitle>
      <Card>
        {token ? (
          <ResetForm locale={locale} token={token} />
        ) : (
          <>
            <p className="nz-error-text">{t(locale, 'reset.invalid')}</p>
            <a href={`/${locale}/forgot-password`}>{t(locale, 'forgot.title')}</a>
          </>
        )}
      </Card>
    </main>
  );
}
