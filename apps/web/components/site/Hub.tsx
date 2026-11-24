import type { ReactNode } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import {
  CHANNELS,
  COMMUNITY_VALUES,
  COURSES,
  HUB,
  LEVELS,
  POSTS,
  POST_CATEGORIES,
  type Course,
  type Post,
  type PostCategory,
} from '../../lib/hub-content';
import { pick, serviceBySlug, site } from '../../lib/site-content';

/**
 * Blog, Academy and Community (public pages). One family: a centred hero on a soft dotted field with the section's own accent, then editorial cards. Covers
 * are decorative compositions of the item's icon (no stock photos). Styles: hub.css. Logical properties only.
 */
type Section = 'blog' | 'academy' | 'community';

export function HubHero({
  locale,
  section,
  title,
  intro,
  crumb,
  children,
}: {
  locale: Locale;
  section: Section;
  title: string;
  intro: string;
  /** the parent page (on an article or a course) */
  crumb?: { href: string; label: string };
  children?: ReactNode;
}) {
  const icon: IconName =
    section === 'blog' ? 'list' : section === 'academy' ? 'sparkle' : 'organization';
  return (
    <div className="hub-hero" data-section={section}>
      {crumb && (
        <a className="hub-back" href={crumb.href}>
          <Icon name="arrow" size={14} />
          {crumb.label}
        </a>
      )}
      <span className="hub-pill">
        <span className="hub-pill-icon">
          <Icon name={icon} size={13} />
        </span>
        {pick(HUB[section], locale)}
      </span>
      <h1>{title}</h1>
      <p className="hub-lead">{intro}</p>
      {children}
    </div>
  );
}

export function Cover({ icon, tone, big }: { icon: IconName; tone: number; big?: boolean }) {
  return (
    <span className="hub-cover" data-tone={tone % 3} data-big={big || undefined} aria-hidden="true">
      <i />
      <i />
      <i />
      <span className="hub-cover-icon">
        <Icon name={icon} size={big ? 34 : 24} />
      </span>
    </span>
  );
}

const catName = (id: PostCategory, locale: Locale) =>
  pick(POST_CATEGORIES.find((c) => c.id === id)!.name, locale);

function PostMeta({ p, locale }: { p: Post; locale: Locale }) {
  return (
    <span className="hub-meta">
      <span className="hub-tag">{catName(p.category, locale)}</span>
      <span>
        {p.minutes} {pick(HUB.minutes, locale)}
      </span>
    </span>
  );
}

function PostCard({ p, locale, i }: { p: Post; locale: Locale; i: number }) {
  return (
    <a className="hub-card" href={`/${locale}/blog/${p.slug}`}>
      <Cover icon={p.icon} tone={i} />
      <span className="hub-card-body">
        <PostMeta p={p} locale={locale} />
        <b>{pick(p.title, locale)}</b>
        <small>{pick(p.excerpt, locale)}</small>
        <span className="hub-more">
          {pick(HUB.read, locale)}
          <Icon name="arrow" size={14} />
        </span>
      </span>
    </a>
  );
}

export function BlogIndex({ locale, category }: { locale: Locale; category?: PostCategory }) {
  const list = category ? POSTS.filter((p) => p.category === category) : POSTS;
  const [first, ...rest] = list;
  return (
    <section className="hub-section" aria-label={pick(HUB.blog, locale)}>
      <nav className="hub-filters" aria-label={pick(HUB.blog, locale)}>
        <a href={`/${locale}/blog`} aria-current={!category ? 'page' : undefined}>
          {pick(HUB.all, locale)}
        </a>
        {POST_CATEGORIES.map((c) => (
          <a
            key={c.id}
            href={`/${locale}/blog?category=${c.id}`}
            aria-current={category === c.id ? 'page' : undefined}
          >
            {pick(c.name, locale)}
          </a>
        ))}
      </nav>
      {first && (
        <a className="hub-feature" href={`/${locale}/blog/${first.slug}`}>
          <Cover icon={first.icon} tone={0} big />
          <span className="hub-feature-body">
            <span className="hub-feature-flag">{pick(HUB.featured, locale)}</span>
            <PostMeta p={first} locale={locale} />
            <b>{pick(first.title, locale)}</b>
            <small>{pick(first.excerpt, locale)}</small>
            <span className="hub-more">
              {pick(HUB.read, locale)}
              <Icon name="arrow" size={14} />
            </span>
          </span>
        </a>
      )}
      <div className="hub-grid">
        {rest.map((p, i) => (
          <PostCard key={p.slug} p={p} locale={locale} i={i + 1} />
        ))}
      </div>
    </section>
  );
}

