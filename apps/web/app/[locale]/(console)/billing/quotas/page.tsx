import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@nuzm/i18n';

/** Kept so old links work: this is now the "quotas" section of /billing/usage. */
export default async function Moved({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  const qs = q.toString();
  redirect(`/${locale}/billing/usage${qs ? `?${qs}` : ''}#quotas`);
}
