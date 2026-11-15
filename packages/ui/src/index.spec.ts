import { describe, expect, it } from 'vitest';
import { cssVariables, tokens } from './index';

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
});
