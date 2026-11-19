import { describe, expect, it } from 'vitest';
import { SECTION_TYPES, type Locale, type Section, type SectionType } from '../site-model';
import { renderSection } from './components';
import { richModel } from './fixtures';
import { makeCtx } from './page';
import { validateHtml } from './validate';

/** One representative section per component, taken from the rich fixture. */
const SAMPLE: Record<SectionType, string> = {
  hero: 'hero1',
  text: 'intro',
  image: 'pic',
  gallery: 'gal',
  features: 'feat',
  pricing: 'price',
  testimonials: 'test',
  faq: 'faq1',
  contact_form: 'form1',
  map: 'map1',
  stats: 'nums',
  cta: 'cta1',
  steps: 'how',
};

function render(type: SectionType, locale: Locale, formsBase = ''): string {
  const model = richModel();
  const page = model.pages.find((p) => p.sections.some((s) => s.id === SAMPLE[type]))!;
  const section = page.sections.find((s) => s.id === SAMPLE[type])!;
  const ctx = makeCtx(
    model,
    locale,
    page,
    { baseUrl: undefined, formsBase, previewBanner: false },
    [],
  );
  const html = renderSection(ctx, section);
  expect(ctx.issues).toEqual([]);
  return `${html}\n`;
}

describe('component snapshots', () => {
  for (const type of SECTION_TYPES)
    for (const locale of ['ar', 'en'] as const)
      it(`${type} (${locale})`, () => {
        expect(render(type, locale)).toMatchSnapshot();
      });
});

describe('every component', () => {
  it('has a sample and a renderer', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...SECTION_TYPES].sort());
  });
  for (const type of SECTION_TYPES)
    for (const locale of ['ar', 'en'] as const)
      it(`${type} (${locale}) is a valid fragment, one <section id="s-…"> element`, () => {
        const html = render(type, locale);
        expect(validateHtml(html, { fragment: true })).toEqual([]);
        expect(html.startsWith(`<section id="s-${SAMPLE[type]}" class="sec sec-${type} `)).toBe(
          true,
        );
        expect(html.trimEnd().endsWith('</section>')).toBe(true);
        expect(html).not.toMatch(/\sstyle=|\son[a-z]+=|<script|javascript:/i);
      });

  it('list sections get a visually hidden default heading when the model gives none', () => {
    const model = richModel();
    const feat = model.pages[0]!.sections.find((s) => s.type === 'features')!;
    delete feat.props.heading;
    const ctx = makeCtx(model, 'en', model.pages[0]!, { formsBase: '', previewBanner: false }, []);
    const html = renderSection(ctx, feat);
    expect(html).toContain('<h2 id="h-feat" class="sr-only">Features</h2>');
    const ar = renderSection({ ...ctx, locale: 'ar' }, feat);
    expect(ar).toContain('<h2 id="h-feat" class="sr-only">المزايا</h2>');
  });
  it('a hero without an image has no media column; without a CTA link has no button', () => {
    const model = richModel();
    const hero: Section = { id: 'h2', type: 'hero', props: { heading: { ar: 'ع', en: 'H' } } };
    const ctx = makeCtx(model, 'en', model.pages[0]!, { formsBase: '', previewBanner: false }, []);
    const html = renderSection(ctx, hero);
    expect(html).not.toContain('has-media');
    expect(html).not.toContain('<a ');
  });
  it('the CTA falls back to a default label', () => {
    const model = richModel();
    const hero: Section = {
      id: 'h2',
      type: 'hero',
      props: { heading: { ar: 'ع', en: 'H' }, cta: { pageId: 'about' } },
    };
    const ctx = makeCtx(model, 'ar', model.pages[0]!, { formsBase: '', previewBanner: false }, []);
    expect(renderSection(ctx, hero)).toMatch(
      /<a class="btn [^"]*" href="\/ar\/about\/">اعرف المزيد<\/a>/,
    );
  });
  it('contact_form action follows formsBase', () => {
    expect(render('contact_form', 'en', 'https://f.example.com')).toContain(
      'action="https://f.example.com/v1/public/forms/contact"',
    );
  });
});
