// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: post }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/en/billing/invoices' }));
import { ConsoleFrame, ProfileMenu } from './ConsoleShell';

const labels = { openMenu: 'Open menu', closeMenu: 'Close menu' };
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
      tabs={
        <nav className="nzc-tabs">
          <a href="/y">Y</a>
          <details className="nzc-tab-menu">
            <summary>More</summary>
            <a href="/z">Z</a>
          </details>
        </nav>
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

  it('shows the section tabs at the top of the page content', () => {
    const { container } = frame();
    const main = container.querySelector('main.nzc-body')!;
    expect(main.firstElementChild!.classList.contains('nzc-tabs')).toBe(true);
    expect(main.textContent).toContain('page');
    expect(screen.queryByRole('button', { name: /sidebar/i })).toBeNull();
  });

  it('closes an open tab menu on Escape, on an outside click and when a page in it is followed', () => {
    const { container } = frame();
    const menu = container.querySelector('details')!;
    menu.open = true;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menu.open).toBe(false);
    menu.open = true;
    fireEvent.pointerDown(screen.getByText('page'));
    expect(menu.open).toBe(false);
    menu.open = true;
    fireEvent.pointerDown(menu);
    expect(menu.open).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Z' }));
    expect(menu.open).toBe(false);
  });

  it('opens the drawer on small screens, closes on Escape and when a link is followed', () => {
    const { container } = frame();
    const app = container.querySelector('.nzc-app')!;
    fireEvent.click(screen.getByRole('button', { name: labels.openMenu }));
    expect(app.getAttribute('data-drawer')).toBe('open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(app.getAttribute('data-drawer')).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: labels.openMenu }));
    fireEvent.click(screen.getByRole('link', { name: 'X' }));
    expect(app.getAttribute('data-drawer')).toBe('closed');
  });

  it('renders the page inside the main landmark', () => {
    frame();
    const main = screen.getByRole('main');
    expect(main.lastElementChild!.textContent).toBe('page');
    expect(main.textContent).toMatch(/page$/);
  });
});

describe('account menu', () => {
  const menu = (theme: 'dark' | 'light' = 'dark', extra: Record<string, unknown> = {}) =>
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
        {...extra}
      />,
    );
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

  it("lists the organization's pages under its name, marking the current one", () => {
    menu('dark', {
      linksTitle: 'codgoo',
      links: [
        { href: '/en/settings/team', label: 'Team', icon: 'user', current: true },
        { href: '/en/privacy', label: 'Privacy and data', icon: 'shield' },
      ],
    });
    open();
    expect(screen.getByText('codgoo')).toBeTruthy();
    const team = screen.getByRole('menuitem', { name: 'Team' });
    expect(team.getAttribute('href')).toBe('/en/settings/team');
    expect(team.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('menuitem', { name: 'Privacy and data' }).getAttribute('aria-current'),
    ).toBeNull();
  });

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
