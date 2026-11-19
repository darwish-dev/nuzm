// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountUp } from './client';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const visible = (c: HTMLElement) => c.querySelector('[aria-hidden="true"]')!.textContent;

describe('count-up figure', () => {
  it('keeps the final value for assistive technology, counts up from 0 and ends exactly on the value', () => {
    const { container } = render(<CountUp value={40} ms={800} />);
    expect(container.querySelector('.nz-sr')!.textContent).toBe('40');
    expect(visible(container)).toBe('0');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const mid = Number(visible(container));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(40);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(visible(container)).toBe('40');
  });
  it('does not animate for people who ask for reduced motion, and a zero stays zero', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const a = render(<CountUp value={40} />);
    expect(visible(a.container)).toBe('40');
    a.unmount();
    vi.unstubAllGlobals();
    const b = render(<CountUp value={0} />);
    expect(visible(b.container)).toBe('0');
  });
});
