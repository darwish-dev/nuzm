'use client';
import { useState } from 'react';
import type { Locale } from '@nuzm/i18n';
import { FloatingDock } from './FloatingDock';
import { SiteFooter } from './SiteFooter';

/** The shared footer for the server-rendered public pages: it holds the appearance state, switches the page (`data-mode` on the nearest `.landing`) and remembers the choice in the same `nuzm_theme` cookie the rest of the site reads. */
export function FrameFooter({
  locale,
  initial,
  langHref,
}: {
  locale: Locale;
  initial: 'dark' | 'light';
  langHref: string;
}) {
  const [dark, setDark] = useState(initial === 'dark');
  function toggle() {
    const next = !dark;
    setDark(next);
    document.querySelector('.landing')?.setAttribute('data-mode', next ? 'dark' : 'light');
    try {
      document.cookie = `nuzm_theme=${next ? 'dark' : 'light'}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* cookies refused: the choice lasts for this page only */
    }
  }
  return (
    <>
      <SiteFooter locale={locale} langHref={langHref} dark={dark} onToggleTheme={toggle} />
      <FloatingDock locale={locale} langHref={langHref} dark={dark} onToggleTheme={toggle} />
    </>
  );
}
