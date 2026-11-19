import type { ReactNode } from 'react';
import { Art, type ArtName } from '@nuzm/ui';

/**
 * The "start something new" card at the top of a list page: a heading and a sentence, the actions under them, and an illustration on the other
 * side (decorative, hidden on a narrow screen). Server component, no state.
 */
export function StartHero({
  id,
  title,
  body,
  art,
  children,
}: {
  id: string;
  title: string;
  body: string;
  art?: ArtName;
  children: ReactNode;
}) {
  return (
    <section className="nzc-hero" aria-labelledby={id} data-art={art}>
      <div className="nzc-hero-main">
        <div className="nzc-hero-text">
          <h2 id={id}>{title}</h2>
          <p>{body}</p>
        </div>
        <div className="nzc-hero-actions">{children}</div>
      </div>
      {art && <Art name={art} className="nzc-hero-art" />}
    </section>
  );
}
