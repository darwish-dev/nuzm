'use client';
import { useEffect, useState } from 'react';

type Score = 'good' | 'okay' | 'bad';
const FACES: { id: Score; path: string }[] = [
  { id: 'good', path: 'M8 14s1.5 2 4 2 4-2 4-2' },
  { id: 'okay', path: 'M9 15h6' },
  { id: 'bad', path: 'M8 16s1.5-2 4-2 4 2 4 2' },
];

/**
 * "Was this helpful?" with three faces. The choice is kept in this browser only (so the page remembers it); it is not sent anywhere yet, and the thank-you
 * line does not say otherwise. Storage can be refused (a private window): the control then simply works for this visit.
 */
export function HelpfulRating({
  page,
  labels,
}: {
  page: string;
  labels: { question: string; good: string; okay: string; bad: string; thanks: string };
}) {
  const key = `nuzm.docs.rating:${page}`;
  const [score, setScore] = useState<Score | null>(null);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key);
      setScore(v === 'good' || v === 'okay' || v === 'bad' ? v : null);
    } catch {
      setScore(null);
    }
  }, [key]);
  function pick(s: Score) {
    setScore(s);
    try {
      window.localStorage.setItem(key, s);
    } catch {
      /* private window: keep the choice for this visit only */
    }
  }
  const name: Record<Score, string> = { good: labels.good, okay: labels.okay, bad: labels.bad };
  return (
    <div className="doc-rate">
      <p id="doc-rate-q">{labels.question}</p>
      <div role="group" aria-labelledby="doc-rate-q">
        {FACES.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-label={name[f.id]}
            title={name[f.id]}
            aria-pressed={score === f.id}
            onClick={() => pick(f.id)}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9.5h.01M15 9.5h.01" />
              <path d={f.path} />
            </svg>
          </button>
        ))}
      </div>
      {score && (
        <p className="doc-rate-thanks" role="status">
          {labels.thanks}
        </p>
      )}
    </div>
  );
}
