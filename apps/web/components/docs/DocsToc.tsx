'use client';
import { useEffect, useState } from 'react';

export interface TocItem {
  id: string;
  label: string;
}

/** "On this page": the headings of the open page, with the one being read marked. Plain links, so it works without scripts; the marking follows the scroll. */
export function DocsToc({ items, title }: { items: TocItem[]; title: string }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);
  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id);
          else seen.delete(e.target.id);
        }
        const first = items.find((i) => seen.has(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-80px 0px -65% 0px' },
    );
    for (const i of items) {
      const el = document.getElementById(i.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [items]);
  if (items.length === 0) return null;
  return (
    <nav className="doc-toc-nav" aria-label={title}>
      <p className="doc-toc-title">{title}</p>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} aria-current={active === i.id ? 'location' : undefined}>
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
