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

  it('lists every service in the menu and the footer', () => {
    page('en', 'email');
    const menu = document.querySelector('.svc-menu-panel') as HTMLElement;
    for (const s of SERVICES)
      expect(within(menu).getByRole('link', { name: new RegExp(pick(s.name, 'en')) })).toBeTruthy();
    const footer = document.querySelector('footer') as HTMLElement;
    for (const s of SERVICES)
      expect(within(footer).getByRole('link', { name: pick(s.name, 'en') })).toBeTruthy();
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
});
