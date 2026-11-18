import { describe, expect, it } from 'vitest';
import { applyOps, OP_KINDS, OpInvalid, type Op } from './ops';
import { TEMPLATES } from './templates';
import { validateSiteModel, type SiteModel } from './site-model';

const base = (id = 'restaurant'): SiteModel =>
  TEMPLATES.find((t) => t.id === id)!.build({
    name: { ar: 'مخبز', en: 'Bakery' },
    locales: ['ar', 'en'],
  });

// small deterministic PRNG so a failing sequence can be replayed
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!;

function randomOp(m: SiteModel, r: () => number, n: number): Op {
  const page = pick(r, m.pages);
  const sec = page.sections.length ? pick(r, page.sections) : undefined;
  const kind = pick(r, [
    ...OP_KINDS,
    'bogus',
    'insertComponent',
    'setText',
    'updateProps',
    'moveComponent',
  ]);
  const loc = pick(r, ['ar', 'en'] as const);
  switch (kind) {
    case 'insertComponent':
      return {
        op: 'insertComponent',
        pageId: r() < 0.9 ? page.id : 'nope',
        index: Math.floor(r() * 6),
        section: {
          id: `x${n}`,
          type: 'text',
          props: { body: r() < 0.9 ? { ar: 'نص', en: 'text' } : { en: 'only english' } },
        },
      };
    case 'updateProps':
      return {
        op: 'updateProps',
        pageId: page.id,
        sectionId: sec?.id ?? 'nope',
        props: pick(r, [
          { heading: { ar: 'عنوان', en: 'Heading' } },
          { heading: null },
          { bogus: 1 },
          { body: { ar: 'س', en: 's' } },
        ]),
      };
    case 'moveComponent':
      return {
        op: 'moveComponent',
        pageId: page.id,
        sectionId: sec?.id ?? 'nope',
        index: Math.floor(r() * 5),
        ...(r() < 0.3 ? { toPageId: pick(r, m.pages).id } : {}),
      };
    case 'deleteComponent':
      return { op: 'deleteComponent', pageId: page.id, sectionId: sec?.id ?? 'nope' };
    case 'setTokens':
      return {
        op: 'setTokens',
        tokens: { radius: pick(r, ['none', 'sm', 'lg']) },
        colors: { primary: pick(r, ['#112233', null, '#abc']) },
      };
    case 'setText':
      return r() < 0.5
        ? {
            op: 'setText',
            target: pick(r, ['brandName', 'siteTitle', 'footerText', 'siteDescription'] as const),
            locale: loc,
            value: r() < 0.8 ? `v${n}` : null,
          }
        : { op: 'setText', target: 'pageTitle', pageId: page.id, locale: loc, value: `t${n}` };
    case 'addPage':
      return {
        op: 'addPage',
        nav: r() < 0.5,
        page: { id: `p${n}`, slug: `p-${n}`, title: { ar: 'صفحة', en: 'Page' }, sections: [] },
      };
    case 'deletePage':
      return { op: 'deletePage', pageId: page.id };
    case 'updatePage':
      return {
        op: 'updatePage',
        pageId: page.id,
        ...(r() < 0.5
          ? { slug: `s-${n}` }
          : { seo: r() < 0.5 ? null : { title: { ar: 'ع', en: 'e' } } }),
      };
    case 'setSeo':
      return {
        op: 'setSeo',
        seo: {
          description: { ar: 'وصف', en: 'desc' },
          baseUrl: pick(r, ['https://example.test', null]),
        },
      };
    case 'setNav':
      return { op: 'setNav', items: m.nav.items.slice(0, Math.floor(r() * 4)) };
    case 'addAsset':
      return {
        op: 'addAsset',
        asset: {
          id: `a${n}`,
          kind: 'image',
          source: 'placeholder',
          alt: { ar: 'صورة', en: 'image' },
        },
      };
    case 'removeAsset':
      return { op: 'removeAsset', assetId: m.assets.length ? pick(r, m.assets).id : 'nope' };
    default:
      return { op: 'bogus' } as unknown as Op;
  }
}

