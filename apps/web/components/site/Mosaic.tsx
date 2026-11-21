import type { Locale } from '@nuzm/i18n';
import { MOSAIC, illustration, pick } from '../../lib/site-content';

/**
 * The illustration mosaic: the owner's illustration sheet as a bento grid, each tile a link to the page it is about, with its name on a small label.
 * Plain markup with no client code, so the landing page (a client component) and the server pages can both use it. The images are decorative (the label is the
 * link's name).
 */
export function Mosaic({
  locale,
  prefix,
  title,
  homeHref = '/',
}: {
  locale: Locale;
  prefix?: string;
  title: string;
  /** where the tile with no page of its own leads (the landing page points it at its AI section) */
  homeHref?: string;
}) {
  const base = prefix ?? `/${locale}`;
  return (
    <ul className="mz" aria-label={title}>
      {MOSAIC.map((t, i) => (
        <li key={t.image} className="mz-item" data-pos={i + 1}>
          <a className="mz-tile" href={t.href === '' ? homeHref : `${base}${t.href}`}>
            <img
              src={illustration(t.image)}
              alt=""
              width={380}
              height={290}
              loading={i < 3 ? 'eager' : 'lazy'}
            />
            <span className="mz-label">{pick(t.label, locale)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
