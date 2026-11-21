'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

/** Text of the two small controls; the page language comes from <html lang> (the table itself takes no locale). */
const WORDS = {
  ar: { cards: 'عرض كبطاقات', table: 'عرض كجدول', manage: 'إدارة' },
  en: { cards: 'Show as cards', table: 'Show as a table', manage: 'Manage' },
} as const;
const words = () =>
  typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? WORDS.ar : WORDS.en;

type View = 'cards' | 'table';
const KEY = 'nuzm.tableView';
const EVENT = 'nuzm:table-view';

/** The remembered choice, or null when none was made (then the surroundings decide: see `defaultFor`). */
function stored(): View | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'table' || v === 'cards' ? v : null;
  } catch {
    return null; // storage can be blocked: the default applies
  }
}
/** Cards are the default everywhere except inside an area that asks for tables (`data-table-default="table"`: the workspace panels, where tables hold many small columns). */
const defaultFor = (el: Element | null): View =>
  el?.closest('[data-table-default]')?.getAttribute('data-table-default') === 'table'
    ? 'table'
    : 'cards';

/** The Cards / Table switch at the top of every data table. One choice for all tables, remembered in this browser. */
export function TableViewToggle() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>('cards');
  const [w, setW] = useState<(typeof WORDS)[keyof typeof WORDS]>(WORDS.en);
  useEffect(() => {
    setW(words());
    const apply = (v: View) => {
      setView(v);
      const wrap = ref.current?.closest('.nz-table-wrap');
      if (wrap) wrap.setAttribute('data-view', v);
    };
    apply(stored() ?? defaultFor(ref.current));
    const on = (e: Event) => apply((e as CustomEvent<View>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const choose = (v: View) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent<View>(EVENT, { detail: v }));
  };
  return (
    <div className="nz-view-toggle" ref={ref}>
      <button
        type="button"
        aria-label={w.cards}
        title={w.cards}
        aria-pressed={view === 'cards'}
        onClick={() => choose('cards')}
      >
        <Icon name="grid" size={16} />
      </button>
      <button
        type="button"
        aria-label={w.table}
        title={w.table}
        aria-pressed={view === 'table'}
        onClick={() => choose('table')}
      >
        <Icon name="list" size={16} />
      </button>
    </div>
  );
}

/** The Manage button's text: the caller's label, else the page language's word. */
export function ManageText({ label }: { label?: string }) {
  const [text, setText] = useState(label ?? WORDS.en.manage);
  useEffect(() => {
    if (!label) setText(words().manage);
  }, [label]);
  return <>{text}</>;
}
