import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { dir, isLocale, type Locale } from '@nuzm/i18n';
import { LOCALE_COOKIE } from '../proxy';
import '@fontsource-variable/cairo';
import { LandingPage } from '../components/landing/LandingPage';
import { desktopDownloads } from '../lib/desktop-downloads';
import '../components/landing/landing.css';
import '../components/landing/dashboard-art.css';
import '../components/site/mosaic.css';
import '../components/site/bento.css';
import '../components/site/site.css';
import '../components/landing/ai-chat.css';
import '../components/landing/tech-strip.css';
import '../components/landing/showcase.css';
import '../components/site/flat.css';
import '../components/landing/landing-rtl.css';
import '../components/site/chrome.css';
import '../components/landing/downloads.css';
import '../components/site/signature.css';

/** The landing page is the one page outside the proxy's `/<locale>` tree: it reads the same language cookie itself. No cookie means English, as before. */
async function currentLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return v && isLocale(v) ? v : 'en';
}

export async function generateMetadata(): Promise<Metadata> {
  const ar = (await currentLocale()) === 'ar';
  return {
    title: ar ? 'نظم | حيث يلتقي الذكاء بالإمكانات' : 'Nuzm | Intelligence meets possibility',
    description: ar
      ? 'وكلاء ذكاء اصطناعي وخوادم سحابية ونطاقات وتطوير بالذكاء الاصطناعي. اجمع عملك في مكان واحد مع نظم.'
      : 'AI agents, cloud servers, domains, and AI-powered development. Bring your business together with Nuzm.',
  };
}

export default async function Index() {
  const locale = await currentLocale();
  // which desktop installers can be downloaded right now (a configured address or a file on this server)
  const desktop = await desktopDownloads();
  return (
    <html lang={locale} dir={dir(locale)}>
      <head>
        <link rel="stylesheet" href="/fonts/identity/fonts.css" />
      </head>
      <body className="nuzm-landing">
        <LandingPage locale={locale} desktop={desktop} />
      </body>
    </html>
  );
}
