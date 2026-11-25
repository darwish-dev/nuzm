import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { pick, site, type L, type ServiceContent } from '../../lib/site-content';
import { relatedOf } from './SiteSections';
import { ServiceVisual } from './ServiceVisual';

/**
 * The infrastructure service pages (hosting, cloud, VPS, domains, email, data, automation…). A different language from the AI builder pages: a blueprint grid
 * instead of the centred light, a split hero with the service's artwork in a framed stage, an asymmetric bento of what you get, a connected timeline, a
 * two-column FAQ and compact onward links. Sketches are decorative (`aria-hidden`). Styles: service-detail.css (logical properties only).
 */
const l = (en: string, ar: string): L => ({ en, ar });
const COPY = {
  included: l('Included', 'مشمول'),
  stepsTitle: l('Up and running in three steps', 'جاهز للعمل في ثلاث خطوات'),
  faqSub: l(
    'Short answers about how this service works in your Nuzm account.',
    'إجابات مختصرة عن طريقة عمل هذه الخدمة في حسابك على نظم.',
  ),
  endTitle: l('Everything in one account', 'كل خدماتك في حساب واحد'),
  endText: l(
    'Hosting, servers, domains, email and AI tools, with one balance and one dashboard.',
    'الاستضافة والخوادم والنطاقات والبريد وأدوات الذكاء الاصطناعي، برصيد واحد ولوحة تحكم واحدة.',
  ),
};

