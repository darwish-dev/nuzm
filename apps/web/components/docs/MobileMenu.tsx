'use client';
import { useState, type ReactNode } from 'react';

/**
 * The docs navigation: always shown beside the page on a wide screen (plain CSS, so it is there before any script runs), and behind a "Menu" button on a
 * narrow one. The button does nothing on a wide screen (it is hidden there).
 */
export function MobileMenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="doc-side-wrap" data-open={open}>
      <button type="button" className="doc-side-toggle" aria-expanded={open} aria-controls="doc-side-links" onClick={() => setOpen(!open)}>
        {label}
      </button>
      <div id="doc-side-links" className="doc-side-links">
        {children}
      </div>
    </div>
  );
}
