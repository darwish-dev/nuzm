import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { baseCss, consoleCss, cssVariables } from '@nuzm/ui';
import { dir, isLocale, locales, t } from '@nuzm/i18n';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { title: isLocale(locale) ? t(locale, 'app.admin.title') : 'Nuzm' };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const theme = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang={locale} dir={dir(locale)}>
      <head>
        <style>{cssVariables() + baseCss + consoleCss}</style>
      </head>
      <body className="nzc" data-theme={theme}>
        {children}
      </body>
    </html>
  );
}