function ServiceCta({ locale, slug }: { locale: Locale; slug: string }) {
  const s = serviceBySlug(slug);
  if (!s) return null;
  return (
    <aside className="hub-cta">
      <span className="hub-cta-icon">
        <Icon name={s.icon} size={20} />
      </span>
      <span className="hub-cta-text">
        <b>{pick(s.name, locale)}</b>
        <small>{pick(s.tagline, locale)}</small>
      </span>
      <a className="hub-btn hub-btn-main" href={`/${locale}/services/${s.slug}`}>
        {pick(HUB.tryService, locale)}
        <Icon name="arrow" size={14} />
      </a>
    </aside>
  );
}

export function PostBody({ locale, p }: { locale: Locale; p: Post }) {
  const more = POSTS.filter((x) => x.slug !== p.slug).slice(0, 3);
  return (
    <>
      <article className="hub-article">
        <div className="hub-article-cover">
          <Cover icon={p.icon} tone={POSTS.indexOf(p)} big />
        </div>
        <div className="hub-byline">
          <span className="hub-avatar" aria-hidden="true">
            <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={20} height={16} />
          </span>
          <span>{pick(HUB.byTeam, locale)}</span>
          <PostMeta p={p} locale={locale} />
        </div>
        {p.sections.map((sec, i) => (
          <section key={i}>
            <h2>{pick(sec.h, locale)}</h2>
            <p>{pick(sec.p, locale)}</p>
          </section>
        ))}
        <ServiceCta locale={locale} slug={p.service} />
      </article>
      <section className="hub-section" aria-labelledby="hub-more-h">
        <h2 className="hub-h2" id="hub-more-h">
          {pick(HUB.moreArticles, locale)}
        </h2>
        <div className="hub-grid">
          {more.map((x, i) => (
            <PostCard key={x.slug} p={x} locale={locale} i={i} />
          ))}
        </div>
      </section>
    </>
  );
}

function CourseCard({ c, locale, i }: { c: Course; locale: Locale; i: number }) {
  return (
    <a className="hub-course" href={`/${locale}/academy/${c.slug}`} data-tone={i % 3}>
      <span className="hub-course-top">
        <span className="hub-course-icon">
          <Icon name={c.icon} size={22} />
        </span>
        <span className="hub-badges">
          <span className="hub-tag">{pick(LEVELS[c.level], locale)}</span>
          <span className="hub-tag hub-tag-free">{pick(HUB.free, locale)}</span>
        </span>
      </span>
      <b>{pick(c.title, locale)}</b>
      <small>{pick(c.summary, locale)}</small>
      <span className="hub-progress" aria-hidden="true">
        {c.lessons.map((_, k) => (
          <i key={k} />
        ))}
      </span>
      <span className="hub-course-foot">
        <span>
          {c.lessons.length} {pick(HUB.lessons, locale)}
        </span>
        <span className="hub-more">
          {pick(HUB.startCourse, locale)}
          <Icon name="arrow" size={14} />
        </span>
      </span>
    </a>
  );
}

export function AcademyIndex({ locale }: { locale: Locale }) {
  return (
    <section className="hub-section" aria-labelledby="hub-paths-h">
      <h2 className="hub-h2" id="hub-paths-h">
        {pick(HUB.paths, locale)}
      </h2>
      <div className="hub-courses">
        {COURSES.map((c, i) => (
          <CourseCard key={c.slug} c={c} locale={locale} i={i} />
        ))}
      </div>
    </section>
  );
}

