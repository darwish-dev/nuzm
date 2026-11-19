'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-renders the server page every few seconds while a run is still working, so a design request does not stay on "Running" after it has finished or failed.
 * It renders nothing; it stops when the page stops mounting it (the run reached a final state) or the tab is hidden.
 */
export function RunAutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
