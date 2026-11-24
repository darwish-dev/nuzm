import type { ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { pick, site, type L, type ServiceContent } from '../../lib/site-content';

/**
 * The AI builder service pages (`/services/*-ai-builder`): a centred hero on the brand's mint-and-slate light, an orbit of the project's technologies around the
 * Nuzm mark, value cards that each carry a small sketch of the product, and one large product preview. Every sketch is decorative (`aria-hidden`): the
 * headings and paragraphs carry the meaning. Logical properties only (see builder-service.css), so Arabic and English share the layout.
 */
type Kind = 'flutter' | 'nextjs' | 'fullstack';
const l = (en: string, ar: string): L => ({ en, ar });

export const isBuilderPage = (slug: string) => slug.endsWith('-ai-builder');
const kindOf = (slug: string): Kind =>
  slug.startsWith('flutter') ? 'flutter' : slug.startsWith('nextjs') ? 'nextjs' : 'fullstack';

const TECH: Record<Kind, { id: string; name: string }[]> = {
  flutter: [{ id: 'flutter', name: 'Flutter' }],
  nextjs: [
    { id: 'nextjs', name: 'Next.js' },
    { id: 'react', name: 'React' },
  ],
  fullstack: [
    { id: 'react', name: 'React' },
    { id: 'nestjs', name: 'NestJS' },
  ],
};

const COPY = {
  badge: l('Nuzm AI builder', 'منشئ نظم بالذكاء الاصطناعي'),
  stack: l('Project technologies', 'تقنيات المشروع'),
  orbit: l('Built on the technologies teams trust', 'مبني على تقنيات تثق بها الفرق'),
  valuesTitle: l('From an idea to a product', 'من فكرة إلى منتج'),
  valuesSub: l(
    'Describe it, shape it with AI, and review every change before you publish.',
    'صِفها وشكّلها مع الذكاء الاصطناعي، وراجع كل تعديل قبل النشر.',
  ),
  showcase: l('One workspace for the whole project', 'مساحة عمل واحدة لمشروعك كاملًا'),
  showcaseSub: l(
    'Conversation, preview and code side by side, in Arabic and English.',
    'المحادثة والمعاينة والكود جنبًا إلى جنب، بالعربية والإنجليزية.',
  ),
  prompt: l('Ask Nuzm AI…', 'اطلب من نظم…'),
  stepsTitle: l('Three steps to your first version', 'ثلاث خطوات إلى نسختك الأولى'),
  endTitle: l('Ready to start building?', 'جاهز لتبدأ البناء؟'),
};

/** The capabilities named in the orbit's moving row: each is part of the builder workspace. */
const CAPS: { icon: IconName; text: L }[] = [
  { icon: 'sparkle', text: l('AI conversation', 'محادثة بالذكاء الاصطناعي') },
  { icon: 'globe', text: l('Arabic and English', 'عربي وإنجليزي') },
  { icon: 'code', text: l('Editable code', 'كود قابل للتعديل') },
  { icon: 'check', text: l('Preview before publishing', 'معاينة قبل النشر') },
];

export function BuilderHero({ locale, s }: { locale: Locale; s: ServiceContent }) {
  const kind = kindOf(s.slug);
  return (
    <div className="bsv-hero">
      <nav className="svc-crumbs" aria-label={site('services', locale)}>
        <a href={`/${locale}/services`}>{site('services', locale)}</a>
        <Icon name="chevron" size={11} />
        <span aria-current="page">{pick(s.name, locale)}</span>
      </nav>
      <span className="bsv-pill">
        <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={20} height={16} />
        {pick(COPY.badge, locale)}
      </span>
      <h1>{pick(s.headline, locale)}</h1>
      <p className="bsv-lead">{pick(s.intro, locale)}</p>
      <div className="bsv-actions">
        <a className="bsv-btn bsv-btn-main" href={`/${locale}${s.href}`}>
          {site('start', locale)}
          <Icon name="sparkle" size={15} />
        </a>
        <a className="bsv-btn bsv-btn-ghost" href={`/${locale}${s.href}`}>
          {site('openConsole', locale)}
          <Icon name="arrow" size={14} />
        </a>
      </div>
      <ul className="bsv-stack" aria-label={pick(COPY.stack, locale)}>
        {TECH[kind].map((t) => (
          <li key={t.id}>
            <img src={`/brand/technologies/${t.id}.svg`} alt="" width={18} height={18} />
            {t.name}
          </li>
        ))}
      </ul>
      {s.note && (
        <p className="bsv-note" role="note">
          <Icon name="pin" size={14} /> {pick(s.note, locale)}
        </p>
      )}
    </div>
  );
}

function Orbit({ locale, kind }: { locale: Locale; kind: Kind }) {
  const row = [
    ...TECH[kind].map((t) => ({ key: t.id, img: t.id, text: t.name })),
    ...CAPS.map((c, i) => ({ key: `c${i}`, icon: c.icon, text: pick(c.text, locale) })),
  ];
  return (
    <section className="bsv-orbit" aria-labelledby="bsv-orbit-h">
      <div className="bsv-rings" aria-hidden="true">
        <i />
        <i />
        <i />
        <span className="bsv-core">
          <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={46} height={36} />
        </span>
      </div>
      <h2 id="bsv-orbit-h">{pick(COPY.orbit, locale)}</h2>
      <div className="bsv-marquee">
        <ul>
          {[...row, ...row].map((x, i) => (
            <li key={`${x.key}-${i}`} aria-hidden={i >= row.length || undefined}>
              {'img' in x && x.img ? (
                <img src={`/brand/technologies/${x.img}.svg`} alt="" width={22} height={22} />
              ) : (
                <Icon name={(x as { icon: IconName }).icon} size={20} />
              )}
              {x.text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- decorative sketches ---------- */

function Win({ children, title }: { children: ReactNode; title?: boolean }) {
  return (
    <span className="bsv-win">
      <span className="bsv-win-bar">
        <i />
        <i />
        <i />
        {title && <b />}
      </span>
      {children}
    </span>
  );
}

const BARS = [38, 64, 30, 46, 58, 42, 84];

function Chart() {
  return (
    <span className="bsv-chart">
      {BARS.map((h, i) => (
        <i key={i} style={{ blockSize: `${h}%` }} data-hi={i === BARS.length - 1 || undefined} />
      ))}
    </span>
  );
}

function Rows({ n = 5 }: { n?: number }) {
  return (
    <span className="bsv-rows">
      {Array.from({ length: n }, (_, r) => (
        <span key={r} className="bsv-row">
          <i className="bsv-av" />
          <i className="bsv-ln" />
          <i className="bsv-dot" data-tone={r % 3} />
          <i className="bsv-ln bsv-sm" />
        </span>
      ))}
    </span>
  );
}

function Phone({ variant = 0 }: { variant?: number }) {
  return (
    <span className="bsv-phone" data-v={variant}>
      <i className="bsv-notch" />
      <i className="bsv-ph-hero" />
      <span className="bsv-ph-tiles">
        <i />
        <i />
      </span>
      <i className="bsv-ln" />
      <i className="bsv-ln bsv-sm" />
      <i className="bsv-ph-btn" />
    </span>
  );
}

function SiteSketch() {
  return (
    <span className="bsv-site">
      <span className="bsv-site-nav">
        <i />
        <b />
        <b />
        <b />
      </span>
      <i className="bsv-site-hero" />
      <span className="bsv-site-cols">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

function ChatSketch({ locale }: { locale: Locale }) {
  return (
    <span className="bsv-chat">
      <span className="bsv-bubble bsv-me">
        <i className="bsv-ln" />
        <i className="bsv-ln bsv-sm" />
      </span>
      <span className="bsv-bubble bsv-ai">
        <span className="bsv-ai-tag">
          <Icon name="sparkle" size={12} /> Nuzm AI
        </span>
        <i className="bsv-ln" />
        <i className="bsv-ln bsv-sm" />
        <span className="bsv-typing">
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="bsv-ask">
        {pick(COPY.prompt, locale)}
        <span className="bsv-send">
          <Icon name="arrow" size={12} />
        </span>
      </span>
    </span>
  );
}

function CodeSketch({ kind }: { kind: Kind }) {
  return (
    <span className="bsv-code" dir="ltr">
      <span className="bsv-code-tab">
        <img
          src={`/brand/technologies/${TECH[kind][0]?.id ?? kind}.svg`}
          alt=""
          width={14}
          height={14}
        />
        <b />
      </span>
      {[62, 80, 48, 70, 36, 56].map((w, i) => (
        <span key={i} className="bsv-code-ln" style={{ paddingInlineStart: `${(i % 3) * 12}px` }}>
          <i style={{ inlineSize: `${w * 0.35}%` }} data-t="k" />
          <i style={{ inlineSize: `${w * 0.5}%` }} data-t={i % 2 ? 's' : 'v'} />
        </span>
      ))}
    </span>
  );
}

function OutcomeSketch({ kind }: { kind: Kind }) {
  if (kind === 'flutter')
    return (
      <span className="bsv-phones">
        <Phone variant={1} />
        <Phone />
      </span>
    );
  if (kind === 'nextjs') return <SiteSketch />;
  return (
    <span className="bsv-panel">
      <span className="bsv-panel-head">
        <b />
        <i />
      </span>
      <Chart />
    </span>
  );
}

function ReviewSketch() {
  return (
    <span className="bsv-panel">
      <span className="bsv-panel-head">
        <b />
        <i />
      </span>
      <Rows n={4} />
    </span>
  );
}

function Sketch({ i, kind, locale }: { i: number; kind: Kind; locale: Locale }) {
  return (
    <span className="bsv-art" aria-hidden="true">
      <Win title={i !== 0}>
        {i === 0 ? (
          <ChatSketch locale={locale} />
        ) : i === 1 ? (
          <CodeSketch kind={kind} />
        ) : i === 2 ? (
          <OutcomeSketch kind={kind} />
        ) : (
          <ReviewSketch />
        )}
      </Win>
    </span>
  );
}

function Values({ locale, s, kind }: { locale: Locale; s: ServiceContent; kind: Kind }) {
  return (
    <section className="bsv-section" aria-labelledby="bsv-values-h">
      <header className="bsv-head">
        <span className="bsv-pill bsv-pill-soft">
          <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={18} height={14} />
          {site('whatYouGet', locale)}
        </span>
        <h2 id="bsv-values-h">{pick(COPY.valuesTitle, locale)}</h2>
        <p>{pick(COPY.valuesSub, locale)}</p>
      </header>
      <div className="bsv-values">
        {s.points.map((p, i) => (
          <article key={i} className="bsv-value">
            <Sketch i={i} kind={kind} locale={locale} />
            <h3>{pick(p.title, locale)}</h3>
            <p>{pick(p.text, locale)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Showcase({ locale, kind }: { locale: Locale; kind: Kind }) {
  return (
    <section className="bsv-section" aria-labelledby="bsv-show-h">
      <header className="bsv-head">
        <h2 id="bsv-show-h">{pick(COPY.showcase, locale)}</h2>
        <p>{pick(COPY.showcaseSub, locale)}</p>
      </header>
      <div className="bsv-show" aria-hidden="true">
        <span className="bsv-studio">
          <span className="bsv-studio-side">
            <span className="bsv-studio-brand">
              <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={22} height={17} />
              <b />
            </span>
            <i data-on="true" />
            <i />
            <i />
            <i />
            <span className="bsv-studio-chat">
              <ChatSketch locale={locale} />
            </span>
          </span>
          <span className="bsv-studio-main">
            <span className="bsv-studio-top">
              <b />
              <span className="bsv-search" />
              <span className="bsv-chip-row">
                {TECH[kind].map((t) => (
                  <img
                    key={t.id}
                    src={`/brand/technologies/${t.id}.svg`}
                    alt=""
                    width={16}
                    height={16}
                  />
                ))}
              </span>
            </span>
            {kind === 'flutter' ? (
              <span className="bsv-stage bsv-stage-phones">
                <Phone variant={1} />
                <Phone />
                <Phone variant={2} />
              </span>
            ) : kind === 'nextjs' ? (
              <span className="bsv-stage">
                <Win title>
                  <SiteSketch />
                </Win>
              </span>
            ) : (
              <span className="bsv-stage bsv-stage-dash">
                <span className="bsv-kpis">
                  {[0, 1, 2].map((k) => (
                    <span key={k} className="bsv-kpi" data-k={k}>
                      <i />
                      <b />
                    </span>
                  ))}
                </span>
                <span className="bsv-dash-grid">
                  <span className="bsv-panel">
                    <span className="bsv-panel-head">
                      <b />
                      <i />
                    </span>
                    <Chart />
                  </span>
                  <span className="bsv-panel">
                    <span className="bsv-panel-head">
                      <b />
                      <i />
                    </span>
                    <Rows n={5} />
                  </span>
                </span>
              </span>
            )}
          </span>
        </span>
      </div>
    </section>
  );
}

function Steps({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="bsv-section" aria-labelledby="bsv-steps-h">
      <header className="bsv-head">
        <span className="bsv-pill bsv-pill-soft">
          <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={18} height={14} />
          {site('howItWorks', locale)}
        </span>
        <h2 id="bsv-steps-h">{pick(COPY.stepsTitle, locale)}</h2>
      </header>
      <ol className="bsv-steps">
        {s.steps.map((st, i) => (
          <li key={i} className="bsv-step">
            <span className="bsv-step-no" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3>{pick(st.title, locale)}</h3>
            <p>{pick(st.text, locale)}</p>
          </li>
        ))}
      </ol>
      <p className="bsv-note bsv-note-center">
        <Icon name="tag" size={14} /> {site('priceNote', locale)}
      </p>
    </section>
  );
}

function Faq({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="bsv-section bsv-faq-wrap" aria-labelledby="bsv-faq-h">
      <header className="bsv-head">
        <span className="bsv-pill bsv-pill-soft">
          <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={18} height={14} />
          {site('faq', locale)}
        </span>
        <h2 id="bsv-faq-h">{site('faq', locale)}</h2>
      </header>
      <div className="bsv-faq">
        {s.faq.map((f, i) => (
          <details key={i}>
            <summary>
              {pick(f.q, locale)}
              <span className="bsv-faq-icon" aria-hidden="true">
                <Icon name="plus" size={16} />
              </span>
            </summary>
            <p>{pick(f.a, locale)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Closing({ locale, s }: { locale: Locale; s: ServiceContent }) {
  return (
    <section className="bsv-section" aria-labelledby="bsv-end-h">
      <div className="bsv-end">
        <span className="bsv-end-mark" aria-hidden="true">
          <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={40} height={31} />
        </span>
        <h2 id="bsv-end-h">{pick(COPY.endTitle, locale)}</h2>
        <p>{pick(s.intro, locale)}</p>
        <div className="bsv-actions">
          <a className="bsv-btn bsv-btn-main" href={`/${locale}${s.href}`}>
            {site('start', locale)}
            <Icon name="sparkle" size={15} />
          </a>
        </div>
      </div>
    </section>
  );
}

/** Everything below the hero on the builder pages: these replace the generic service sections (photography, plans, related list). */
export function BuilderSections({ locale, s }: { locale: Locale; s: ServiceContent }) {
  const kind = kindOf(s.slug);
  return (
    <>
      <Orbit locale={locale} kind={kind} />
      <Values locale={locale} s={s} kind={kind} />
      <Showcase locale={locale} kind={kind} />
      <Steps locale={locale} s={s} />
      <Faq locale={locale} s={s} />
      <Closing locale={locale} s={s} />
    </>
  );
}
