// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleFrame } from '@nuzm/ui';
import { t } from '@nuzm/i18n';
import { SupportPanel } from './SupportPanel';

vi.mock('next/navigation', () => ({ usePathname: () => '/console' }));
afterEach(cleanup);

const topics = [
  { id: 'hosting', label: 'Hosting', href: '/hosting/sites', icon: 'hosting' as const },
  { id: 'domains', label: 'Domains', href: '/domains', icon: 'globe' as const },
];

const docs = {
  home: '/documentation',
  guides: [
    {
      href: '/documentation/guides/quickstart',
      title: 'Quickstart',
      summary: 'Your first request',
      icon: 'sparkle' as const,
    },
    {
      href: '/documentation/guides/errors',
      title: 'Errors',
      summary: 'Problem details and codes',
      icon: 'shield' as const,
    },
  ],
  reference: [{ href: '/documentation/reference/billing', title: 'Billing' }],
  referenceHome: '/documentation/reference',
  endpoints: 42,
};

describe('support panel documentation tab', () => {
  it('has Chat and Documentation tabs; Documentation lists the guides and the API reference, linking to the console copy', () => {
    render(<SupportPanel locale="en" topics={topics} docs={docs} />);
    const chatTab = screen.getByRole('tab', { name: t('en', 'sup.tab.chat') });
    const docsTab = screen.getByRole('tab', { name: t('en', 'sup.tab.docs') });
    expect(chatTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(docsTab);
    expect(docsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').id).toBe('sup-panel-docs');
    expect(screen.getByRole('link', { name: /Quickstart/ }).getAttribute('href')).toBe(
      '/documentation/guides/quickstart',
    );
    expect(
      screen
        .getByRole('link', { name: new RegExp(t('en', 'sup.docs.reference')) })
        .getAttribute('href'),
    ).toBe('/documentation/reference');
    expect(
      screen.getByRole('link', { name: t('en', 'sup.docs.openAll') }).getAttribute('href'),
    ).toBe('/documentation');
    // the composer belongs to the chat tab only
    expect(screen.queryByLabelText(t('en', 'sup.placeholder'))).toBeNull();
  });
  it('searches guides and API areas, and says when nothing matches', () => {
    render(<SupportPanel locale="en" topics={[]} docs={docs} />);
    fireEvent.click(screen.getByRole('tab', { name: t('en', 'sup.tab.docs') }));
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'problem' } });
    expect(screen.getByRole('link', { name: /Errors/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Quickstart/ })).toBeNull();
    fireEvent.change(box, { target: { value: 'billing' } });
    expect(screen.getByRole('link', { name: /Billing/ }).getAttribute('href')).toBe(
      '/documentation/reference/billing',
    );
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(t('en', 'sup.docs.empty'))).toBeTruthy();
  });
  it('the chat quick links open the Documentation tab, and arrow keys move between tabs', () => {
    render(<SupportPanel locale="ar" topics={topics} docs={docs} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('ar', 'sup.docs.link')) }));
    expect(
      screen.getByRole('tab', { name: t('ar', 'sup.tab.docs') }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(
      screen.getByRole('tab', { name: t('ar', 'sup.tab.chat') }).getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('support panel', () => {
  it('greets and offers quick links to the areas of the console', () => {
    render(<SupportPanel locale="en" topics={topics} />);
    expect(screen.getByText(t('en', 'sup.greeting'))).toBeTruthy();
    expect(screen.getByRole('link', { name: /Hosting/ }).getAttribute('href')).toBe(
      '/hosting/sites',
    );
    expect(screen.getByRole('link', { name: /Domains/ })).toBeTruthy();
    expect(screen.getByText(t('en', 'sup.offline'))).toBeTruthy();
  });
  it('you can type and send: the message shows in the thread, marked as not sent because live chat is not connected', () => {
    const { container } = render(<SupportPanel locale="en" topics={topics} />);
    const box = screen.getByLabelText(t('en', 'sup.placeholder')) as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: t('en', 'sup.send') }) as HTMLButtonElement;
    expect(box.disabled).toBe(false);
    expect(send.disabled).toBe(true); // nothing to send yet
    fireEvent.change(box, { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'My domain is not resolving' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(container.querySelector('.sup-mine p')?.textContent).toBe('My domain is not resolving');
    expect(screen.getByText(t('en', 'sup.notSent'))).toBeTruthy();
    expect(box.value).toBe('');
  });
  it('Enter sends and Shift+Enter keeps writing', () => {
    const { container } = render(<SupportPanel locale="en" topics={[]} />);
    const box = screen.getByLabelText(t('en', 'sup.placeholder')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'first line' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(container.querySelectorAll('.sup-mine')).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(container.querySelectorAll('.sup-mine')).toHaveLength(1);
    fireEvent.change(box, { target: { value: 'second' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(container.querySelectorAll('.sup-mine')).toHaveLength(2);
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
