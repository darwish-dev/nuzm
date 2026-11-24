'use client';

import { useEffect, type RefObject } from 'react';

/** One wheel burst or vertical swipe advances one panel. Tall panels stay readable. */
export function useSectionScroll(rootRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const panels = Array.from(
      root.querySelectorAll<HTMLElement>(':scope > section, :scope > footer'),
    );
    const entrance = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          (entry.target as HTMLElement).dataset.visible = entry.isIntersecting ? 'true' : 'false';
        }
      },
      { root, threshold: 0.5 },
    );
    panels.forEach((panel) => {
      panel.classList.add('section-panel');
      entrance.observe(panel);
    });
    const syncHash = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const panel = panels.find(
        (p) => p.id === id || Array.from(p.querySelectorAll('[id]')).some((el) => el.id === id),
      );
      if (panel) {
        panel.scrollTop = 0;
        root.scrollTo({ top: panel.offsetTop, behavior: 'instant' });
      }
    };
    // Handle anchors before native fragment scrolling can offset content inside a panel.
    const anchorClick = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (!link) return;
      const hash = link.getAttribute('href') ?? '';
      const id = hash.slice(1);
      const panel = panels.find(
        (p) => p.id === id || Array.from(p.querySelectorAll('[id]')).some((el) => el.id === id),
      );
      if (!id || !panel) return;
      event.preventDefault();
      panel.scrollTop = 0;
      history.replaceState(null, '', hash);
      root.scrollTo({
        top: panel.offsetTop,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    };
    root.addEventListener('click', anchorClick);
    syncHash();
    window.addEventListener('hashchange', syncHash);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let lastWheel = 0;
    let accumulated = 0;
    let consumed = false;
    let lockedUntil = 0;
    let startX = 0;
    let startY = 0;
    let touchPanel: HTMLElement | undefined;
    let captureSwipe: boolean | undefined;
    const editable = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('input,textarea,select,[contenteditable="true"],dialog[open]'));
    const current = () =>
      panels.reduce(
        (best, panel) =>
          Math.abs(panel.offsetTop - root.scrollTop) < Math.abs(best.offsetTop - root.scrollTop)
            ? panel
            : best,
        panels[0]!,
      );
    const canReadMore = (panel: HTMLElement, direction: number) =>
      direction > 0
        ? panel.scrollTop + panel.clientHeight < panel.scrollHeight - 24
        : panel.scrollTop > 24;
    const move = (direction: number) => {
      if (performance.now() < lockedUntil || root.querySelector('dialog[open]')) return;
      const panel = current();
      const next = panels[panels.indexOf(panel) + direction];
      if (!next) return;
      lockedUntil = performance.now() + (reduced.matches ? 120 : 750);
      root.scrollTo({ top: next.offsetTop, behavior: reduced.matches ? 'instant' : 'smooth' });
    };
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        editable(event.target) ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      )
        return;
      const now = performance.now();
      if (now - lastWheel > 200) {
        consumed = false;
        accumulated = 0;
      }
      lastWheel = now;
      const direction = Math.sign(event.deltaY);
      if (!direction) return;
      if (!consumed && now >= lockedUntil && canReadMore(current(), direction)) return;
      event.preventDefault();
      if (consumed || now < lockedUntil) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1);
      accumulated = Math.sign(accumulated) !== direction ? delta : accumulated + delta;
      if (Math.abs(accumulated) >= 24) {
        consumed = true;
        move(direction);
      }
    };
    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchPanel = undefined;
      captureSwipe = undefined;
      if (!touch || event.touches.length !== 1 || editable(event.target)) return;
      startX = touch.clientX;
      startY = touch.clientY;
      touchPanel = current();
    };
    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !touchPanel || event.touches.length !== 1) return;
      const dy = startY - touch.clientY;
      if (Math.abs(dy) < 10) return;
      if (captureSwipe === undefined)
        captureSwipe =
          Math.abs(dy) > Math.abs(startX - touch.clientX) &&
          !canReadMore(touchPanel, Math.sign(dy));
      if (captureSwipe) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (touch && captureSwipe && Math.abs(startY - touch.clientY) >= 50)
        move(Math.sign(startY - touch.clientY));
      touchPanel = undefined;
      captureSwipe = undefined;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        editable(event.target) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        root.querySelector('dialog[open]')
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest('button,a') &&
        [' ', 'Enter'].includes(event.key)
      )
        return;
      const direction = ['PageDown', 'ArrowDown', ' '].includes(event.key)
        ? event.shiftKey
          ? -1
          : 1
        : ['PageUp', 'ArrowUp'].includes(event.key)
          ? -1
          : 0;
      if (direction && !canReadMore(current(), direction)) {
        event.preventDefault();
        move(direction);
      }
    };
    root.addEventListener('wheel', wheel, { passive: false });
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: false });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('touchcancel', touchEnd, { passive: true });
    window.addEventListener('keydown', keyDown);
    return () => {
      root.removeEventListener('click', anchorClick);
      window.removeEventListener('hashchange', syncHash);
      entrance.disconnect();
      panels.forEach((panel) => {
        panel.classList.remove('section-panel');
        delete panel.dataset.visible;
      });
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', touchEnd);
      window.removeEventListener('keydown', keyDown);
    };
  }, [rootRef]);
}
