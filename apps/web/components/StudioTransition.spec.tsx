// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudioTransition, isStudioPath } from './StudioTransition';

const swap = (to: string | null) => {
  const skip = vi.fn();
  const e = Object.assign(new Event('pageswap'), {
    viewTransition: { skipTransition: skip },
    activation: to ? { entry: { url: new URL(to, location.href).toString() } } : null,
  });
  window.dispatchEvent(e);
  return skip;
};

describe('AI Studio transition', () => {
  it('knows the studio pages', () => {
    expect(isStudioPath('/builder/projects')).toBe(true);
    expect(isStudioPath('/en/builder/projects/1')).toBe(true);
    expect(isStudioPath('/mobile/x')).toBe(true);
    expect(isStudioPath('/console')).toBe(false);
    expect(isStudioPath('/builders')).toBe(false);
  });

  it('animates only opening and closing AI Studio', () => {
    window.history.replaceState(null, '', '/console');
    const { unmount } = render(<StudioTransition />);
    expect(swap('/builder/projects')).not.toHaveBeenCalled(); // opening
    expect(swap('/domains')).toHaveBeenCalled(); // an ordinary page change
    expect(swap(null)).toHaveBeenCalled(); // reload / unknown destination
    window.history.replaceState(null, '', '/builder/projects');
    expect(swap('/console')).not.toHaveBeenCalled(); // closing
    expect(swap('/builder/projects/1')).toHaveBeenCalled(); // inside the studio
    unmount();
    window.history.replaceState(null, '', '/');
  });
});
