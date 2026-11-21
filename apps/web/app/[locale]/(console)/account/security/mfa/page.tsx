import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';

/** Kept so old links work: this is now the "mfa" section of the account page. */
export default async function Mfa({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/account#mfa`);
}
