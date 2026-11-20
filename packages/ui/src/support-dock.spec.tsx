// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleFrame, SupportToggle, useSupportDock } from './client';

vi.mock('next/navigation', () => ({ usePathname: () => '/en' }));
afterEach(cleanup);

function Close() {
  const d = useSupportDock();
  return (
    <button type="button" onClick={d.close}>
      close-inside
    </button>
  );
}
const frame = (withSupport = true) => (
  <ConsoleFrame
    labels={{ openMenu: 'menu', closeMenu: 'close menu' }}
    brand={<b>brand</b>}
    rail={<nav>rail</nav>}
    topbar={<SupportToggle label="Open support" />}
    support={withSupport ? { label: 'Support', content: <Close /> } : undefined}
  >
    <p>page</p>
  </ConsoleFrame>
);

describe('the docked support panel', () => {
  it('is closed at first; the top bar button opens it beside the page (beside the dashboard frame, not inside it) and closes it again', () => {
    const { container } = render(frame());
    const panel = container.querySelector('#nzc-support') as HTMLElement;
    const btn = screen.getByRole('button', { name: 'Open support' });
    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.nzc-main')?.getAttribute('data-support')).toBeNull();
    fireEvent.click(btn);
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.nzc-main')?.getAttribute('data-support')).toBe('open');
    expect(screen.getByRole('complementary', { name: 'Support' })).toBeTruthy();
    // the panel is a sibling of the dashboard's frame, so it sits on the system background, not on the frame's own
    expect(panel.parentElement?.classList.contains('nzc-main')).toBe(true);
    expect(container.querySelector('.nzc-frame')?.contains(panel)).toBe(false);
    fireEvent.click(btn);
    expect(panel.hidden).toBe(true);
  });
  it('closes with Escape and from a control inside the panel', () => {
    const { container } = render(frame());
    const panel = container.querySelector('#nzc-support') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    fireEvent.click(screen.getByText('close-inside'));
    expect(panel.hidden).toBe(true);
  });
  it('a console without a support panel has no aside, and the toggle does nothing harmful', () => {
    const { container } = render(frame(false));
    expect(container.querySelector('#nzc-support')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    expect(container.querySelector('.nzc-main')?.getAttribute('data-support')).toBeNull();
  });
});
