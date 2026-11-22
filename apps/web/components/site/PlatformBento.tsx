'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { SharedServiceArt } from './SharedServiceArt';
import { SERVICES, pick, serviceBySlug, site } from '../../lib/site-content';

/**
 * The platform bento: every Nuzm service as one card of a bento grid, each a link to its page. The pictures are drawn in markup (no raster images, so they follow
 * the light and dark appearance by themselves) and carry no figures: nothing in them is telemetry or a price. Plain markup with no client code, so the landing page
 * (a client component) and the server pages can both use it. The pictures are decorative; the card's title is the link's name.
 */
export function PlatformBento({
  locale,
  prefix,
  title,
}: {
  locale: Locale;
  /** the address prefix of the pages it links to (the landing page is English-only and passes ''); defaults to `/<locale>` */
  prefix?: string;
  title: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const slide = (direction: number) => {
    const el = rail.current;
    if (!el) return;
    const cards = Array.from(el.children) as HTMLElement[];
    const next = Math.max(0, Math.min(cards.length - 1, active + direction));
    const target = cards[next];
    if (target)
      el.scrollTo({
        left: target.offsetLeft - (cards[0]?.offsetLeft ?? 0),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
  };
  const base = prefix ?? `/${locale}`;
  const card = (slug: string, cls: string, art: ReactNode) => {
    const s = serviceBySlug(slug)!;
    return (
      <a className={`bn-card ${cls}`} href={`${base}/services/${slug}`}>
        <span className="bn-head">
          <span className="bn-icon">
            <Icon
              name={slug === 'data' ? 'hosting' : slug === 'automation' ? 'refresh' : s.icon}
              size={22}
            />
          </span>
          <span className="bn-go" aria-hidden="true">
            <Icon name="arrow" size={16} />
          </span>
        </span>
        <span className="bn-title">{pick(s.name, locale)}</span>
        <span className="bn-text">{pick(s.tagline, locale)}</span>
        <span className="bn-art" aria-hidden="true">
          {art}
        </span>
      </a>
    );
  };
  return (
    <div className="bn-carousel" role="region" aria-roledescription="carousel" aria-label={title}>
      <div className="bn-carousel-controls">
        <span>
          {locale === 'ar' ? 'اكتشف خدمات نظم' : 'Explore your possibilities'}{' '}
          <b aria-live="polite">{String(active + 1).padStart(2, '0')} / 09</b>
        </span>
        <div>
          <button
            type="button"
            aria-label="Previous service"
            disabled={active === 0}
            onClick={() => slide(-1)}
          >
            <Icon name="chevron" size={18} />
          </button>
          <button
            type="button"
            aria-label="Next service"
            disabled={active >= 8 || atEnd}
            onClick={() => slide(1)}
          >
            <Icon name="chevron" size={18} />
          </button>
        </div>
      </div>
      <div
        className="bn"
        ref={rail}
        dir="ltr"
        onScroll={() => {
          const el = rail.current;
          if (!el) return;
          const cards = Array.from(el.children) as HTMLElement[];
          const first = cards[0]?.offsetLeft ?? 0;
          let nearest = 0;
          cards.forEach((card, i) => {
            if (
              Math.abs(card.offsetLeft - first - el.scrollLeft) <
              Math.abs((cards[nearest]?.offsetLeft ?? first) - first - el.scrollLeft)
            )
              nearest = i;
          });
          setActive(nearest);
          setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 2);
        }}
        role="group"
        aria-label={title}
      >
        {card('hosting', 'bn-hosting', <SharedServiceArt slug="hosting" />)}
        {card('cloud', 'bn-cloud', <SharedServiceArt slug="cloud" />)}
        {card('domains', 'bn-domains', <SharedServiceArt slug="domains" />)}
        {card('ai-builder', 'bn-ai', <SharedServiceArt slug="ai-builder" />)}
        {card('email', 'bn-email', <SharedServiceArt slug="email" />)}
        {card('data', 'bn-data', <SharedServiceArt slug="data" />)}
        {card('automation', 'bn-flow', <SharedServiceArt slug="automation" />)}
        <a className="bn-card bn-api" href={`${base}/docs`}>
          <span className="bn-head">
            <span className="bn-icon">
              <Icon name="code" size={22} />
            </span>
            <span className="bn-go" aria-hidden="true">
              <Icon name="arrow" size={16} />
            </span>
          </span>
          <span className="bn-title">{site('bnApiTitle', locale)}</span>
          <span className="bn-text">{site('bnApiText', locale)}</span>
          <span className="bn-art" aria-hidden="true">
            <span className="bn-code" dir="ltr">
              <code>
                <span className="n">1</span>
                <span className="k">curl</span>{' '}
                <span className="s">&quot;$NUZM_API/v1/projects&quot;</span>
                <br />
                <span className="n">2</span>&nbsp;&nbsp;-H{' '}
                <span className="s">&quot;Authorization: Bearer $KEY&quot;</span>
              </code>
            </span>
          </span>
        </a>
        <div className="bn-banner">
          <div className="bn-banner-copy">
            <h3>{site('bnBanner', locale)}</h3>
            <p>{site('bnBannerText', locale)}</p>
            <a className="button button-white" href={`${base}/register`}>
              {site('start', locale)} <Icon name="sparkle" size={16} />
            </a>
          </div>
          <ul className="bn-services" aria-label={site('services', locale)}>
            {SERVICES.map((s) => (
              <li key={s.slug}>
                <a href={`${base}/services/${s.slug}`}>
                  <Icon name={s.icon as IconName} size={16} /> {pick(s.name, locale)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
