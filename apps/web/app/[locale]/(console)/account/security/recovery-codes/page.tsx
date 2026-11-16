import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { RecoveryCodes } from '../../../../../../components/AccountPanels';
import { requireSession } from '../../../../../../lib/server';

export default async function Recovery({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  return (
    <>
      <PageTitle>{t(locale, 'recovery.title')}</PageTitle>
      <RecoveryCodes locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
    </>
  );
}
