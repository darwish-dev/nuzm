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
  it('has no cross-document view transition (it showed the background between pages) and keeps an opaque canvas', () => {
    expect(consoleCss).not.toContain('view-transition');
    expect(consoleCss).toContain('html:has(.nzc) { background: #0b0b0c; }');
  });
  it('the dashboard status column never gets a scroll bar of its own', () => {
    const rules = consoleCss.split('\n').filter((l) => /^\.nzc-status[\s{,.:-]/.test(l));
    expect(rules.length).toBeGreaterThan(5);
    expect(rules.join('\n')).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    expect(consoleCss).toContain('.nzc-status::-webkit-scrollbar');
    expect(consoleCss).toContain('.nzc-status, .nzc-status * { box-shadow: none !important;');
  });
  it('the dashboard cards have no stroke border', () => {
    expect(consoleCss).toContain('.nzc-dash-layout :is(.nz-card, .nzc-stat, .nzc-status-card');
    expect(consoleCss).toMatch(/\{ border: 0 !important; \}/);
  });
  it('the status column resource cards are white in light mode only, with dark text, and the attention card is not', () => {
    expect(consoleCss).toContain(
      '.nzc[data-theme="light"] .nzc-status-card:not(.nzc-status-attention) { background: #ffffff; color: #17181a;',
    );
    expect(consoleCss).not.toContain(
      '\n.nzc-status-card:not(.nzc-status-attention) { background: #ffffff;',
    );
  });
});