export function ServiceDetailHero({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <div className="svx-hero">
      <div className="svx-copy">
        <nav className="svc-crumbs" aria-label={site('services', locale)}>
          <a href={`/${locale}/services`}>{site('services', locale)}</a>
          <Icon name="chevron" size={11} />
          <span aria-current="page">{pick(s.name, locale)}</span>
        </nav>
        <span className="svx-pill">
          <span className="svx-pill-icon">
            <Icon name={s.icon} size={14} />
          </span>
          {pick(s.name, locale)}
        </span>
        <h1>{pick(s.headline, locale)}</h1>
        <p className="svx-lead">{pick(s.intro, locale)}</p>
        <div className="svx-actions">
          <a className="svx-btn svx-btn-main" href={`/${locale}/register`}>
            {site('start', locale)}
            <Icon name="sparkle" size={15} />
          </a>
          <a className="svx-btn svx-btn-ghost" href={`/${locale}${s.href}`}>
            {site('openConsole', locale)}
            <Icon name="arrow" size={14} />
          </a>
        </div>
        <ul className="svx-ticks" aria-label={pick(COPY.included, locale)}>
          {s.points.slice(0, 3).map((p, i) => (
            <li key={i}>
              <Icon name="check" size={13} />
              {pick(p.title, locale)}
            </li>
          ))}
        </ul>
      </div>
      <div className="svx-stage" aria-hidden="true">
        <span className="svx-stage-grid" />
        <div className="svx-frame">
          <ServiceVisual slug={s.slug} />
        </div>
        <span className="svx-float svx-float-a">
          <span className="svx-float-icon">
            <Icon name={s.icon} size={15} />
          </span>
          <span className="svx-float-text">
            <b>{pick(s.name, locale)}</b>
            <small>{pick(s.tagline, locale)}</small>
          </span>
        </span>
        <span className="svx-float svx-float-b">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

/** A small "resources" console: rows with a status light and a usage bar. */
function ConsoleSketch() {
  return (
    <span className="svx-console" aria-hidden="true">
      <span className="svx-console-bar">
        <i />
        <i />
        <i />
      </span>
      {[72, 46, 88, 30].map((w, r) => (
        <span key={r} className="svx-console-row">
          <i className="svx-led" data-tone={r === 2 ? 'warm' : undefined} />
          <i className="svx-ln" />
          <span className="svx-meter">
            <i style={{ inlineSize: `${w}%` }} />
          </span>
        </span>
      ))}
    </span>
  );
}

/** The service's icon at the centre of nested squares, over a small usage line. */
function BadgeSketch({ s }: { s: ServiceContent }) {
  return (
    <span className="svx-badge" aria-hidden="true">
      <span className="svx-squares">
        <i />
        <i />
        <span className="svx-squares-core">
          <Icon name={s.icon} size={30} />
        </span>
      </span>
      <svg className="svx-spark" viewBox="0 0 200 50" preserveAspectRatio="none">
        <path d="M0 40 L25 34 L50 37 L75 24 L100 28 L125 16 L150 20 L175 8 L200 12" />
        <path d="M0 40 L25 34 L50 37 L75 24 L100 28 L125 16 L150 20 L175 8 L200 12 L200 50 L0 50 Z" />
      </svg>
    </span>
  );
}

function Features({ locale, s }: { locale: Locale; s: ServiceContent }) {
  const [a, b, ...rest] = s.points;
  return (
    <section className="svx-section" aria-labelledby="svx-feat-h">
      <header className="svx-head">
        <span className="svx-eyebrow">{site('whatYouGet', locale)}</span>
        <h2 id="svx-feat-h">{pick(s.tagline, locale)}</h2>
      </header>
      <div className="svx-bento">
        {a && (
          <article className="svx-tile svx-tile-wide">
            <div className="svx-tile-copy">
              <span className="svx-tile-icon">
                <Icon name={a.icon} size={20} />
              </span>
              <h3>{pick(a.title, locale)}</h3>
              <p>{pick(a.text, locale)}</p>
            </div>
            <ConsoleSketch />
          </article>
        )}
        {b && (
          <article className="svx-tile svx-tile-tall">
            <BadgeSketch s={s} />
            <span className="svx-tile-icon">
              <Icon name={b.icon} size={20} />
            </span>
            <h3>{pick(b.title, locale)}</h3>
            <p>{pick(b.text, locale)}</p>
          </article>
        )}
        {rest.map((p, i) => (
          <article key={i} className="svx-tile" data-tone={i % 2 ? 'warm' : undefined}>
            <span className="svx-tile-no" aria-hidden="true">
              {String(i + 3).padStart(2, '0')}
            </span>
            <span className="svx-tile-icon">
              <Icon name={p.icon} size={20} />
            </span>
            <h3>{pick(p.title, locale)}</h3>
            <p>{pick(p.text, locale)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Timeline({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="svx-section" aria-labelledby="svx-steps-h">
      <header className="svx-head">
        <span className="svx-eyebrow">{site('howItWorks', locale)}</span>
        <h2 id="svx-steps-h">{pick(COPY.stepsTitle, locale)}</h2>
      </header>
      <ol className="svx-timeline">
        {s.steps.map((st, i) => (
          <li key={i}>
            <span className="svx-node" aria-hidden="true">
              {i + 1}
            </span>
            <h3>{pick(st.title, locale)}</h3>
            <p>{pick(st.text, locale)}</p>
          </li>
        ))}
      </ol>
      <p className="svx-note">
        <Icon name="tag" size={14} /> {site('priceNote', locale)}
      </p>
      {s.note && (
        <p className="svx-note">
          <Icon name="pin" size={14} /> {pick(s.note, locale)}
        </p>
      )}
    </section>
  );
}

function Faq({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="svx-section svx-faq-layout" aria-labelledby="svx-faq-h">
      <header className="svx-faq-head">
        <span className="svx-eyebrow">{site('faq', locale)}</span>
        <h2 id="svx-faq-h">{site('faq', locale)}</h2>
        <p>{pick(COPY.faqSub, locale)}</p>
      </header>
      <div className="svx-faq">
        {s.faq.map((f, i) => (
          <details key={i} open={i === 0}>
            <summary>
              <span>{pick(f.q, locale)}</span>
              <span className="svx-faq-icon" aria-hidden="true">
                <Icon name="plus" size={15} />
              </span>
            </summary>
            <p>{pick(f.a, locale)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Onward({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="svx-section" aria-labelledby="svx-rel-h">
      <header className="svx-head svx-head-row">
        <div>
          <span className="svx-eyebrow">{site('services', locale)}</span>
          <h2 id="svx-rel-h">{site('related', locale)}</h2>
        </div>
        <a className="svx-all" href={`/${locale}/services`}>
          {site('allServices', locale)}
          <Icon name="arrow" size={14} />
        </a>
      </header>
      <div className="svx-related">
        {relatedOf(s.slug).map((x) => (
          <a key={x.slug} className="svx-rel" href={`/${locale}/services/${x.slug}`}>
            <span className="svx-tile-icon">
              <Icon name={x.icon} size={20} />
            </span>
            <span className="svx-rel-text">
              <b>{pick(x.name, locale)}</b>
              <small>{pick(x.tagline, locale)}</small>
            </span>
            <span className="svx-rel-go" aria-hidden="true">
              <Icon name="arrow" size={14} />
            </span>
          </a>
        ))}
      </div>
      <div className="svx-end">
        <div>
          <h2>{pick(COPY.endTitle, locale)}</h2>
          <p>{pick(COPY.endText, locale)}</p>
        </div>
        <a className="svx-btn svx-btn-main" href={`/${locale}/register`}>
          {site('start', locale)}
          <Icon name="sparkle" size={15} />
        </a>
      </div>
    </section>
  );
}

export function ServiceFeatures({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return <Features locale={locale} s={s} />;
}
export function ServiceClosing({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <>
      <Timeline locale={locale} s={s} />
      <Faq locale={locale} s={s} />
      <Onward locale={locale} s={s} />
    </>
  );
}
