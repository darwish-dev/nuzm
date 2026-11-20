// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleFrame } from '@nuzm/ui';
import { t } from '@nuzm/i18n';
import { SupportPanel } from './SupportPanel';

vi.mock('next/navigation', () => ({ usePathname: () => '/en' }));
afterEach(cleanup);

const topics = [
  { id: 'hosting', label: 'Hosting', href: '/en/hosting/sites', icon: 'hosting' as const },
  { id: 'domains', label: 'Domains', href: '/en/domains', icon: 'globe' as const },
];

describe('support panel', () => {
  it('greets, offers quick links to the areas, and is honest that live chat is not connected (the composer is disabled)', () => {
    render(<SupportPanel locale="en" topics={topics} />);
    expect(screen.getByText(t('en', 'sup.greeting'))).toBeTruthy();
    expect(screen.getByRole('link', { name: /Hosting/ }).getAttribute('href')).toBe(
      '/en/hosting/sites',
    );
    expect(screen.getByRole('link', { name: /Domains/ })).toBeTruthy();
    const box = screen.getByLabelText(t('en', 'sup.placeholder')) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: t('en', 'sup.send') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(t('en', 'sup.offline'))).toBeTruthy();
  });
  it('without any reachable area it shows no empty list of links', () => {
    const { container } = render(<SupportPanel locale="en" topics={[]} />);
    expect(container.querySelector('.sup-topics')).toBeNull();
  });
  it('speaks Arabic', () => {
    render(<SupportPanel locale="ar" topics={[]} />);
    expect(screen.getByText(t('ar', 'sup.greeting'))).toBeTruthy();
  });
  it('closes from its own close button when docked in the console frame', () => {
    const { container } = render(
      <ConsoleFrame
        labels={{ openMenu: 'm', closeMenu: 'c' }}
        brand={null}
        rail={null}
        topbar={null}
        support={{ label: 'Support', content: <SupportPanel locale="en" topics={topics} /> }}
      >
        <p>page</p>
      </ConsoleFrame>,
    );
    expect((container.querySelector('#nzc-support') as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'sup.close'), hidden: true }));
    expect((container.querySelector('#nzc-support') as HTMLElement).hidden).toBe(true);
  });
});
