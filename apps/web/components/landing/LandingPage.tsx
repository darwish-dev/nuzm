'use client';

import { useRef, useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import { SiteHeader } from '../site/SiteHeader';
import type { Locale } from '@nuzm/i18n';
import { SERVICES, pick, site } from '../../lib/site-content';
import { doc } from '../../lib/docs-content';
import { landingText } from '../../lib/landing-text';
import { PlatformBento } from '../site/PlatformBento';
import { FloatingDock } from '../site/FloatingDock';
import { SiteFooter } from '../site/SiteFooter';
import { AiBuildShowcase } from './AiBuildShowcase';
import { AiChatSection } from './AiChatSection';
import { DownloadSection, type DesktopOffer } from './DownloadSection';
import { TechStrip } from './TechStrip';
import { useSectionScroll } from './useSectionScroll';

// Native CSS with the owner’s attached Nuzm bento identity and logo.
// DESIGN_VARIANCE 7 / MOTION_INTENSITY 4 / VISUAL_DENSITY 4.
// Identity radii: 999px controls, 28px cards, 16px inset panels.
const WORKFLOW_ICONS: IconName[] = ['cloud', 'code', 'workflow'];

export function LandingPage({
  locale = 'en',
  desktop = {},
  initialMode = 'dark',
}: {
  locale?: Locale;
  /** the appearance the visitor chose before (the `nuzm_theme` cookie, read on the server) */
  initialMode?: 'dark' | 'light';
  /** the desktop installers the site can offer (read on the server); a missing platform stays "Soon" */
  desktop?: DesktopOffer;
}) {
  const d = landingText(locale);
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const { prompts, workflows } = d;
  const scrollRoot = useRef<HTMLDivElement>(null);
  useSectionScroll(scrollRoot);
  const [prompt, setPrompt] = useState('');
  const [recommendation, setRecommendation] = useState<number | null>(null);
  const [dark, setDark] = useState(initialMode !== 'light');
  const demo = useRef<HTMLDialogElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const recommendationData = recommendation === null ? null : workflows[recommendation];

  function suggest(value: string) {
    setPrompt(value);
    const known = prompts.indexOf(value);
    setRecommendation(
      known >= 0
        ? known === 2
          ? 2
          : known
        : /automate|operations|request|approval|أتمت|عملي|طلب|موافق/i.test(value)
          ? 0
          : /website|build|code|app|موقع|ابن|برمج|تطبيق/i.test(value)
            ? 1
            : 2,
    );
    requestAnimationFrame(() =>
      result.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  }

  return (
    <div ref={scrollRoot} className="landing" data-mode={dark ? 'dark' : 'light'}>
      <a className="skip-link" href="#main">
        {d.skip}
      </a>
      <section className="hero" aria-labelledby="hero-title">
        <div className="sky" aria-hidden="true">
          <div className="horizon" />
        </div>
        <SiteHeader
          locale={locale}
          otherLocale={{
            code: other,
            label: site('language', locale),
            href: `/?lang=${other}`,
          }}
          services={SERVICES.map((s) => ({
            slug: s.slug,
            icon: s.icon,
            name: pick(s.name, locale),
            tagline: pick(s.tagline, locale),
          }))}
          labels={{
            home: site('home', locale),
            nav: site('nav', locale),
            services: site('services', locale),
            allServices: site('allServices', locale),
            login: site('login', locale),
            start: site('start', locale),
            menu: site('menu', locale),
            closeMenu: site('closeMenu', locale),
            developers: doc('developers', locale),
          }}
        />
        <main id="main" className="hero-content wrap">
          <a href="#agents" className="announcement">
            <span>{d.announceTag}</span> {d.announce} <Icon name="chevron" size={13} />
          </a>
          <h1 id="hero-title">
            {d.heroTitle1}
            <br />
            <em>{d.heroTitle2}</em>
          </h1>
          <p className="hero-sub">
            {d.heroSub1}
            <br />
            {d.heroSub2}
          </p>
          <form
            className="prompt-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) suggest(prompt.trim());
            }}
          >
            <label className="sr-only" htmlFor="agent-prompt">
              {d.promptLabel}
            </label>
            <input
              id="agent-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={d.promptPlaceholder}
              maxLength={500}
              required
            />
            <div className="prompt-toolbar">
              <span>
                <Icon name="sparkle" size={17} /> Nuzm AI <span className="prompt-divider">/</span>{' '}
                <span className="prompt-helper">{d.promptHelper}</span>
              </span>
              <button type="submit" aria-label={d.promptSend}>
                <Icon name="send" size={20} />
              </button>
            </div>
          </form>
          <div className="prompt-suggestions" aria-label={d.promptsLabel}>
            {prompts.map((p) => (
              <button key={p} onClick={() => suggest(p)}>
                {p}
                <Icon name="plus" size={12} />
              </button>
            ))}
          </div>
          {recommendationData && (
            <div className="prompt-result" ref={result} role="status">
              <div>
                <span className="eyebrow">{d.resultEyebrow}</span>
                <h2>{recommendationData.title}</h2>
                <p>{recommendationData.text}</p>
              </div>
              <a
                className="button button-blue"
                href={recommendation === 1 ? '/builder/projects' : '/automation/workflows/new'}
              >
                {recommendation === 1 ? d.openBuilder : d.openWorkflows}
              </a>
            </div>
          )}
        </main>
        <TechStrip label={d.techLabel} />
      </section>

      <AiBuildShowcase locale={locale} />

      <AiChatSection locale={locale} />

      <section
        id="platform"
        className="section wrap platform-section"
        aria-labelledby="platform-title"
      >
        <div className="section-heading">
          <h2 id="platform-title">
            {d.platformTitle1}
            <br />
            <em>{d.platformTitle2}</em>
          </h2>
          <p>{d.platformText}</p>
        </div>
        <PlatformBento locale={locale} prefix="" title={d.platformLabel} />
      </section>

      <section className="section integrations-section wrap bridge-section" id="integrations">
        <span className="eyebrow">{d.bridgeEyebrow}</span>
        <h2>
          {d.bridgeTitle1}
          <br />
          <em>{d.bridgeTitle2}</em>
        </h2>
        <p>{d.bridgeText}</p>
        <div className="bridge-map" aria-label={d.bridgeLabel}>
          <div className="bridge-source bridge-claude">
            <img src="/brand/claude.svg" alt="Claude" width={220} height={48} />
            <span>{d.claudeSub}</span>
          </div>
          <span className="bridge-link" aria-hidden="true">
            <i />
          </span>
          <div className="bridge-hub">
            <span>
              <img src="/brand/nuzm-mark.png?v=mint3" alt="Nuzm" width={54} height={43} />
            </span>
            <strong>Nuzm</strong>
            <small>{d.hubSub}</small>
          </div>
          <span className="bridge-link" aria-hidden="true">
            <i />
          </span>
          <div className="bridge-destinations">
            {(
              [
                { icon: 'globe', href: '/services/domains' },
                { icon: 'hosting', href: '/services/hosting' },
                { icon: 'mail', href: '/services/email' },
                { icon: 'organization', href: '/services/automation' },
                { icon: 'user', href: '/services/automation' },
                { icon: 'grid', href: '/services/ai-builder' },
              ] as { icon: IconName; href: string }[]
            ).map((item, i) => (
              <a
                href={item.href}
                key={item.href + i}
                className={`bridge-destination bridge-tone-${i % 3} bridge-service-${item.icon}`}
              >
                <span>
                  <Icon name={item.icon} size={28} />
                  <i aria-hidden="true" />
                </span>
                <strong>{d.destinations[i]}</strong>
              </a>
            ))}
          </div>
        </div>
        <a href="/services" className="text-button">
          {d.explore} <Icon name="plus" size={16} />
        </a>
      </section>

      <DownloadSection locale={locale} desktop={desktop} />

      <SiteFooter
        locale={locale}
        home
        langHref={`/?lang=${other}`}
        dark={dark}
        onToggleTheme={() => setDark(!dark)}
      />
      <FloatingDock
        locale={locale}
        langHref={`/?lang=${other}`}
        dark={dark}
        onToggleTheme={() => setDark(!dark)}
      />

      <dialog
        aria-label={d.dialogLabel}
        ref={demo}
        className="workflow-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) demo.current?.close();
        }}
      >
        <button
          className="dialog-close"
          aria-label={d.dialogClose}
          onClick={() => demo.current?.close()}
        >
          <Icon name="close" size={22} />
        </button>
        <span className="eyebrow">{d.dialogEyebrow}</span>
        <h2>
          {d.dialogTitle1}
          <br />
          <em>{d.dialogTitle2}</em>
        </h2>
        <p>{d.dialogText}</p>
        <div className="demo-choices">
          {workflows.map((w, i) => (
            <button
              key={w.title}
              onClick={() => {
                setRecommendation(i);
                setPrompt(prompts[i] ?? '');
              }}
              aria-pressed={recommendation === i}
            >
              <Icon name={WORKFLOW_ICONS[i] ?? 'cloud'} size={18} />
              {d.choices[i]}
            </button>
          ))}
        </div>
        <ol className="demo-steps">
          {(workflows[recommendation ?? 0]?.steps ?? []).map((s) => (
            <li key={s}>
              <Icon name="check" size={17} />
              {s}
            </li>
          ))}
        </ol>
        <a
          className="button button-blue"
          href={recommendation === 1 ? '/builder/projects' : '/automation/workflows/new'}
        >
          {recommendation === 1 ? d.openBuilder : d.openWorkflows}
        </a>
      </dialog>
    </div>
  );
}