describe('editor operations', () => {
  it('rejects unknown ops, malformed ops and empty or oversized sets', () => {
    const m = base();
    expect(() => applyOps(m, [])).toThrow(OpInvalid);
    expect(() => applyOps(m, [{ op: 'nope' }])).toThrow(/unknown operation/);
    expect(() => applyOps(m, [{ op: 'deleteComponent', pageId: 'home' }])).toThrow(/malformed/);
    expect(() =>
      applyOps(
        m,
        Array.from({ length: 201 }, () => ({ op: 'setNav', items: [] })),
      ),
    ).toThrow(OpInvalid);
  });
  it('is atomic: an op set with one bad op changes nothing (the input is never mutated)', () => {
    const m = base();
    const copy = JSON.stringify(m);
    expect(() =>
      applyOps(m, [
        { op: 'setText', target: 'brandName', locale: 'en', value: 'New' },
        { op: 'deleteComponent', pageId: 'home', sectionId: 'missing' },
      ]),
    ).toThrow(OpInvalid);
    expect(JSON.stringify(m)).toBe(copy);
  });
  it('refuses a result that is not a valid model (half-translated text, dangling link) and names the issues', () => {
    const m = base();
    try {
      applyOps(m, [{ op: 'setText', target: 'brandName', locale: 'en', value: null }]);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(OpInvalid);
      expect((e as OpInvalid).issues.length).toBeGreaterThan(0);
    }
    const about = m.pages.find(
      (p) => p.slug !== 'home' && m.nav.items.some((n) => n.pageId === p.id),
    )!;
    // deleting a page that a hero button links to is refused rather than silently repaired
    const withLink = applyOps(m, [
      {
        op: 'updateProps',
        pageId: 'home',
        sectionId: m.pages[0]!.sections[0]!.id,
        props: { cta: { pageId: about.id }, ctaLabel: { ar: 'اذهب', en: 'Go' } },
      },
    ]).model;
    expect(() => applyOps(withLink, [{ op: 'deletePage', pageId: about.id }])).toThrow(OpInvalid);
  });
  it('produces a safe diff with risk flags', () => {
    const m = base();
    const del = applyOps(m, [
      {
        op: 'deleteComponent',
        pageId: 'home',
        sectionId: m.pages[0]!.sections[m.pages[0]!.sections.length - 1]!.id,
      },
    ]);
    expect(del.risks.map((r) => r.code)).toContain('deletes_component');
    expect(del.lowRisk).toBe(false);
    const t = applyOps(m, [{ op: 'setText', target: 'brandName', locale: 'en', value: 'Renamed' }]);
    expect(t.diff.text).toEqual([
      { path: 'brand.name', locale: 'en', before: 'Bakery', after: 'Renamed' },
    ]);
    expect(t.lowRisk).toBe(true);
    const slug = applyOps(m, [{ op: 'updatePage', pageId: m.pages[1]!.id, slug: 'renamed-slug' }]);
    expect(slug.risks.map((r) => r.code)).toContain('changes_slug');
    const seo = applyOps(
      m,
      m.pages.slice(0, 3).map((p) => ({
        op: 'updatePage' as const,
        pageId: p.id,
        seo: { description: { ar: 'وصف جديد', en: 'new description' } },
      })),
    );
    expect(seo.risks.find((r) => r.code === 'changes_seo')?.count).toBe(3);
  });
  it('deleting a page removes its navigation entries and undo restores them exactly', () => {
    const m = base();
    const p = m.pages.find((x) => x.slug !== 'home' && m.nav.items.some((n) => n.pageId === x.id))!;
    const r = applyOps(m, [{ op: 'deletePage', pageId: p.id }]);
    expect(r.risks.map((x) => x.code)).toContain('deletes_page');
    expect(r.model.nav.items.some((n) => n.pageId === p.id)).toBe(false);
    expect(applyOps(r.model, r.inverse).model).toEqual(m);
  });
  it('the home page cannot be deleted or renamed', () => {
    const m = base();
    expect(() =>
      applyOps(m, [{ op: 'deletePage', pageId: m.pages.find((p) => p.slug === 'home')!.id }]),
    ).toThrow(/home/);
    expect(() =>
      applyOps(m, [
        { op: 'updatePage', pageId: m.pages.find((p) => p.slug === 'home')!.id, slug: 'start' },
      ]),
    ).toThrow(/home/);
  });

  it('fuzz: 1000 random op sequences never yield an invalid model; undo restores the start and redo the result (AC-M09-07)', () => {
    let accepted = 0;
    let rejected = 0;
    for (let seq = 0; seq < 1000; seq++) {
      const r = rng(seq + 1);
      let m = base(
        pick(
          r,
          TEMPLATES.map((t) => t.id),
        ),
      );
      for (let step = 0; step < 4; step++) {
        const ops = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) =>
          randomOp(m, r, seq * 100 + step * 10 + k),
        );
        let res;
        try {
          res = applyOps(m, ops);
        } catch (e) {
          expect(e, JSON.stringify(ops)).toBeInstanceOf(OpInvalid);
          rejected++;
          continue;
        }
        accepted++;
        expect(validateSiteModel(res.model), JSON.stringify(ops)).toEqual([]);
        const undone = applyOps(res.model, res.inverse);
        expect(undone.model, `undo of ${JSON.stringify(ops)}`).toEqual(m);
        if (seq % 4 === 0) {
          const redone = applyOps(undone.model, undone.inverse);
          expect(redone.model, `redo of ${JSON.stringify(ops)}`).toEqual(res.model);
        }
        m = res.model;
      }
    }
    expect(accepted).toBeGreaterThan(500);
    expect(rejected).toBeGreaterThan(300);
  }, 240_000);
});
