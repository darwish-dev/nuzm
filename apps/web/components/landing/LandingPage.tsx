'use client';

import { useRef, useState } from 'react';
import { Icon, type IconName } from '@nuzm/ui';
import { BrandWordmark } from '../BrandLogo';
import { ServiceArtwork } from '../ServiceArtwork';
import { DownloadSection } from './DownloadSection';
import { useSectionScroll } from './useSectionScroll';

// Native CSS with the owner’s attached Nuzm bento identity and logo.
// DESIGN_VARIANCE 7 / MOTION_INTENSITY 4 / VISUAL_DENSITY 4.
// Identity radii: 999px controls, 28px cards, 16px inset panels.
const services: { name: string; description: string; icon: IconName; href: string; tag: string }[] =
  [
    {
      name: 'Cloud servers',
      description:
        'A strong foundation for your next big thing. Provision and manage your compute in one place.',
      icon: 'cloud',
      href: '/en/services/cloud',
      tag: 'BUILT TO SCALE',
    },
    {
      name: 'Domains',
      description:
        'Every great idea starts with a name. Find yours, connect it, and make it unmistakably you.',
      icon: 'globe',
      href: '/en/services/domains',
      tag: 'MAKE IT YOURS',
    },
    {
      name: 'Website cloud',
      description:
        'From your first launch to your next milestone. Give your websites a place to grow.',
      icon: 'hosting',
      href: '/en/services/hosting',
      tag: 'READY FOR LAUNCH',
    },
    {
      name: 'AI development',
      description:
        'Vibe code websites and connect multiple systems, from the first prompt to deployment.',
      icon: 'code',
      href: '/en/services/ai-builder',
      tag: 'FROM IDEA TO LAUNCH',
    },
  ];
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
  const [menuOpen, setMenuOpen] = useState(false);
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
          <div className="star-field" />
        </div>
        <header className="site-header wrap">
          <a href="/" aria-label="Nuzm home" className="brand">
            <BrandWordmark />
          </a>
          <nav className={menuOpen ? 'main-nav is-open' : 'main-nav'} aria-label="Main navigation">
            {[
              ['Services', '/en/services'],
              ['AI agents', '#agents'],
              ['Workspace', '#cloud'],
              ['Cloud & domains', '#cloud'],
              ['Integrations', '#integrations'],
            ].map(([label, href]) => (
              <a key={label} href={href} onClick={() => setMenuOpen(false)}>
                {label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <a href="/en/login" className="login-link">
              Log in
            </a>
            <a href="/en/register" className="button button-white">
              Get started <Icon name="sparkle" size={15} />
            </a>
            <button
              className="menu-toggle"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} size={22} />
            </button>
          </div>
        </header>
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
          <span className="orbit-note note-one" aria-hidden="true">
            <Icon name="workflow" size={19} />
            <span>Less busywork.</span>
          </span>
          <span className="orbit-note note-two" aria-hidden="true">
            <Icon name="sparkle" size={19} />
            <span>More possibility.</span>
          </span>
        </main>
        <div className="ecosystem wrap">
          <p>ONE CONNECTED ECOSYSTEM. YOUR KIND OF POSSIBLE.</p>
          <div>
            <a href="#agents">
              <Icon name="sparkle" /> AI agents
            </a>
            <a href="/en/automation/workflows">
              <Icon name="workflow" /> Automation
            </a>
            <a href="#cloud">
              <Icon name="cloud" /> Cloud
            </a>
            <a href="/en/domains/search">
              <Icon name="globe" /> Domains
            </a>
            <a href="/en/builder/projects">
              <Icon name="code" /> Vibe coding
            </a>
            <a href="#integrations">
              <Icon name="workflow" /> Integrations
            </a>
          </div>
        </div>
      </section>

      <section id="agents" className="section wrap agent-section">
        <div className="agent-intro">
          <span className="eyebrow">A NEW WAY TO WORK</span>
          <h2>
            Big ideas deserve
            <br />
            <em>an intelligent partner.</em>
          </h2>
          <p>
            Meet the extra pair of hands your business has been waiting for. Turn everyday tasks
            into connected workflows, with you in control.
          </p>
          <button className="text-button" onClick={() => demo.current?.showModal()}>
            Explore the experience <Icon name="plus" size={16} />
          </button>
          <div className="agent-principles">
            <span>
              <Icon name="check" size={16} /> Made for your workflow
            </span>
            <span>
              <Icon name="check" size={16} /> Human at the heart
            </span>
          </div>
        </div>
        <div className="agent-canvas">
          <div className="canvas-grid" />
          <span className="canvas-label">YOUR WORK, CONNECTED</span>
          <div className="flow-node node-a">
            <Icon name="mail" size={19} />
            <span>A new request arrives</span>
          </div>
          <div className="agent-orb">
            <img src="/brand/nuzm-mark.png" alt="" width="54" height="43" />
          </div>
          <div className="orb-caption">
            Nuzm AI<span>Understands. Connects. Assists.</span>
          </div>
          <div className="flow-node node-b">
            <Icon name="check" size={18} />
            <span>Ready for your review</span>
          </div>
          <div className="flow-node node-c">
            <Icon name="organization" size={18} />
            <span>Your team, in the loop</span>
          </div>
          <span className="canvas-footnote">An illustration of your future workflow</span>
        </div>
      </section>

      <section id="cloud" className="section cloud-section wrap">
        <div className="section-heading">
          <h2>
            Grounded in the cloud.
            <br />
            <em>Ready for anything.</em>
          </h2>
          <p>Your infrastructure, your address, your next launch. All under one roof.</p>
        </div>
        <div className="workspace-toolbar">
          <span>
            <Icon name="dashboard" size={18} /> Your workspace
          </span>
          <a href="/en" className="button button-outline">
            Open dashboard
          </a>
        </div>
        <div className="cloud-grid">
          {services.map((service, index) => (
            <article className={`cloud-card cloud-card-${index}`} key={service.name}>
              <div className="service-card-top">
                <h3>{service.name}</h3>
                <span className="service-icon">
                  <Icon name={service.icon} size={22} />
                </span>
              </div>
              <div className="service-art">
                <ServiceArtwork
                  service={['compute', 'domains', 'hosting', 'builder'][index] ?? 'compute'}
                  ar={false}
                />
              </div>
              <div className="cloud-card-content">
                <p>{service.description}</p>
                <a href={service.href} className="button button-outline service-button">
                  Explore {service.name.toLowerCase()}
                  <Icon name="chevron" size={16} />
                </a>
              </div>
            </article>
          ))}
          <aside className="workspace-summary">
            <div className="summary-heading">
              <Icon name="projects" size={24} />
              <span>One connected workspace</span>
            </div>
            <div className="service-ring">
              <div>
                <strong>04</strong>
                <span>Core services</span>
              </div>
            </div>
            <h3>Build. Launch. Manage.</h3>
            <p>Cloud, domains, websites, and AI development. Your next idea has a home.</p>
            <a href="/en/register" className="button button-blue">
              Get started
              <Icon name="sparkle" size={17} />
            </a>
            <span className="summary-footnote">Your infrastructure, together.</span>
          </aside>
        </div>
        <form className="domain-search" action="/en/domains/search">
          <div>
            <Icon name="globe" size={23} />
            <label htmlFor="domain-name">Give your idea a name.</label>
          </div>
          <div className="domain-field">
            <input
              id="domain-name"
              name="q"
              placeholder="Find your perfect domain"
              required
              maxLength={253}
              aria-label="Domain name"
              pattern="[^\s/]+"
            />
            <button className="button button-blue" type="submit">
              Search domains
            </button>
          </div>
        </form>
      </section>

      <section className="section integrations-section wrap" id="integrations">
        <span className="eyebrow">BETTER, TOGETHER</span>
        <h2>
          Your favorite tools.
          <br />
          <em>A more connected world.</em>
        </h2>
        <p>
          Explore AI integrations with Claude and a connected cloud ecosystem with MacCloud. Shape a
          setup around the way you work.
        </p>
        <div className="integration-orbit">
          <span className="integration-chip claude">
            <span aria-hidden="true">✳</span> Claude
          </span>
          <span className="connector-line" />
          <span className="integration-center">
            <img src="/brand/nuzm-mark.png" alt="Nuzm" width="40" height="32" />
          </span>
          <span className="connector-line" />
          <span className="integration-chip">
            <Icon name="cloud" size={27} /> MacCloud
          </span>
        </div>
        <a href="/en/automation/connectors" className="text-button">
          Explore integrations <Icon name="plus" size={16} />
        </a>
      </section>

      <DownloadSection />

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
            <a className="button button-blue" href="/en/register">
              Get started <Icon name="sparkle" size={16} />
            </a>
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
