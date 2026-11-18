import { describe, expect, it } from 'vitest';
import { bindCollections } from './cms';
import { TEMPLATES } from './templates';
import { validateSiteModel } from './site-model';

describe('CMS binding', () => {
  const base = () => {
    const m = TEMPLATES.find((t) => t.id === 'restaurant')!.build({
      name: { ar: 'م', en: 'R' },
      locales: ['ar', 'en'],
    });
    const faq = m.pages.flatMap((p) => p.sections).find((s) => s.type === 'faq')!;
    faq.props.collection = 'faqs';
    return { m, faq };
  };
  it('replaces the section items with PUBLISHED items for every declared locale and stays valid', () => {
    const { m, faq } = base();
    expect(validateSiteModel(m)).toEqual([]);
    const out = bindCollections(m, [
      {
        key: 'faqs',
        items: [{ data: { question: 'Open on Friday?', answer: { ar: 'نعم', en: 'Yes' } } }],
      },
    ]);
    const bound = out.pages.flatMap((p) => p.sections).find((s) => s.id === faq.id)!;
    expect((bound.props.items as { question: { ar: string; en: string } }[])[0]!.question).toEqual({
      ar: 'Open on Friday?',
      en: 'Open on Friday?',
    });
    expect(validateSiteModel(out)).toEqual([]);
    expect(JSON.stringify(m)).not.toContain('Open on Friday'); // the input is not mutated
  });
  it('keeps the placeholder items when nothing is published', () => {
    const { m } = base();
    expect(bindCollections(m, [{ key: 'faqs', items: [] }])).toEqual(m);
    expect(bindCollections(m, [])).toEqual(m);
  });
});
