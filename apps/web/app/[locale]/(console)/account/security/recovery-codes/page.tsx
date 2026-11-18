import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';

/** Kept so old links work: this is now the "recovery" section of the account page. */
export default async function Recovery({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/${locale}/account#recovery`);
}
