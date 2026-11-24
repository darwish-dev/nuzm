import { describe, expect, it } from 'vitest';
import { landingText } from './landing-text';

const strings = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(strings)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(strings)
        : [];

describe('landing text', () => {
  const en = landingText('en');
  const ar = landingText('ar');

  it('has the same shape in both languages (same keys, same list lengths)', () => {
    const shape = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(shape)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
          : 'text';
    expect(shape(ar)).toEqual(shape(en));
  });

  it('is written in Arabic in the Arabic text, and never blank', () => {
    const keep = new Set(['ERP', 'CRM']); // technical names that stay in Latin letters
    for (const s of strings(ar)) {
      expect(s.trim().length).toBeGreaterThan(0);
      if (!keep.has(s)) expect(/\p{Script=Arabic}/u.test(s), s).toBe(true);
    }
    for (const s of strings(en)) expect(s.trim().length).toBeGreaterThan(0);
  });

  it('makes no claim the platform cannot back (no price, uptime, guarantee, certification)', () => {
    const banned =
      /\d+\s?%|[$€£]\s?\d|uptime|guarantee|24\/7|certified|compliant|\bfree\b|ضمان|معتمد|ممتثل|مجاني/i;
    for (const s of [...strings(en), ...strings(ar)]) expect(s).not.toMatch(banned);
  });
});
