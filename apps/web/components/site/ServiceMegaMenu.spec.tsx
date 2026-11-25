// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ServiceMegaMenu } from './ServiceMegaMenu';
import { SERVICES, pick } from '../../lib/site-content';
import { BUILDER_PAGES } from '../../lib/builder-pages';
afterEach(cleanup);
const services = SERVICES.map((s) => ({
  slug: s.slug,
  icon: s.icon,
  name: pick(s.name, 'en'),
  tagline: pick(s.tagline, 'en'),
}));
it('filters service links by category without navigating away', () => {
  const { container } = render(
    <ServiceMegaMenu services={services} locale="en" close={() => {}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Hosting & cloud' }));
  const links = Array.from(container.querySelectorAll('.mega-product-grid > a')).map((a) =>
    a.getAttribute('href'),
  );
  expect(links).toEqual(['/en/services/hosting', '/en/services/cloud', '/en/services/vps']);
});
it('links to all three distinct builder pages', () => {
  const { container } = render(
    <ServiceMegaMenu services={services} locale="en" builders close={() => {}} />,
  );
  expect(container.querySelectorAll('.mega-product-grid > a')).toHaveLength(3);
  for (const builder of BUILDER_PAGES)
    expect(
      screen.getByRole('link', { name: new RegExp(builder.name.en) }).getAttribute('href'),
    ).toBe(`/en/services/${builder.slug}`);
});
it('has complete Arabic and English builder page content', () => {
  expect(new Set(BUILDER_PAGES.map((b) => b.slug)).size).toBe(3);
  for (const builder of BUILDER_PAGES) {
    expect(builder.points).toHaveLength(4);
    expect(builder.steps).toHaveLength(3);
    expect(builder.headline.ar.length).toBeGreaterThan(10);
    expect(builder.intro.en.length).toBeGreaterThan(30);
  }
});
