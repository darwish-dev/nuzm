// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/en/billing/invoices' }));
import { ConsoleFrame, ProfileMenu } from './ConsoleShell';

const labels = { toggle: 'Toggle sidebar', openMenu: 'Open menu', closeMenu: 'Close menu' };
const frame = () =>
  render(
    <ConsoleFrame
      labels={labels}
      brand={<a href="/en">Nuzm</a>}
      rail={
        <nav className="nzc-rail">
          <a href="/x">X</a>
        </nav>
      }
      side={
        <aside className="nzc-side">
          <a href="/y">Y</a>
        </aside>
      }
      topbar={<span>top</span>}
    >
      <p>page</p>
    </ConsoleFrame>,
  );
beforeEach(() => {
  post.mockReset();
  localStorage.clear();
  document.body.dataset.theme = 'dark';
  document.cookie = 'nuzm_theme=; path=/; max-age=0';
  Object.defineProperty(window, 'location', { value: { assign: vi.fn() }, writable: true });
});
afterEach(cleanup);

describe('console frame', () => {
  it('puts the brand and the top bar above the rail and the page', () => {
    const { container } = frame();
    const header = container.querySelector('header.nzc-top')!;
    expect(header.textContent).toContain('Nuzm');
    expect(header.textContent).toContain('top');
    expect(container.querySelector('.nzc-frame .nzc-rail')).toBeTruthy();
    expect(header.compareDocumentPosition(container.querySelector('.nzc-frame')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('collapses the contextual sidebar and remembers it, without touching the rail', () => {
    const { container } = frame();
    const app = container.querySelector('.nzc-app')!;
    expect(app.getAttribute('data-side')).toBe('open');
    fireEvent.click(screen.getByRole('button', { name: labels.toggle }));
    expect(app.getAttribute('data-side')).toBe('collapsed');
    expect(localStorage.getItem('nuzm.sidebar')).toBe('collapsed');
    expect(container.querySelector('.nzc-rail')).toBeTruthy();
  });

  it('restores a collapsed sidebar on load', async () => {
    localStorage.setItem('nuzm.sidebar', 'collapsed');
    const { container } = frame();
    await waitFor(() =>
      expect(container.querySelector('.nzc-app')!.getAttribute('data-side')).toBe('collapsed'),
    );
  });

  it('opens the drawer on small screens, closes on Escape and when a link is followed', () => {
    const { container } = frame();
    const app = container.querySelector('.nzc-app')!;
    fireEvent.click(screen.getByRole('button', { name: labels.openMenu }));
    expect(app.getAttribute('data-drawer')).toBe('open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(app.getAttribute('data-drawer')).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: labels.openMenu }));
    fireEvent.click(screen.getByRole('link', { name: 'Y' }));
    expect(app.getAttribute('data-drawer')).toBe('closed');
  });

  it('renders the page inside the main landmark', () => {
    frame();
    expect(screen.getByRole('main').textContent).toBe('page');
  });
});

describe('account menu', () => {
  const menu = (theme: 'dark' | 'light' = 'dark') =>
    render(
      <ProfileMenu
        initials="SC"
        name="Sara C"
        email="sara@example.test"
        locale="en"
        languages={[
          { code: 'ar', label: 'العربية' },
          { code: 'en', label: 'English' },
        ]}
        theme={theme}
        labels={{
          menu: 'Account menu',
          profile: 'Profile and security',
          language: 'Language',
          darkMode: 'Dark mode',
          signOut: 'Sign out',
        }}
        profileHref="/en/account"
        signedOutTo="/en/login"
      />,
    );
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

  it('opens with the profile link, language, dark mode and sign out, and closes on Escape', () => {
    menu();
    const btn = screen.getByRole('button', { name: 'Account menu' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Profile and security' }).getAttribute('href'),
    ).toBe('/en/account');
    expect(screen.getByRole('menuitemcheckbox', { name: /Dark mode/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on an outside click', () => {
    menu();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers both languages as links to the same page, marking the current one', () => {
    menu();
    open();
    const ar = screen.getByRole('menuitemradio', { name: /العربية/ });
    const en = screen.getByRole('menuitemradio', { name: /English/ });
    expect(ar.getAttribute('href')).toBe('/ar/billing/invoices');
    expect(ar.getAttribute('aria-checked')).toBe('false');
    expect(en.getAttribute('aria-checked')).toBe('true');
  });

  it('switches the theme, the document and the cookie', () => {
    menu('dark');
    open();
    const dark = screen.getByRole('menuitemcheckbox', { name: /Dark mode/ });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(dark);
    expect(document.body.dataset.theme).toBe('light');
    expect(document.cookie).toContain('nuzm_theme=light');
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Dark mode/ }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('signs out through the API and returns to the login page', async () => {
    post.mockResolvedValue({ response: { ok: true, status: 204 } });
    menu();
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/auth/logout', {}));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/en/login'));
  });
});
