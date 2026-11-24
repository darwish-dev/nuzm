// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteFrame } from './SiteFrame';
import {
  FaqSection,
  PointsSection,
  RelatedSection,
  ServiceHero,
  StepsSection,
  relatedOf,
} from './SiteSections';
import { PlatformBento } from './PlatformBento';
import { SERVICES, pick, site } from '../../lib/site-content';

afterEach(cleanup);

const page = (locale: 'ar' | 'en', slug: string) => {
  const s = SERVICES.find((x) => x.slug === slug)!;
  return render(
    <SiteFrame
      locale={locale}
      path={`/services/${slug}`}
      mode="dark"
      hero={<ServiceHero locale={locale} s={s} />}
    >
      <PointsSection locale={locale} s={s} />
      <StepsSection locale={locale} s={s} />
      <FaqSection locale={locale} s={s} />
      <RelatedSection locale={locale} current={slug} />
    </SiteFrame>,
  );
};

describe('service page', () => {
  it('has one h1 (the headline), a skip link, and the sections in order', () => {
    page('en', 'hosting');
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe(pick(SERVICES[0]!.headline, 'en'));
    expect(screen.getByRole('link', { name: site('skip', 'en') }).getAttribute('href')).toBe(
      '#main',
    );
    expect(screen.getByRole('main')).toBeTruthy();
    for (const name of ['whatYouGet', 'howItWorks', 'faq', 'related'] as const)
      expect(screen.getAllByText(site(name, 'en')).length).toBeGreaterThan(0);
  });

  it('keeps the visitor in their language and offers the same page in the other one', () => {
    page('ar', 'domains');
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(links).toContain('/en/services/domains');
    expect(links).toContain('/ar/register');
    expect(links).toContain('/ar/domains/search');
    expect(links.filter((h) => h.startsWith('/en/') && h !== '/en/services/domains')).toEqual([]);
  });

  it('lists every service in the menu, and the footer is the home page footer (main services and "All services")', () => {
    page('en', 'email');
    const menu = document.querySelector('.svc-menu-panel') as HTMLElement;
    for (const s of SERVICES)
      expect(within(menu).getByRole('link', { name: new RegExp(pick(s.name, 'en')) })).toBeTruthy();
    const footer = document.querySelector('footer') as HTMLElement;
    for (const href of ['/services', '/services/cloud', '/services/domains', '/services/hosting'])
      expect(footer.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    // the same footer the home page uses: one design
    expect(footer.querySelector('.footer-wordmark')).not.toBeNull();
    expect(footer.querySelectorAll('.footer-links > div')).toHaveLength(4);
  });

  it('shows no price and states where prices are shown', () => {
    page('en', 'hosting');
    expect(document.body.textContent).not.toMatch(/[$€]\s?\d|\d\s?SAR/);
    expect(screen.getByText(site('priceNote', 'en'))).toBeTruthy();
  });

  it('answers each question inside a native disclosure', () => {
    page('en', 'cloud');
    expect(document.querySelectorAll('.svc-faq details').length).toBe(SERVICES[1]!.faq.length);
  });

  it('links onward to three other services, never to itself', () => {
    for (const s of SERVICES) {
      const r = relatedOf(s.slug);
      expect(r).toHaveLength(3);
      expect(r.map((x) => x.slug)).not.toContain(s.slug);
    }
  });

  it('marks the Saudi domains limitation on the domains page', () => {
    page('en', 'domains');
    expect(screen.getByRole('note').textContent).toMatch(/\.sa/);
  });

  it('shows the same drawn illustration as the home page in the hero, as decoration only', () => {
    page('en', 'hosting');
    const art = document.querySelector('.svc-visual .svc-shared-art');
    expect(art).not.toBeNull();
    expect(art?.getAttribute('aria-hidden')).toBe('true');
    expect(art?.querySelector('.bn-card .bn-art')).not.toBeNull();
  });
});

describe('platform bento', () => {
  it('has a link to every service page and to the docs, in the page language', () => {
    render(<PlatformBento locale="ar" title="x" />);
    for (const sv of SERVICES) {
      const cards = screen
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href') === `/ar/services/${sv.slug}`);
      // a card and/or the chip in the banner: every service is reachable from the bento
      expect(cards.length, sv.slug).toBeGreaterThanOrEqual(1);
      expect(cards.some((a) => a.textContent?.includes(pick(sv.name, 'ar')))).toBe(true);
    }
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/ar/docs')).toBe(
      true,
    );
    expect(screen.getByText(site('bnBanner', 'ar'))).toBeTruthy();
  });

  it('keeps the landing page on its own addresses with an empty prefix', () => {
    render(<PlatformBento locale="en" prefix="" title="x" />);
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/services/hosting'),
    ).toBe(true);
  });
});
