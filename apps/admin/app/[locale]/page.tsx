import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <main style={{ padding: 'var(--nuzm-space-6)' }}>
      <h1>{t(locale, 'app.admin.title')}</h1>
      <p style={{ color: 'var(--nuzm-color-muted)' }}>{t(locale, 'app.shell.placeholder')}</p>
      <a href={`/${other}`} lang={other} style={{ marginInlineStart: 'var(--nuzm-space-2)' }}>
        {t(locale, 'app.locale.switch')}
      </a>
    </main>
  );
}
