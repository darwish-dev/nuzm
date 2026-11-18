'use client';
import { useParams } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Skeleton } from '@nuzm/ui';

/** Loading state of the AI screens, announced in the page's own language. */
export function AiLoading() {
  const { locale } = useParams<{ locale: string }>();
  return <Skeleton lines={4} label={t(isLocale(locale) ? locale : 'ar', 'state.loading')} />;
}
