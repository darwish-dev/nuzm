// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@nuzm/i18n';

vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../lib/client', () => ({ browserApi: () => ({ POST: vi.fn() }) }));
import { LoginForm } from './AuthForms';
import { AuthShell, OrDivider } from './AuthShell';

afterEach(cleanup);

describe('sign-in / sign-up shell', () => {
  it('has one heading (the form title), the brand panel beside it, and what the account is for on sign-in', () => {
    render(
      <AuthShell locale="en" variant="login" title="Sign in to Nuzm" sub="Enter your email">
        <OrDivider locale="en" />
      </AuthShell>,
    );
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in to Nuzm');
    expect(screen.getByRole('complementary', { name: t('en', 'auth.panel.label') })).toBeTruthy();
    expect(screen.getByText(t('en', 'auth.panel.login.title'))).toBeTruthy();
    for (const k of ['f1', 'f2', 'f3'] as const)
      expect(screen.getByText(t('en', `auth.panel.${k}`))).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nuzm' }).getAttribute('href')).toBe('/console');
  });
  it('sign-up shows its two real steps and marks the current one', () => {
    render(
      <AuthShell locale="en" variant="register" step={2} title="Organization">
        <p>form</p>
      </AuthShell>,
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent?.replace(/^[✓\d]/, ''))).toEqual([
      t('en', 'onb.account'),
      t('en', 'onb.org'),
    ]);
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.getAttribute('data-state')).toBe('done');
  });
  it('renders in Arabic with Arabic copy and the language link to English', () => {
    render(
      <AuthShell locale="ar" variant="help" title="x">
        <p>form</p>
      </AuthShell>,
    );
    expect(screen.getByText(t('ar', 'auth.panel.help.title'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'English' })).toBeTruthy();
  });
});

describe('password field', () => {
  it('shows and hides the password with a named, announced button, and never changes what is typed', () => {
    render(<LoginForm locale="en" />);
    const input = screen.getByLabelText(t('en', 'field.password')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a long passphrase 2026' } });
    expect(input.type).toBe('password');
    const toggle = screen.getByRole('button', { name: t('en', 'auth.password.show') });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(input.value).toBe('a long passphrase 2026');
    expect(
      screen
        .getByRole('button', { name: t('en', 'auth.password.hide') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'auth.password.hide') }));
    expect(input.type).toBe('password');
  });
});
