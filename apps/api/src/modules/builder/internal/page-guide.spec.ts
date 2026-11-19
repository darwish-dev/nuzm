import { describe, expect, it } from 'vitest';
import { SECTION_TYPES, getTemplate, type SiteModel } from '@nuzm/domain';
import { DESIGN_RULES, checkPageResult, sectionGuide } from './page-guide';

describe('page guide: the agent is told the exact components, taken from the model specs', () => {
  const guide = sectionGuide();
  it('lists every component type with its real prop names and list sizes', () => {
    for (const t of SECTION_TYPES) expect(guide, t).toContain(`- ${t}:`);
    expect(guide).toContain('stats: 2..6 items');
    expect(guide).toContain('value (plain string)');
    expect(guide).toContain('steps: 2..8 items');
    expect(guide).toContain('heading (text, required)'); // hero and cta
    expect(guide).toContain('cta (link');
  });
  it('carries the design rules the output is judged on', () => {
    expect(DESIGN_RULES).toContain('ALWAYS has heading, subheading, ctaLabel');
    expect(DESIGN_RULES).toContain('6 to 8 sections');
    expect(DESIGN_RULES).toContain('Never invent');
  });
});

describe('page check: a page is validated like the finished site, before the run goes on', () => {
  const base = getTemplate('services')!.build({
    name: { ar: 'نظم', en: 'Nuzm' },
    locales: ['ar', 'en'],
  });
  const assemble = (page: unknown): SiteModel => ({
    ...base,
    pages: [{ ...base.pages[0]!, ...(page as object) }],
  });
  it('passes a complete page', () => {
    expect(
      checkPageResult(
        assemble,
        {},
        base.pages.map((p) => p.id),
      ),
    ).toEqual([]);
  });
  it('reports a text written in one language only, so the model can repair it', () => {
    const home = base.pages[0]!;
    const hero = home.sections[0]!;
    const bad = {
      sections: [{ ...hero, props: { ...hero.props, heading: { en: 'Only English' } } }],
    };
    const errs = checkPageResult(
      assemble,
      bad,
      base.pages.map((p) => p.id),
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('heading');
  });
  it('lets a link point at a planned page that is not written yet, and refuses one that is not planned', () => {
    const hero = base.pages[0]!.sections[0]!;
    const link = (pageId: string) => ({
      sections: [{ ...hero, props: { ...hero.props, cta: { pageId } } }],
    });
    expect(checkPageResult(assemble, link('contact'), ['home', 'contact'])).toEqual([]);
    const errs = checkPageResult(assemble, link('pricing-plans'), ['home', 'contact']);
    expect(errs.join(' ')).toContain('"pricing-plans" is not a page of this site');
  });
});
