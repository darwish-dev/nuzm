'use client';

import { useRef, useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import { BrandWordmark } from '../BrandLogo';
import { SiteHeader } from '../site/SiteHeader';
import { SERVICES, pick } from '../../lib/site-content';
import { PlatformBento } from '../site/PlatformBento';
import { AiBuildShowcase } from './AiBuildShowcase';
import { AiChatSection } from './AiChatSection';
import { TechStrip } from './TechStrip';
import { useSectionScroll } from './useSectionScroll';

// Native CSS with the owner’s attached Nuzm bento identity and logo.
// DESIGN_VARIANCE 7 / MOTION_INTENSITY 4 / VISUAL_DENSITY 4.
// Identity radii: 999px controls, 28px cards, 16px inset panels.
const prompts = ['Automate my operations', 'Build my next website', 'Connect my business tools'];
const workflows = [
  {
    title: 'Operations, without the busywork.',
    text: 'Connect requests, approvals, and notifications in a workflow you control.',
    icon: 'cloud' as IconName,
    steps: ['Receive a request', 'Review the next action', 'Notify your team'],
  },
  {
    title: 'Your idea. A working starting point.',
    text: 'Describe what you want to build, then bring it into the Nuzm builder to develop and refine.',
    icon: 'code' as IconName,
    steps: ['Describe your idea', 'Build your first version', 'Review and publish'],
  },
  {
    title: 'Make your tools work together.',
    text: 'Design a connected workflow with AI assistance and keep your team in control.',
    icon: 'workflow' as IconName,
    steps: ['Choose your tools', 'Define your workflow', 'Review each action'],
  },
];

export function LandingPage() {
  const scrollRoot = useRef<HTMLDivElement>(null);
  useSectionScroll(scrollRoot);
  const [prompt, setPrompt] = useState('');
  const [recommendation, setRecommendation] = useState<number | null>(null);
  const [dark, setDark] = useState(true);
  const demo = useRef<HTMLDialogElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const recommendationData = recommendation === null ? null : workflows[recommendation];

  function suggest(value: string) {
    setPrompt(value);
    setRecommendation(
      /automate|operations|request|approval/i.test(value)
        ? 0
        : /website|build|code|app/i.test(value)
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
        Skip to content
      </a>
      <section className="hero" aria-labelledby="hero-title">
        <div className="sky" aria-hidden="true">
          <div className="horizon" />
        </div>
        <SiteHeader
          locale="en"
          otherLocale={{ code: 'ar', label: 'العربية', href: '/ar/services' }}
          services={SERVICES.map((s) => ({
            slug: s.slug,
            icon: s.icon,
            name: pick(s.name, 'en'),
            tagline: pick(s.tagline, 'en'),
          }))}
          labels={{
            home: 'Nuzm home',
            nav: 'Main navigation',
            services: 'Services',
            allServices: 'All services',
            login: 'Log in',
            start: 'Get started',
            menu: 'Open navigation',
            closeMenu: 'Close navigation',
            developers: 'Documentation',
          }}
        />
        <main id="main" className="hero-content wrap">
          <a href="#agents" className="announcement">
            <span>MEET NUZM AI</span> A little intelligence. Endless possibility.{' '}
            <Icon name="chevron" size={13} />
          </a>
          <h1 id="hero-title">
            Your ambition,
            <br />
            <em>powered by AI.</em>
          </h1>
          <p className="hero-sub">
            AI agents, cloud, and business tools.
            <br />
            Everything connected. Everything moving you forward.
          </p>
          <form
            className="prompt-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) suggest(prompt.trim());
            }}
          >
            <label className="sr-only" htmlFor="agent-prompt">
              What would you like to create or automate?
            </label>
            <input
              id="agent-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What would you like to make possible?"
              maxLength={500}
              required
            />
            <div className="prompt-toolbar">
              <span>
                <Icon name="sparkle" size={17} /> Nuzm AI <span className="prompt-divider">/</span>{' '}
                <span className="prompt-helper">Your next chapter starts here</span>
              </span>
              <button type="submit" aria-label="Explore a workflow for your idea">
                <Icon name="send" size={20} />
              </button>
            </div>
          </form>
          <div className="prompt-suggestions" aria-label="Try an idea">
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
                <span className="eyebrow">SUGGESTED STARTING POINT</span>
                <h2>{recommendationData.title}</h2>
                <p>{recommendationData.text}</p>
              </div>
              <a
                className="button button-blue"
                href={
                  recommendation === 1 ? '/en/builder/projects' : '/en/automation/workflows/new'
                }
              >
                Open {recommendation === 1 ? 'builder' : 'workflows'}
              </a>
            </div>
          )}
        </main>
        <TechStrip />
      </section>

      <AiBuildShowcase />

      <AiChatSection />

      <section
        id="platform"
        className="section wrap platform-section"
        aria-labelledby="platform-title"
      >
        <div className="section-heading">
          <h2 id="platform-title">
            One platform.
            <br />
            <em>Everything you need.</em>
          </h2>
          <p>Hosting, domains, servers, AI and the tools around them, designed to work together.</p>
        </div>
        <PlatformBento locale="en" prefix="" title="The Nuzm platform" />
      </section>

      <section className="section integrations-section wrap bridge-section" id="integrations">
        <span className="eyebrow">INTELLIGENCE MEETS EVERYDAY WORK</span>
        <h2>
          Your AI.
          <br />
          <em>Your business. Connected.</em>
        </h2>
        <p>AI assistance, connected to the tools your business runs on.</p>
        <div
          className="bridge-map"
          aria-label="Claude connects through Nuzm to domains, hosting, email, ERP, CRM, and business apps"
        >
          <div className="bridge-source bridge-claude">
            <img src="/brand/claude.svg" alt="Claude" width={220} height={48} />
            <span>Intelligence for your everyday work</span>
          </div>
          <span className="bridge-link" aria-hidden="true">
            <i />
          </span>
          <div className="bridge-hub">
            <span>
              <img src="/brand/nuzm-mark.png" alt="Nuzm" width={54} height={43} />
            </span>
            <strong>Nuzm</strong>
            <small>One connected platform</small>
          </div>
          <span className="bridge-link" aria-hidden="true">
            <i />
          </span>
          <div className="bridge-destinations">
            {(
              [
                { name: 'Domains', icon: 'globe', href: '/en/services/domains' },
                { name: 'Web hosting', icon: 'hosting', href: '/en/services/hosting' },
                { name: 'Business email', icon: 'mail', href: '/en/services/email' },
                { name: 'ERP', icon: 'organization', href: '/en/services/automation' },
                { name: 'CRM', icon: 'user', href: '/en/services/automation' },
                { name: 'Business apps', icon: 'grid', href: '/en/services/ai-builder' },
              ] as { name: string; icon: IconName; href: string }[]
            ).map((item, i) => (
              <a
                href={item.href}
                key={item.name}
                className={`bridge-destination bridge-tone-${i % 3} bridge-service-${item.icon}`}
              >
                <span>
                  <Icon name={item.icon} size={28} />
                  <i aria-hidden="true" />
                </span>
                <strong>{item.name}</strong>
              </a>
            ))}
          </div>
        </div>
        <a href="/en/services" className="text-button">
          Explore the platform <Icon name="plus" size={16} />
        </a>
      </section>

      <footer className="site-footer">
        <div className="footer-horizon" aria-hidden="true" />
        <div className="wrap footer-inner">
          <div className="footer-invitation">
            <span className="eyebrow">YOUR NEXT CHAPTER</span>
            <h2>
              Make room for
              <br />
              <em>what’s possible.</em>
            </h2>
          </div>
          <div className="footer-links">
            <div className="footer-brand">
              <a href="/" className="brand" aria-label="Nuzm home">
                <BrandWordmark />
              </a>
              <p>
                Intelligence. Infrastructure.
                <br />A little more possibility.
              </p>
            </div>
            <div>
              <h3>Explore</h3>
              <a href="#agents">AI agents</a>
              <a href="/en/automation/workflows">Automation</a>
              <a href="/en/builder/projects">Vibe coding</a>
              <a href="#integrations">Integrations</a>
            </div>
            <div>
              <h3>Build on Nuzm</h3>
              <a href="/en/services/cloud">Cloud servers</a>
              <a href="/en/services/domains">Domains</a>
              <a href="/en/services/hosting">Website cloud</a>
              <a href="/en/services/ai-builder">AI builder</a>
              <a href="/en/services">All services</a>
            </div>
            <div>
              <h3>Your workspace</h3>
              <a href="/designs">Design library</a>
              <a href="/en/login">Log in</a>
              <a href="/en/register">Get started</a>
              <a href="/ar/login" lang="ar">
                العربية
              </a>
              <button
                className="theme-button"
                onClick={() => setDark(!dark)}
                aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`}
              >
                <Icon name={dark ? 'sun' : 'moon'} size={16} />
                {dark ? 'Light appearance' : 'Dark appearance'}
              </button>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} Nuzm. All rights reserved.</span>
            <span>Built around your possibilities.</span>
            <a href="#hero-title">
              Back to top <Icon name="send" size={13} />
            </a>
          </div>
          <div className="footer-wordmark" aria-hidden="true">
            nuzm<span>®</span>
          </div>
        </div>
      </footer>

      <dialog
        aria-label="AI workflow preview"
        ref={demo}
        className="workflow-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) demo.current?.close();
        }}
      >
        <button
          className="dialog-close"
          aria-label="Close workflow preview"
          onClick={() => demo.current?.close()}
        >
          <Icon name="close" size={22} />
        </button>
        <span className="eyebrow">EXPLORE THE EXPERIENCE</span>
        <h2>
          A workflow with
          <br />
          <em>you at the center.</em>
        </h2>
        <p>
          Choose a starting point to see how your work could connect. This is an illustrative
          preview.
        </p>
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
              <Icon name={w.icon} size={18} />
              {['Operations', 'Build with AI', 'Integrations'][i]}
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
          href={recommendation === 1 ? '/en/builder/projects' : '/en/automation/workflows/new'}
        >
          Open {recommendation === 1 ? 'builder' : 'workflows'}
        </a>
      </dialog>
    </div>
  );
}
