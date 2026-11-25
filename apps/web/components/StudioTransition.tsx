'use client';
import { useEffect } from 'react';

/** The AI Studio pages (the builder start page and its full-screen workspaces). */
export const isStudioPath = (path: string) => /^(\/(ar|en))?\/(builder|mobile)(\/|$)/.test(path);

interface SwapEvent extends Event {
  viewTransition: { skipTransition(): void } | null;
  activation: { entry: { url: string } } | null;
}

/**
 * The smooth passage into and out of AI Studio. The browser animates page changes (a cross-document view transition, declared in the console CSS); this keeps
 * that animation for the two moments it is meant for, opening AI Studio and closing it, and skips it on every other page change so the rest of the console
 * stays instant. Browsers without view transitions, and "reduce motion", simply change the page.
 */
export function StudioTransition() {
  useEffect(() => {
    const onSwap = (e: Event) => {
      const { viewTransition, activation } = e as SwapEvent;
      if (!viewTransition) return;
      const to = activation?.entry.url;
      const crossing = to
        ? isStudioPath(location.pathname) !== isStudioPath(new URL(to).pathname)
        : false;
      if (!crossing) viewTransition.skipTransition();
    };
    window.addEventListener('pageswap', onSwap);
    return () => window.removeEventListener('pageswap', onSwap);
  }, []);
  return null;
}
