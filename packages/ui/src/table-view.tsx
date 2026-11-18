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

function stored(): View {
  try {
    return localStorage.getItem(KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards'; // storage can be blocked: cards stay the default
  }
}

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
    apply(stored());
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
