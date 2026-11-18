import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { ChangePasswordForm } from '../../../../../../components/AuthForms';
import { requireSession } from '../../../../../../lib/server';

export default async function Password({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  return (
    <>
      <PageTitle>{t(locale, 'pw.change.title')}</PageTitle>
      <p>{t(locale, 'pw.change.help')}</p>
      <ChangePasswordForm locale={locale} email={s.me.email} />
    </>
  );
}
