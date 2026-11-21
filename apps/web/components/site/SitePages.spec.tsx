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
import { Mosaic } from './Mosaic';
import { ThemedImage } from './ThemedImage';
import { MOSAIC, SERVICES, pick, site } from '../../lib/site-content';

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

  it('shows the service illustration in the hero and on its card, as decoration (empty alt)', () => {
    page('en', 'hosting');
    const imgs = Array.from(document.querySelectorAll('img')).filter((i) =>
      i.getAttribute('src')?.startsWith('/images/illustrations/'),
    );
    expect(imgs.length).toBeGreaterThanOrEqual(4);
    for (const i of imgs) expect(i.getAttribute('alt')).toBe('');
    expect(document.querySelector('.svc-visual img')?.getAttribute('src')).toBe(SERVICES[0]!.image);
  });
});

describe('illustration mosaic', () => {
  it('has a labelled link per tile, in the page language, with its own page for the home tile', () => {
    render(<Mosaic locale="ar" title="x" homeHref="#agents" />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(MOSAIC.length);
    for (const t of MOSAIC) {
      const a = screen.getByRole('link', { name: pick(t.label, 'ar') });
      expect(a.getAttribute('href')).toBe(t.href === '' ? '#agents' : `/ar${t.href}`);
    }
  });

  it('every picture comes in a light and a dark version, the dark one in /dark/, both decorative', () => {
    render(
      <ThemedImage src="/images/illustrations/cloud.webp" width={380} height={290} className="x" />,
    );
    const imgs = Array.from(document.querySelectorAll('img'));
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      '/images/illustrations/cloud.webp',
      '/images/illustrations/dark/cloud.webp',
    ]);
    expect(imgs.map((i) => i.className)).toEqual(['il-light x', 'il-dark x']);
    for (const i of imgs) {
      expect(i.getAttribute('alt')).toBe('');
      expect(i.getAttribute('loading')).toBe('lazy');
    }
  });
});
