import type { Metadata } from 'next';
import '@fontsource-variable/cairo';
import { LandingPage } from '../components/landing/LandingPage';
import '../components/landing/landing.css';
import '../components/landing/dashboard-art.css';
import '../components/site/mosaic.css';
import '../components/site/bento.css';
import '../components/landing/ai-chat.css';

export const metadata: Metadata = {
  title: 'Nuzm | Intelligence meets possibility',
  description:
    'AI agents, cloud servers, domains, and AI-powered development. Bring your business together with Nuzm.',
};

export default function Index() {
  return (
    <html lang="en" dir="ltr">
      <head>
        <link rel="stylesheet" href="/fonts/identity/fonts.css" />
      </head>
      <body className="nuzm-landing">
        <LandingPage />
      </body>
    </html>
  );
}
