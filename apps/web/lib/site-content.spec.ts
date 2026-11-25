import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICES, SITE, pick, serviceBySlug, site, type L } from './site-content';

const texts = (): { where: string; v: L }[] => [
  ...Object.entries(SITE).map(([k, v]) => ({ where: `SITE.${k}`, v })),
  ...SERVICES.flatMap((s) => [
    { where: `${s.slug}.name`, v: s.name },
    { where: `${s.slug}.tagline`, v: s.tagline },
    { where: `${s.slug}.headline`, v: s.headline },
    { where: `${s.slug}.intro`, v: s.intro },
    ...(s.note ? [{ where: `${s.slug}.note`, v: s.note }] : []),
    ...s.points.flatMap((p, i) => [
      { where: `${s.slug}.points[${i}].title`, v: p.title },
      { where: `${s.slug}.points[${i}].text`, v: p.text },
    ]),
    ...s.steps.flatMap((p, i) => [
      { where: `${s.slug}.steps[${i}].title`, v: p.title },
      { where: `${s.slug}.steps[${i}].text`, v: p.text },
    ]),
    ...s.faq.flatMap((p, i) => [
      { where: `${s.slug}.faq[${i}].q`, v: p.q },
      { where: `${s.slug}.faq[${i}].a`, v: p.a },
    ]),
  ]),
];

describe('public site content', () => {
  it('has an Arabic and an English text everywhere', () => {
    for (const { where, v } of texts()) {
      expect(v.ar.trim().length, `${where} (ar)`).toBeGreaterThan(0);
      expect(v.en.trim().length, `${where} (en)`).toBeGreaterThan(0);
      // the language switch names the OTHER language, so on the Arabic page it reads "English"
      if (where !== 'SITE.language')
        expect(/\p{Script=Arabic}/u.test(v.ar), `${where} is Arabic`).toBe(true);
    }
  });

  it('has unique, URL-safe slugs that serviceBySlug finds', () => {
    const slugs = SERVICES.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of SERVICES) {
      expect(s.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(serviceBySlug(s.slug)).toBe(s);
    }
    expect(serviceBySlug('nope')).toBeUndefined();
  });

  it('each service opens a console page that exists', () => {
    for (const s of SERVICES) {
      expect(s.href.startsWith('/')).toBe(true);
      expect(
        existsSync(join(__dirname, '..', 'app', '[locale]', '(console)', s.href, 'page.tsx')),
        `${s.slug} -> ${s.href}`,
      ).toBe(true);
    }
  });

  it('makes no claim the platform cannot back: no price, discount, guarantee, uptime, count or compliance word', () => {
    const banned =
      /\d+\s?%|[$€£]\s?\d|\d\s?(SAR|USD)\b|\b99\.\d|uptime|guarantee|money-back|24\/7|certified|compliant|complies|\bfree\b|\bunlimited\b|ضمان|معتمد|ممتثل|مجاني|غير محدود|\d{2,}\s?(ألف|مليون|million|customers|عميل)/i;
    for (const { where, v } of texts()) {
      expect(v.en, `${where} (en)`).not.toMatch(banned);
      expect(v.ar, `${where} (ar)`).not.toMatch(banned);
    }
  });

  it('does not promise .sa domains or a Saudi region before they are verified', () => {
    const domains = serviceBySlug('domains')!;
    expect(pick(domains.note!, 'en')).toMatch(/not sold yet/);
    const cloud = serviceBySlug('cloud')!;
    expect(pick(cloud.faq[0]!.a, 'en')).toMatch(/only when/);
  });

  it('site() throws for an unknown key instead of rendering "undefined"', () => {
    expect(site('start', 'en')).toBe('Get started');
    expect(site('start', 'ar')).toBe('ابدأ الآن');
    expect(() => site('missing', 'en')).toThrow();
  });

  it('every service has an illustration that exists', () => {
    const exists = (url: string) => existsSync(join(__dirname, '..', 'public', url));
    for (const sv of SERVICES) expect(exists(sv.image), sv.slug).toBe(true);
  });
});
