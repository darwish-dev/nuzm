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
});
