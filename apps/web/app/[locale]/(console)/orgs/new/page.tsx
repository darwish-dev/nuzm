import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { CreateOrgForm } from '../../../../../components/CreateOrgForm';
import { requireSession } from '../../../../../lib/server';

export default async function NewOrg({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireSession(locale);
  return (
    <>
      <PageTitle>{t(locale, 'org.new.title')}</PageTitle>
      <p>{t(locale, 'org.new.help')}</p>
      <CreateOrgForm locale={locale} />
    </>
  );
}
