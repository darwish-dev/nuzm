import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { cssVariables } from '@nuzm/ui';
import { dir, isLocale, locales } from '@nuzm/i18n';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
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
  return (
    <html lang={locale} dir={dir(locale)}>
      <head>
        <style>{cssVariables()}</style>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: 'var(--nuzm-font-sans)',
          color: 'var(--nuzm-color-fg)',
          background: 'var(--nuzm-color-bg)',
        }}
      >
        {children}
      </body>
    </html>
  );
}
