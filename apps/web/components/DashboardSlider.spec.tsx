// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DashboardSlider } from './DashboardSlider';
afterEach(cleanup);
it('changes the slide and destination, wraps, and allows direct selection', () => {
  const slides = [
    {
      id: 'hosting',
      title: 'Hosting',
      description: 'Your sites',
      label: 'Explore',
      href: '/en/hosting/sites',
    },
    {
      id: 'domains',
      title: 'Domains',
      description: 'Your name',
      label: 'Explore',
      href: '/en/domains',
    },
  ];
  render(<DashboardSlider ar={false} slides={slides} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
  expect(screen.getByRole('link', { name: 'Explore' }).getAttribute('href')).toBe('/en/domains');
  fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
  expect(screen.getByRole('heading').textContent).toBe('Hosting');
  fireEvent.click(screen.getByRole('button', { name: 'Domains' }));
  expect(screen.getByRole('button', { name: 'Domains' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
  expect(screen.getByRole('heading').textContent).toBe('Hosting');
});
