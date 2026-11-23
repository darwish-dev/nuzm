'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';

/**
 * The divider between the chat and the preview of a builder workspace: drag it (mouse, pen or touch) to make the chat wider or narrower, or focus it and
 * use the arrow keys (Home / End for the narrowest / widest, double-click or Enter to return to the default). It works in both directions (Arabic right to
 * left, English left to right). The width is a CSS variable on the workspace body (`--bws-chat`), so the layout stays a grid; it is remembered in this
 * browser only. Hidden where the layout stacks (narrow screens).
 */
export const CHAT_DEFAULT = 360;
export const CHAT_MIN = 280;
const CHAT_MAX = 760;
const STEP = 24;
const KEY = 'nuzm.builder.chatWidth';

/** The widest the chat may be: never more than 60% of the workspace, so the preview keeps room. */
export const chatMax = (bodyWidth: number) =>
  Math.max(CHAT_MIN, Math.min(CHAT_MAX, Math.round(bodyWidth * 0.6)));
export const clampChat = (w: number, bodyWidth: number) =>
  Math.round(Math.min(chatMax(bodyWidth), Math.max(CHAT_MIN, w)));

export function PanelResizer({ locale, chatId }: { locale: Locale; chatId: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(CHAT_DEFAULT);
  const [max, setMax] = useState(CHAT_MAX);
  const dragging = useRef(false);

  const body = () => el.current?.parentElement ?? null;
  const apply = (w: number, save = true) => {
    const b = body();
    if (!b) return;
    const next = clampChat(w, b.clientWidth);
    b.style.setProperty('--bws-chat', `${next}px`);
    setWidth(next);
    setMax(chatMax(b.clientWidth));
    if (save)
      try {
        localStorage.setItem(KEY, String(next));
      } catch {
        // storage may be blocked (private window): the width simply is not remembered
      }
  };

  useEffect(() => {
    let saved = CHAT_DEFAULT;
    try {
      const v = Number(localStorage.getItem(KEY));
      if (Number.isFinite(v) && v > 0) saved = v;
    } catch {
      // no storage: start from the default
    }
    apply(saved, false);
    const onResize = () =>
      apply(
        Number(getComputedStyle(body()!).getPropertyValue('--bws-chat').replace('px', '')) ||
          CHAT_DEFAULT,
        false,
      );
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const rtl = () => getComputedStyle(body() ?? document.documentElement).direction === 'rtl';
  /** The chat width for a pointer at `x`: measured from the side the chat is on (right in Arabic, left in English). */
  const widthAt = (x: number) => {
    const r = body()!.getBoundingClientRect();
    const pad = 12;
    return rtl() ? r.right - pad - x : x - r.left - pad;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    el.current?.setPointerCapture(e.pointerId);
    body()?.setAttribute('data-resizing', 'true');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) apply(widthAt(e.clientX), false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    el.current?.releasePointerCapture(e.pointerId);
    body()?.removeAttribute('data-resizing');
    apply(widthAt(e.clientX));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    // the arrow toward the preview widens the chat: right in English, left in Arabic
    const wider = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const narrower = rtl() ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (e.key === wider) next = width + STEP;
    else if (e.key === narrower) next = width - STEP;
    else if (e.key === 'Home') next = CHAT_MIN;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') next = CHAT_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    apply(next);
  };

  return (
    <div
      ref={el}
      className="bws-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-controls={chatId}
      aria-label={t(locale, 'bld.ws.resize')}
      title={t(locale, 'bld.ws.resizeHint')}
      aria-valuemin={CHAT_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => apply(CHAT_DEFAULT)}
      onKeyDown={key}
    >
      <span aria-hidden="true" />
    </div>
  );
}
