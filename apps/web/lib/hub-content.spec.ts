import { describe, expect, it } from 'vitest';
import { CHANNELS, COMMUNITY_VALUES, COURSES, HUB, POSTS, POST_CATEGORIES } from './hub-content';
import { serviceBySlug } from './site-content';

const AR = /[؀-ۿ]/;
/** every { ar, en } pair in a value, with its path */
function pairs(v: unknown, path: string, out: [string, { ar: string; en: string }][] = []) {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.ar === 'string' && typeof o.en === 'string')
      out.push([path, o as { ar: string; en: string }]);
    else for (const [k, x] of Object.entries(o)) pairs(x, `${path}.${k}`, out);
  }
  return out;
}

describe('blog, academy and community content', () => {
  it('has an Arabic and an English text everywhere', () => {
    const all = pairs({ POSTS, COURSES, CHANNELS, COMMUNITY_VALUES, HUB, POST_CATEGORIES }, '');
    expect(all.length).toBeGreaterThan(100);
    for (const [path, t] of all) {
      expect(t.en.trim(), path).not.toBe('');
      expect(AR.test(t.ar), `${path} is Arabic`).toBe(true);
    }
  });
  it('has unique slugs and links every article and course to a real service', () => {
    expect(new Set(POSTS.map((p) => p.slug)).size).toBe(POSTS.length);
    expect(new Set(COURSES.map((c) => c.slug)).size).toBe(COURSES.length);
    for (const x of [...POSTS, ...COURSES]) expect(serviceBySlug(x.service), x.slug).toBeDefined();
  });
  it('marks a channel "coming soon" unless it has a real destination', () => {
    for (const c of CHANNELS) expect(Boolean(c.href), c.id).toBe(Boolean(c.action));
  });
});
