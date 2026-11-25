import { ServicePhotography } from './ServicePhotography';
import { ServiceVisual } from './ServiceVisual';
import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { SERVICES, pick, site, type ServiceContent } from '../../lib/site-content';

/** The hero of a service page: the eyebrow, headline and intro on one side, the service's artwork (or an icon panel with its three steps) on the other. */
export function ServiceHero({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <div className="svc-hero-grid">
      <div className="svc-hero-copy">
        <nav className="svc-crumbs" aria-label={site('services', locale)}>
          <a href={`/${locale}/services`}>{site('services', locale)}</a>
          <Icon name="chevron" size={11} />
          <span aria-current="page">{pick(s.name, locale)}</span>
        </nav>
        <h1>{pick(s.headline, locale)}</h1>
        <p className="svc-lead">{pick(s.intro, locale)}</p>
        {s.slug.endsWith('-ai-builder') && (
          <div
            className="svc-builder-stack"
            aria-label={locale === 'ar' ? 'تقنيات المشروع' : 'Project technologies'}
          >
            {(s.slug === 'flutter-ai-builder'
              ? ['flutter']
              : s.slug === 'nextjs-ai-builder'
                ? ['nextjs', 'react']
                : ['react', 'nestjs']
            ).map((tech) => (
              <span key={tech}>
                <img src={`/brand/technologies/${tech}.svg`} alt="" width={22} height={22} />
                {
                  { flutter: 'Flutter', nextjs: 'Next.js', react: 'React', nestjs: 'NestJS' }[
                    tech as 'flutter' | 'nextjs' | 'react' | 'nestjs'
                  ]
                }
              </span>
            ))}
          </div>
        )}
        <div className="svc-actions">
          <a
            className="button button-white"
            href={`/${locale}${s.slug.endsWith('-ai-builder') ? s.href : '/register'}`}
          >
            {site('start', locale)} <Icon name="sparkle" size={15} />
          </a>
          <a className="button button-outline svc-ghost" href={`/${locale}${s.href}`}>
            {site('openConsole', locale)}
            <Icon name="arrow" size={14} />
          </a>
        </div>
        {s.note && (
          <p className="svc-note" role="note">
            <Icon name="pin" size={15} /> {pick(s.note, locale)}
          </p>
        )}
      </div>
      <div className="svc-visual">
        <ServiceVisual slug={s.slug} />
      </div>
    </div>
  );
}

export function PointsSection({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="section wrap svc-section svc-benefits-section" aria-labelledby="svc-points">
      <div className="svc-head">
        <span className="eyebrow">{site('whatYouGet', locale)}</span>
        <h2 id="svc-points">{pick(s.tagline, locale)}</h2>
      </div>
      <div className="svc-benefits-layout">
        <ServicePhotography locale={locale} s={s} />
        <div className="svc-points">
          {s.points.map((p, i) => (
            <article key={i} className="svc-card">
              <span className="svc-card-icon">
                <Icon name={p.icon} size={20} />
              </span>
              <h3>{pick(p.title, locale)}</h3>
              <p>{pick(p.text, locale)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function StepsSection({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="section wrap svc-section svc-process-section" aria-labelledby="svc-steps">
      <div className="svc-head">
        <span className="eyebrow">{site('howItWorks', locale)}</span>
        <h2 id="svc-steps">{site('howItWorks', locale)}</h2>
      </div>
      <div className="svc-process-layout">
        <div>
          <ol className="svc-steps">
            {s.steps.map((st, i) => (
              <li key={i} className="svc-card">
                <span className="svc-step-no">{i + 1}</span>
                <h3>{pick(st.title, locale)}</h3>
                <p>{pick(st.text, locale)}</p>
              </li>
            ))}
          </ol>
          <p className="svc-price-note">
            <Icon name="tag" size={15} /> {site('priceNote', locale)}
          </p>
        </div>
        <ServicePhotography locale={locale} s={s} steps />
      </div>
    </section>
  );
}

export function FaqSection({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="section wrap svc-section svc-faq-section" aria-labelledby="svc-faq">
      <div className="svc-head">
        <span className="eyebrow">{site('faq', locale)}</span>
        <h2 id="svc-faq">{site('faq', locale)}</h2>
      </div>
      <div className="svc-faq">
        {s.faq.map((f, i) => (
          <details key={i}>
            <summary>
              {pick(f.q, locale)}
              <Icon name="plus" size={16} />
            </summary>
            <p>{pick(f.a, locale)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** A card that opens one service page: used by the index and by the "more from Nuzm" row. */
export function ServiceCard({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <a className="svc-card svc-link-card" href={`/${locale}/services/${s.slug}`}>
      <div className="svc-card-art">
        <ServiceVisual slug={s.slug} />
      </div>
      <h3>{pick(s.name, locale)}</h3>
      <p>{pick(s.tagline, locale)}</p>
      <span className="svc-more">
        {site('explore', locale)} <Icon name="arrow" size={14} />
      </span>
    </a>
  );
}

/** The three services that follow this one in the list (wrapping round), so every page links onward and each service is linked from three others. */
export function relatedOf(current: string): ServiceContent[] {
  const i = SERVICES.findIndex((x) => x.slug === current);
  return [1, 2, 3].map((n) => SERVICES[(i + n) % SERVICES.length]!);
}

export function RelatedSection({ locale, current }: { locale: Locale; current: string }) {
  return (
    <section className="section wrap svc-section" aria-labelledby="svc-related">
      <div className="svc-head">
        <span className="eyebrow">{site('services', locale)}</span>
        <h2 id="svc-related">{site('related', locale)}</h2>
      </div>
      <div className="svc-grid">
        {relatedOf(current).map((x) => (
          <ServiceCard key={x.slug} locale={locale} s={x} />
        ))}
      </div>
    </section>
  );
}
