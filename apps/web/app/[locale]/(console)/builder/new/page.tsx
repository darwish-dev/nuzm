import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';

/** The wizard is gone: "Start a project" (the prompt box) is the list page. Old links and bookmarks land there. */
export default async function NewProject({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/builder/projects`);
}
