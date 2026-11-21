import type { ReactNode } from 'react';
import '../../../components/landing/landing.css';
import '../../../components/site/mosaic.css';
import '../../../components/site/site.css';

/** The public pages (services): the landing page's identity stylesheet plus the layout of the service pages. The <html> element comes from the locale layout. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="/fonts/identity/fonts.css" precedence="default" />
      {children}
    </>
  );
}