export function CourseBody({ locale, c }: { locale: Locale; c: Course }) {
  const s = serviceBySlug(c.service);
  return (
    <>
      <section className="hub-section hub-course-layout" aria-labelledby="hub-plan-h">
        <div>
          <h2 className="hub-h2" id="hub-plan-h">
            {pick(HUB.lessonPlan, locale)}
          </h2>
          <ol className="hub-lessons">
            {c.lessons.map((ls, i) => (
              <li key={i}>
                <span className="hub-lesson-no" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span>
                  <b>{pick(ls.title, locale)}</b>
                  <small>{pick(ls.text, locale)}</small>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <aside className="hub-side">
          <span className="hub-course-icon">
            <Icon name={c.icon} size={24} />
          </span>
          <span className="hub-badges">
            <span className="hub-tag">{pick(LEVELS[c.level], locale)}</span>
            <span className="hub-tag hub-tag-free">{pick(HUB.free, locale)}</span>
            <span className="hub-tag">
              {c.lessons.length} {pick(HUB.lessons, locale)}
            </span>
          </span>
          <p className="hub-side-label">{pick(HUB.outcome, locale)}</p>
          <p className="hub-side-outcome">{pick(c.outcome, locale)}</p>
          {s && (
            <a className="hub-btn hub-btn-main" href={`/${locale}${s.href}`}>
              {pick(HUB.practise, locale)}
              <Icon name="sparkle" size={14} />
            </a>
          )}
          {s && (
            <a className="hub-btn hub-btn-ghost" href={`/${locale}/services/${s.slug}`}>
              {pick(s.name, locale)}
              <Icon name="arrow" size={14} />
            </a>
          )}
        </aside>
      </section>
      <section className="hub-section" aria-labelledby="hub-next-h">
        <h2 className="hub-h2" id="hub-next-h">
          {pick(HUB.learnMore, locale)}
        </h2>
        <div className="hub-courses">
          {COURSES.filter((x) => x.slug !== c.slug)
            .slice(0, 3)
            .map((x, i) => (
              <CourseCard key={x.slug} c={x} locale={locale} i={i} />
            ))}
        </div>
      </section>
    </>
  );
}

export function CommunityBody({ locale }: { locale: Locale }) {
  return (
    <>
      <section className="hub-section" aria-labelledby="hub-ch-h">
        <h2 className="hub-h2" id="hub-ch-h">
          {pick(HUB.channels, locale)}
        </h2>
        <div className="hub-channels">
          {CHANNELS.map((ch, i) => (
            <article
              key={ch.id}
              className="hub-channel"
              data-open={ch.href ? 'true' : 'false'}
              data-tone={i % 3}
            >
              <span className="hub-course-icon">
                <Icon name={ch.icon} size={22} />
              </span>
              <b>{pick(ch.title, locale)}</b>
              <small>{pick(ch.text, locale)}</small>
              {ch.href && ch.action ? (
                <a className="hub-btn hub-btn-ghost" href={`/${locale}${ch.href}`}>
                  {pick(ch.action, locale)}
                  <Icon name="arrow" size={14} />
                </a>
              ) : (
                <span className="hub-soon">{pick(HUB.soon, locale)}</span>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="hub-section" aria-labelledby="hub-val-h">
        <h2 className="hub-h2" id="hub-val-h">
          {pick(HUB.values, locale)}
        </h2>
        <div className="hub-values">
          {COMMUNITY_VALUES.map((v, i) => (
            <article key={i}>
              <span className="hub-value-icon">
                <Icon name={v.icon} size={20} />
              </span>
              <b>{pick(v.title, locale)}</b>
              <small>{pick(v.text, locale)}</small>
            </article>
          ))}
        </div>
      </section>
      <section className="hub-section" aria-labelledby="hub-learn-h">
        <div className="hub-band">
          <div>
            <h2 id="hub-learn-h">{pick(HUB.learnMore, locale)}</h2>
            <p>{pick(HUB.academyIntro, locale)}</p>
          </div>
          <div className="hub-band-actions">
            <a className="hub-btn hub-btn-main" href={`/${locale}/academy`}>
              {pick(HUB.academy, locale)}
              <Icon name="sparkle" size={14} />
            </a>
            <a className="hub-btn hub-btn-ghost" href={`/${locale}/blog`}>
              {pick(HUB.blog, locale)}
              <Icon name="arrow" size={14} />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

/** "Start now" under a hub hero. */
export function HubStart({ locale }: { locale: Locale }) {
  return (
    <div className="hub-actions">
      <a className="hub-btn hub-btn-main" href={`/${locale}/register`}>
        {site('start', locale)}
        <Icon name="sparkle" size={14} />
      </a>
      <a className="hub-btn hub-btn-ghost" href={`/${locale}/docs`}>
        {locale === 'ar' ? 'التوثيق' : 'Documentation'}
        <Icon name="arrow" size={14} />
      </a>
    </div>
  );
}
