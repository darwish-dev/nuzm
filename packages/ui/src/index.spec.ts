import { describe, expect, it } from 'vitest';
import { baseCss, consoleCss, cssVariables, tokens } from './index';

describe('ui tokens', () => {
  it('emits css variables for every token', () => {
    const css = cssVariables();
    expect(css).toContain('--nuzm-color-accent: #2563eb;');
    expect(css).toContain('--nuzm-space-4: 16px;');
    expect(css.match(/--nuzm-/g)?.length).toBe(
      Object.values(tokens).reduce((n, g) => n + Object.keys(g).length, 0),
    );
  });
  it('contains no physical left/right properties', () => {
    expect(cssVariables()).not.toMatch(/left|right/);
  });
  it('base stylesheet uses logical properties only (RTL by dir, not by overrides)', () => {
    expect(baseCss).not.toMatch(
      /(?<![a-z-])(left|right)\s*:|margin-(left|right)|padding-(left|right)|border-(left|right)|text-align:\s*(left|right)/,
    );
  });
  it('the console stylesheet also uses logical properties only, and defines both themes', () => {
    expect(consoleCss).not.toMatch(
      /(?<![a-z-])(left|right)\s*:|margin-(left|right)|padding-(left|right)|border-(left|right)|text-align:\s*(left|right)/,
    );
    expect(consoleCss).toContain('.nzc[data-theme="light"]');
    expect(consoleCss).toContain('--nzc-bg: #0b0b0c;');
    expect(consoleCss).toContain('prefers-reduced-motion');
  });
  it('entering and leaving a full-screen page eases: the chrome, frame and background are separate transition layers, each name used once, and the chrome keeps the browser cross-fade so two identical pages never flicker', () => {
    for (const n of ['nzc-app', 'nzc-top', 'nzc-rail', 'nzc-frame', 'nzc-content'])
      expect(consoleCss.match(new RegExp(`view-transition-name: ${n};`, 'g')), n).toHaveLength(1);
    // a custom fade on both snapshots of a layer that is the same on both pages would dip it half transparent
    expect(consoleCss).not.toMatch(/view-transition-(old|new)\(nzc-(top|rail|frame)\)\s*\{/);
    expect(consoleCss).toContain('@view-transition { navigation: auto; }');
  });
});
