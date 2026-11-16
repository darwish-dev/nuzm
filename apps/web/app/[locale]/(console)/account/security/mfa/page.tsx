import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { MfaSetup } from '../../../../../../components/MfaSetup';
import { requireSession } from '../../../../../../lib/server';

export default async function Mfa({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireSession(locale);
  return (
    <>
      <PageTitle>{t(locale, 'mfa.title')}</PageTitle>
      <MfaSetup locale={locale} />
    </>
  );
}
