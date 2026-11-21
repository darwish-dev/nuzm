import { describe, expect, it } from 'vitest';
import { DOC, GUIDES, doc, guideBySlug, type Block } from './docs-content';
import type { L } from './site-content';

const texts = (b: Block): L[] => {
  switch (b.t) {
    case 'p':
    case 'h':
    case 'note':
      return [b.v];
    case 'ul':
      return b.v;
    case 'table':
      return [...b.head, ...b.rows.flat()];
    default:
      return [];
  }
};
const all = (): { where: string; v: L }[] => [
  ...Object.entries(DOC).map(([k, v]) => ({ where: `DOC.${k}`, v })),
  ...GUIDES.flatMap((g) => [
    { where: `${g.slug}.title`, v: g.title },
    { where: `${g.slug}.summary`, v: g.summary },
    ...g.blocks.flatMap((b, i) => texts(b).map((v) => ({ where: `${g.slug}[${i}]`, v }))),
  ]),
];

describe('developer guides', () => {
  it('have Arabic and English text everywhere, and unique slugs', () => {
    const slugs = GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const { where, v } of all()) {
      expect(v.en.trim(), `${where} en`).not.toBe('');
      expect(v.ar.trim(), `${where} ar`).not.toBe('');
      expect(/\p{Script=Arabic}/u.test(v.ar), `${where} is Arabic`).toBe(true);
    }
    expect(guideBySlug('quickstart')).toBeTruthy();
    expect(guideBySlug('nope')).toBeUndefined();
  });

  it('keep the same inline code in both languages (a translation cannot change an endpoint or header)', () => {
    const ticks = (s: string) => (s.match(/`[^`]+`/g) ?? []).sort();
    for (const { where, v } of all()) expect(ticks(v.ar), where).toEqual(ticks(v.en));
  });

  it('use placeholders, never a real host or key', () => {
    for (const g of GUIDES)
      for (const b of g.blocks)
        if (b.t === 'code') {
          expect(b.v).not.toMatch(/nzk_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,}/);
          expect(b.v).not.toMatch(/https?:\/\/(?!example\.com)[a-z0-9.-]*nuzm/i);
        }
  });

  it('promise nothing the contract does not state: no rate-limit headers, no prices, no uptime', () => {
    const banned = /RateLimit-|X-RateLimit|\d+\s?%|uptime|guarantee|certified|compliant|\bfree\b/i;
    for (const { where, v } of all()) expect(v.en, where).not.toMatch(banned);
  });

  it('doc() throws on an unknown key', () => {
    expect(doc('developers', 'en')).toBe('Developers');
    expect(() => doc('missing', 'en')).toThrow();
  });
});
