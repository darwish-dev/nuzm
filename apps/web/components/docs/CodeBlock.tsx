'use client';
import { useState } from 'react';
import { Icon } from '@nuzm/ui';

/**
 * A code sample with a copy button. The text is always left to right (code is not mirrored in Arabic). Copying needs the clipboard, which a browser may refuse
 * (an insecure page, a permission): the button then simply stays as it was, and the text can still be selected by hand.
 */
export function CodeBlock({
  code,
  label,
  copyLabel,
  copiedLabel,
}: {
  code: string;
  label?: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch {
      setDone(false);
    }
  }
  return (
    <figure className="doc-code">
      <figcaption>
        <span>{label}</span>
        <button type="button" onClick={() => void copy()} aria-live="polite">
          <Icon name={done ? 'check' : 'copy'} size={14} />
          {done ? copiedLabel : copyLabel}
        </button>
      </figcaption>
      <pre dir="ltr" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
