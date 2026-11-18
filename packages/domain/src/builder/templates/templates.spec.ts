import { describe, expect, it } from 'vitest';
import { BUSINESS_TYPES } from '../artifacts';
import {
  LOCALES,
  SECTION_TYPES,
  validateSiteModel,
  type Locale,
  type SiteModel,
} from '../site-model';
import { TEMPLATES, getTemplate, templateForBusinessType } from './index';

/* local WCAG 2.1 contrast helper (the renderer has its own; tests must not import it) */
const lum = (hex: string): number => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const NAME = { ar: 'نموذج الاختبار', en: 'Test Sample' };
const LOCALE_SETS: Locale[][] = [['ar', 'en'], ['ar'], ['en']];
const AR = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

/** every `{ar?, en?}` object in a model with its path */
function localizedObjects(v: unknown, path = '$', out: [string, Record<string, string>][] = []) {
  if (Array.isArray(v)) v.forEach((x, i) => localizedObjects(x, `${path}[${i}]`, out));
  else if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    if (keys.length > 0 && keys.every((k) => k === 'ar' || k === 'en'))
      out.push([path, v as Record<string, string>]);
    else for (const [k, x] of Object.entries(v)) localizedObjects(x, `${path}.${k}`, out);
  }
  return out;
}

describe('template library', () => {
  it('has at least 8 templates with unique ids, versions >= 1 and one per category', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(t.version).toBeGreaterThanOrEqual(1);
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    for (const c of BUSINESS_TYPES.filter((b) => b !== 'other'))
      expect(templateForBusinessType(c).category).toBe(c);
    expect(templateForBusinessType('other').id).toBe('services');
    expect(getTemplate('restaurant')?.id).toBe('restaurant');
    expect(getTemplate('nope')).toBeUndefined();
  });

  it('uses every component type in at least two templates', () => {
    const count = new Map<string, Set<string>>();
    for (const t of TEMPLATES)
      for (const p of t.build({ name: NAME, locales: ['ar', 'en'] }).pages)
        for (const s of p.sections)
          (count.get(s.type) ?? count.set(s.type, new Set()).get(s.type)!).add(t.id);
    for (const type of SECTION_TYPES)
      expect(count.get(type)?.size ?? 0, type).toBeGreaterThanOrEqual(2);
  });

  for (const t of TEMPLATES) {
    describe(t.id, () => {
      for (const locales of LOCALE_SETS) {
        it(`builds a valid model for ${locales.join('+')}`, () => {
          const m = t.build({ name: NAME, locales });
          expect(validateSiteModel(m)).toEqual([]);
          expect(m.locales).toEqual(locales);
          expect(m.defaultLocale).toBe(locales[0]);
          if (t.id === 'landing') {
            expect(m.pages).toHaveLength(1);
            expect(m.pages[0]!.sections.length).toBeGreaterThanOrEqual(6);
          } else {
            expect(m.pages.length).toBeGreaterThanOrEqual(3);
            expect(m.pages.length).toBeLessThanOrEqual(5);
          }
          expect(m.pages.map((p) => p.id)).toEqual(t.pageKinds);
          // every declared locale present, every other locale absent, in every localized text
          for (const [path, o] of localizedObjects(m)) {
            for (const l of LOCALES) {
              if (locales.includes(l)) expect(o[l]?.trim(), `${path}.${l}`).toBeTruthy();
              else expect(o[l], `${path}.${l}`).toBeUndefined();
            }
          }
          const json = JSON.stringify(m);
          if (!locales.includes('en')) expect(json).not.toContain('"en":');
          if (!locales.includes('ar')) {
            expect(json).not.toContain('"ar":');
            expect(AR.test(json)).toBe(false);
          }
          // plain-string fields follow the default locale
          for (const p of m.pages)
            for (const s of p.sections) {
              const plain: string[] = [];
              if (s.type === 'map') plain.push(s.props.query as string);
              if (s.type === 'testimonials')
                for (const it of s.props.items as { author: string }[]) plain.push(it.author);
              for (const x of plain)
                expect(locales[0] === 'ar' ? AR.test(x) : LATIN.test(x), `${s.id}: ${x}`).toBe(
                  true,
                );
            }
          for (const a of m.assets)
            expect(locales[0] === 'ar' ? AR.test(a.label ?? '') : LATIN.test(a.label ?? '')).toBe(
              true,
            );
        });
      }

      it('has native Arabic and English text (no swapped fields)', () => {
        const m = t.build({ name: NAME, locales: ['ar', 'en'] });
        for (const [path, o] of localizedObjects(m)) {
          expect(AR.test(o.ar ?? ''), `${path}.ar`).toBe(true);
          expect(LATIN.test(o.en ?? ''), `${path}.en`).toBe(true);
          expect(AR.test(o.en ?? ''), `${path}.en has Arabic`).toBe(false);
        }
      });

      it('is complete: assets for every image, forms, nav, footer, seo, contrast', () => {
        const m = t.build({ name: NAME, locales: ['ar', 'en'] });
        expect(m.assets.length).toBeGreaterThan(0);
        for (const a of m.assets) {
          expect(a.source).toBe('placeholder');
          expect(a.label && a.label.length).toBeGreaterThan(0);
        }
        const used = new Set<string>();
        const collect = (v: unknown, k = ''): void => {
          if (Array.isArray(v)) v.forEach((x) => collect(x));
          else if (typeof v === 'object' && v !== null)
            for (const [key, x] of Object.entries(v)) collect(x, key);
          else if (typeof v === 'string' && (k === 'imageAssetId' || k === 'assetId')) used.add(v);
        };
        for (const p of m.pages) collect(p.sections);
        for (const id of used) expect(m.assets.some((a) => a.id === id)).toBe(true);
        for (const a of m.assets) expect(used.has(a.id), `unused asset ${a.id}`).toBe(true);
        // contact page => exactly one contact_form with the matching form
        const forms = m.pages.flatMap((p) => p.sections).filter((s) => s.type === 'contact_form');
        expect(forms).toHaveLength(1);
        expect(m.forms).toHaveLength(1);
        const f = m.forms[0]!;
        expect(forms[0]!.props.formId).toBe(f.id);
        expect(f.fields.map((x) => x.name)).toEqual(expect.arrayContaining(['name', 'message']));
        expect(f.fields.some((x) => x.type === 'email' || x.type === 'tel')).toBe(true);
        expect(m.nav.items.length).toBe(m.pages.length);
        for (const p of m.pages) {
          expect(p.seo?.title?.ar && p.seo.description?.en).toBeTruthy();
        }
        const c = m.brand.colors!;
        expect(contrast(c.text!, c.background!)).toBeGreaterThanOrEqual(4.5);
        expect(contrast('#ffffff', c.primary!)).toBeGreaterThanOrEqual(4.5);
        const specific: Record<string, string> = {
          restaurant: 'Restaurant',
          clinic: 'MedicalClinic',
          retail: 'Store',
          education: 'EducationalOrganization',
          ngo: 'NGO',
        };
        const type = m.seo.organization?.type ?? '';
        if (specific[t.category]) expect(type).toBe(specific[t.category]);
        else expect(['LocalBusiness', 'Organization']).toContain(type);
      });

      it('honours the name, colour overrides, baseUrl and ignores invalid input', () => {
        const m = t.build({
          name: { en: 'Only English' },
          locales: ['ar', 'en'],
          colors: { primary: '#123456', accent: 'red' },
          baseUrl: 'https://example.com',
        });
        expect(validateSiteModel(m)).toEqual([]);
        expect(m.brand.name).toEqual({ ar: 'Only English', en: 'Only English' });
        expect(m.brand.colors?.primary).toBe('#123456');
        expect(m.brand.colors?.accent).not.toBe('red');
        expect(m.seo.baseUrl).toBe('https://example.com');
        const bad = t.build({ name: NAME, locales: [], baseUrl: 'http://not-https.example' });
        expect(bad.seo.baseUrl).toBeUndefined();
        expect(bad.locales).toEqual(['ar', 'en']);
        const long = t.build({
          name: { ar: 'م'.repeat(200), en: 'x'.repeat(200) },
          locales: ['ar', 'en'],
        });
        expect(validateSiteModel(long)).toEqual([]);
      });

      it('is deterministic and does not share state between builds', () => {
        const a = t.build({ name: NAME, locales: ['ar', 'en'] });
        const b = t.build({ name: NAME, locales: ['ar', 'en'] });
        expect(b).toEqual(a);
        (a.pages[0]!.sections[0]!.props as Record<string, unknown>).heading = { ar: 'x', en: 'y' };
        expect(t.build({ name: NAME, locales: ['ar', 'en'] })).toEqual(b);
      });
    });
  }

  it('keeps the model type usable', () => {
    const m: SiteModel = TEMPLATES[0]!.build({ name: NAME, locales: ['ar'] });
    expect(m.schemaVersion).toBe(1);
  });
});
