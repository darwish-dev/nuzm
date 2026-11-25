'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';

/**
 * Four round icon buttons, no text, floating at the bottom left of the public site: appearance (dark / light), language, and previous / next section.
 * The arrows move one section at a time (the page's own sections and its footer), never the whole page at once. The page is `.landing`: on the home page
 * that element scrolls (section by section); on the other public pages the document does, so the buttons scroll whichever one actually moves. The appearance buttons write the same `nuzm_theme` cookie the rest of the site reads.
 */
const LABELS = {
  en: {
    light: 'Light appearance',
    dark: 'Dark appearance',
    up: 'Previous section',
    down: 'Next section',
  },
  ar: { light: 'مظهر فاتح', dark: 'مظهر داكن', up: 'القسم السابق', down: 'القسم التالي' },
} as const;

type Scroller = {
  top: number;
  max: number;
  /** where each section starts (px from the start of the scrolling area), in order */
  starts: number[];
  to: (y: number) => void;
};

/** Where an element starts on the page, from layout (not from what is painted: an entrance animation must not move the target). */
function pageTop(el: HTMLElement): number {
  let y = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null)
    y += n.offsetTop;
  return y;
}

/** The element that scrolls right now: the landing panel when it is scrollable, otherwise the page. */
function scroller(): Scroller {
  const root = document.querySelector<HTMLElement>('.landing');
  // matchMedia is missing in some environments (jsdom, very old browsers): treat that as "motion allowed".
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  const sections = root
    ? Array.from(
        root.querySelectorAll<HTMLElement>(
          ':scope > section, :scope > main > section, :scope > footer',
        ),
      )
    : [];
  if (
    root &&
    root.scrollHeight > root.clientHeight + 1 &&
    getComputedStyle(root).overflowY !== 'visible'
  ) {
    const base = pageTop(root);
    return {
      top: root.scrollTop,
      max: root.scrollHeight - root.clientHeight,
      starts: sections.map((el) => pageTop(el) - base),
      to: (y) => root.scrollTo({ top: y, behavior }),
    };
  }
  const doc = document.scrollingElement ?? document.documentElement;
  return {
    top: doc.scrollTop,
    max: doc.scrollHeight - window.innerHeight,
    starts: sections.map((el) => pageTop(el)),
    to: (y) => window.scrollTo({ top: y, behavior }),
  };
}

/** The section starts, clamped to what can be reached, in order (the last ones can share the maximum). */
function stops(s: Scroller): number[] {
  return [...new Set(s.starts.map((y) => Math.min(Math.max(y, 0), s.max)))].sort((a, b) => a - b);
}

/** The section on screen: the nearest start to where the page is now. */
function nearest(list: number[], top: number): number {
  let best = 0;
  list.forEach((y, i) => {
    if (Math.abs(y - top) < Math.abs(list[best]! - top)) best = i;
  });
  return best;
}

export function FloatingDock({
  locale,
  langHref,
  dark,
  onToggleTheme,
}: {
  locale: Locale;
  /** the same page in the other language */
  langHref: string;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const t = LABELS[locale === 'ar' ? 'ar' : 'en'];
  const other = locale === 'ar' ? 'en' : 'ar';
  /** the section a click is already scrolling to (a second click during the scroll goes on from there) */
  const going = useRef<{ index: number; until: number }>({ index: 0, until: 0 });
  const [hasPrev, setHasPrev] = useState(false);
  const [hasNext, setHasNext] = useState(true);

  useEffect(() => {
    const sync = () => {
      const sc = scroller();
      const list = stops(sc);
      const i = nearest(list, sc.top);
      setHasPrev(i > 0 || sc.top > list[0]! + 8);
      setHasNext(i < list.length - 1 || sc.top < sc.max - 8);
    };
    sync();
    const root = document.querySelector('.landing');
    root?.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      root?.removeEventListener('scroll', sync);
      window.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  /** one section up (-1) or down (1) */
  function step(dir: -1 | 1) {
    const sc = scroller();
    const list = stops(sc);
    const now = performance.now();
    const from = now < going.current.until ? going.current.index : nearest(list, sc.top);
    const to = Math.min(Math.max(from + dir, 0), list.length - 1);
    going.current = { index: to, until: now + 800 };
    sc.to(list[to]!);
  }

  function toggle() {
    try {
      document.cookie = `nuzm_theme=${dark ? 'light' : 'dark'}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* cookies refused: the choice lasts for this page only */
    }
    onToggleTheme();
  }

  return (
    <nav className="float-dock" aria-label={locale === 'ar' ? 'أدوات سريعة' : 'Quick controls'}>
      <button
        type="button"
        onClick={toggle}
        aria-label={dark ? t.light : t.dark}
        title={dark ? t.light : t.dark}
      >
        <Icon name={dark ? 'sun' : 'moon'} size={18} />
      </button>
      <a
        href={langHref}
        lang={other}
        hrefLang={other}
        aria-label={other === 'ar' ? 'العربية' : 'English'}
        title={other === 'ar' ? 'العربية' : 'English'}
      >
        <Icon name="globe" size={18} />
      </a>
      <button
        type="button"
        data-dir="up"
        disabled={!hasPrev}
        onClick={() => step(-1)}
        aria-label={t.up}
        title={t.up}
      >
        <Icon name="chevron" size={18} />
      </button>
      <button
        type="button"
        data-dir="down"
        disabled={!hasNext}
        onClick={() => step(1)}
        aria-label={t.down}
        title={t.down}
      >
        <Icon name="chevron" size={18} />
      </button>
    </nav>
  );
}
