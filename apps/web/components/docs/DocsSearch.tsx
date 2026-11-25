'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@nuzm/ui';

export interface SearchEntry {
  title: string;
  sub: string;
  href: string;
  kind: string;
}

/**
 * Search of the documentation: the guides and every endpoint, filtered in the browser (nothing is sent anywhere). Ctrl/Cmd+K focuses it, the arrow keys
 * move through the results, Enter opens one, Escape closes the list. Words are matched anywhere in the title, the method and path, and the area.
 */
export function DocsSearch({
  entries,
  labels,
}: {
  entries: SearchEntry[];
  labels: { placeholder: string; empty: string; results: string };
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return entries
      .filter((e) => {
        const hay = `${e.title} ${e.sub} ${e.kind}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 8);
  }, [q, entries]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', outside);
    };
  }, []);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      input.current?.blur();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter' && hits[cursor]) {
      window.location.href = hits[cursor]!.href;
    }
  }

  const show = open && q.trim() !== '';
  return (
    <div className="doc-search" ref={box} role="search">
      <Icon name="search" size={18} />
      <input
        ref={input}
        type="search"
        value={q}
        placeholder={labels.placeholder}
        aria-label={labels.placeholder}
        aria-expanded={show}
        aria-controls="doc-search-results"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onKeyDown={onKey}
      />
      <kbd aria-hidden="true">⌘K</kbd>
      {show && (
        <ul id="doc-search-results" className="doc-search-list" aria-label={labels.results}>
          {hits.length === 0 ? (
            <li className="doc-search-empty">{labels.empty}</li>
          ) : (
            hits.map((h, i) => (
              <li key={h.href} aria-selected={i === cursor}>
                <a href={h.href} onMouseEnter={() => setCursor(i)}>
                  <strong dir="auto">{h.title}</strong>
                  <small dir="ltr">
                    {h.kind} · {h.sub}
                  </small>
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
