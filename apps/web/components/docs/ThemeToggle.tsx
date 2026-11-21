'use client';
import { useEffect, useState } from 'react';
import { Icon } from '@nuzm/ui';

/** Light / dark for the documentation. It writes the same `nuzm_theme` cookie the rest of the site reads, and switches the page at once. */
export function ThemeToggle({
  initial,
  labels,
}: {
  initial: 'dark' | 'light';
  labels: { light: string; dark: string; group: string };
}) {
  const [mode, setMode] = useState<'dark' | 'light'>(initial);
  useEffect(() => {
    document.querySelector('.doc-app')?.setAttribute('data-mode', mode);
  }, [mode]);
  function set(m: 'dark' | 'light') {
    setMode(m);
    try {
      document.cookie = `nuzm_theme=${m}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* cookies refused: the choice lasts for this page only */
    }
  }
  return (
    <div className="doc-theme" role="group" aria-label={labels.group}>
      <button
        type="button"
        aria-pressed={mode === 'light'}
        aria-label={labels.light}
        title={labels.light}
        onClick={() => set('light')}
      >
        <Icon name="sun" size={16} />
      </button>
      <button
        type="button"
        aria-pressed={mode === 'dark'}
        aria-label={labels.dark}
        title={labels.dark}
        onClick={() => set('dark')}
      >
        <Icon name="moon" size={16} />
      </button>
    </div>
  );
}
