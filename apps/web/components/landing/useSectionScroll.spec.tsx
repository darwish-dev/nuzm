// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSectionScroll } from './useSectionScroll';

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useSectionScroll(ref);
  return (
    <div ref={ref} data-testid="root">
      <section>
        <input aria-label="Idea" />
        <a href="#next">Next section</a>
      </section>
      <section id="next" />
      <footer />
    </div>
  );
}
let clock = 1000;
beforeEach(() => {
  clock = 1000;
  window.history.replaceState(null, '', '/');
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const view = render(<Harness />);
  const root = view.getByTestId('root');
  const panels = Array.from(root.children) as HTMLElement[];
  panels.forEach((p, i) => {
    Object.defineProperties(p, {
      offsetTop: { value: i * 800 },
      clientHeight: { value: 800 },
      scrollHeight: { value: 800, configurable: true },
    });
  });
  const scroll = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    root.scrollTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0);
  });
  root.scrollTo = scroll;
  const wheel = (deltaY = 100, target: Element = root) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  return { root, panels, scroll, wheel, view };
}
describe('homepage section navigation', () => {
  it('consumes an entire wheel burst and only advances again after a new gesture', () => {
    const { wheel, scroll } = setup();
    wheel();
    expect(scroll).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' });
    for (let i = 0; i < 15; i++) {
      clock += 100;
      wheel();
    }
    expect(scroll).toHaveBeenCalledTimes(1);
    clock += 300;
    wheel();
    expect(scroll).toHaveBeenLastCalledWith({ top: 1600, behavior: 'smooth' });
    clock += 1000;
    wheel(-100);
    expect(scroll).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' });
  });
  it('keeps tall content readable and does not intercept editing or zooming', () => {
    const { root, panels, scroll, wheel, view } = setup();
    Object.defineProperty(panels[0], 'scrollHeight', { value: 1200 });
    expect(wheel().defaultPrevented).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    panels[0]!.scrollTop = 400;
    wheel(100, view.getByLabelText('Idea'));
    root.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(scroll).not.toHaveBeenCalled();
    clock += 300;
    wheel();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it('navigates anchors to the panel top without hiding its header', () => {
    const { panels, scroll, view } = setup();
    panels[1]!.scrollTop = 120;
    fireEvent.click(view.getByRole('link', { name: 'Next section' }));
    expect(panels[1]!.scrollTop).toBe(0);
    expect(scroll).toHaveBeenLastCalledWith({ top: 800, behavior: 'smooth' });
    expect(window.location.hash).toBe('#next');
  });
  it('moves one panel for a vertical swipe', () => {
    const { root, scroll } = setup();
    const touch = (name: string, y: number) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: name === 'touchend' ? [] : [{ clientX: 100, clientY: y }] },
        changedTouches: { value: [{ clientX: 100, clientY: y }] },
      });
      root.dispatchEvent(event);
    };
    act(() => {
      touch('touchstart', 400);
      touch('touchmove', 200);
      touch('touchend', 200);
    });
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 800, behavior: 'smooth' });
  });
});
