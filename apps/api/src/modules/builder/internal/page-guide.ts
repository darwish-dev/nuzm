import { SECTION_SPECS, SECTION_TYPES, validateSiteModel, type SectionType } from '@nuzm/domain';
import type { SiteModel } from '@nuzm/domain';

/**
 * What the page-writing agent is told about the components, generated from the site model's own specs (so the prompt and the validator can never drift apart): for
 * each type the exact prop names, which texts are required, and how many list items it takes.
 */
export function sectionGuide(): string {
  const lines = SECTION_TYPES.map((t: SectionType) => {
    const s = SECTION_SPECS[t];
    const parts: string[] = [];
    for (const k of Object.keys(s.loc ?? {})) parts.push(`${k} (text, required)`);
    for (const k of Object.keys(s.locOpt ?? {})) parts.push(`${k} (text)`);
    for (const k of Object.keys(s.strings ?? {})) parts.push(`${k} (plain string)`);
    for (const k of s.assets ?? []) parts.push(`${k} (placeholder image id)`);
    if (s.form) parts.push(`${s.form} (form id)`);
    for (const k of s.link ?? [])
      parts.push(`${k} (link: {"pageId":"<page id>"} or {"url":"https://..."})`);
    if (s.items) {
      const it = s.items;
      const f = [
        ...Object.keys(it.loc).map((k) => `${k} (text, required)`),
        ...Object.keys(it.locOpt ?? {}).map((k) => `${k} (text)`),
        ...Object.keys(it.strings ?? {}).map((k) => `${k} (plain string)`),
        ...(it.assets ?? []).map((k) => `${k} (placeholder image id)`),
      ];
      parts.push(`${it.prop}: ${it.min ?? 0}..${it.max} items, each {${f.join(', ')}}`);
    }
    return `- ${t}: ${parts.join('; ') || 'no props'}`;
  });
  return lines.join('\n');
}

/** The rules a designer would follow, as short instructions. */
export const DESIGN_RULES = [
  'A text is {"ar":"...","en":"..."} with a real translation in EACH language: never English words in the ar field or Arabic in the en field.',
  'Home page: 6 to 8 sections in a good rhythm, e.g. hero, stats or features, text or image, steps, testimonials, faq, then a closing cta. Inner pages: 3 to 5 sections.',
  'The hero ALWAYS has heading, subheading, ctaLabel, a cta link to an existing page id (or a #section-id of this page) and an imageAssetId; style {"align":"center"} when it has no image.',
  'Never put two sections of the same type next to each other. Alternate style.background between "default" and "muted"; use "primary" only for a cta or stats band.',
  'Headings are at most 8 words and say a benefit; every description is at most two short sentences. No filler such as "welcome to our website".',
  'Use only facts from the requirements. Never invent awards, certifications, prices, client names or statistics: where such content is needed, write obviously generic sample copy, and for stats values use "00" so the owner fills in the real figures.',
  'Section ids are unique lowercase kebab-case ("home-hero"). Use each placeholder image id once.',
  // P3-S04: what the automated website QA gates (axe ar/en, SEO, links, CSP, size) check, stated up front so the model does not have to be repaired into compliance
  'Accessibility (WCAG 2.1 AA): every page has exactly ONE hero or top heading; sections follow in order and never skip a level; every placeholder image has a descriptive alt in each language (what it shows, not "image"); link and button labels say where they go ("Book a visit", never "click here"); every form field has a visible label.',
  "SEO: each page gets its own title of 25 to 60 characters that names the page and the business, and its own description of 70 to 160 characters that says what the visitor finds there; never reuse one page's title or description on another.",
  'Arabic first: write the ar text as natural Arabic (not a literal translation), keep numbers and the brand name as given, and never rely on left or right in an instruction or a label (use start and end).',
  'A business site has at least five pages: home, about, services (or products or menu), one more content page (e.g. gallery, pricing or faq) and contact. The contact page has a contact_form. Every page is reachable from the navigation.',
  'Images are placeholders only: never reference an external image URL, never include a script, a style attribute or an embed, and never link to a third-party tracker or widget.',
].join('\n');

/**
 * The same check the editor applies to a finished site, run on ONE page so a wrong answer is sent back to the model before the run goes on. The other pages do not exist
 * yet, so a link to a page is checked against the planned page ids instead of the model.
 */
export function checkPageResult(
  assemble: (page: unknown) => SiteModel,
  page: unknown,
  knownPageIds?: string[],
): string[] {
  const model = assemble(page);
  const out = validateSiteModel(model)
    .filter((i) => /^\$\.(pages\[0\]|assets|forms)/.test(i.path))
    .filter((i) => !(knownPageIds && i.message === 'unknown page'))
    .map((i) => `${i.path} ${i.message}`);
  if (knownPageIds)
    model.pages[0]?.sections.forEach((s, i) => {
      const cta = s.props.cta as { pageId?: unknown } | undefined;
      if (typeof cta?.pageId === 'string' && !knownPageIds.includes(cta.pageId))
        out.push(
          `sections[${i}].props.cta.pageId "${cta.pageId.slice(0, 40)}" is not a page of this site (pages: ${knownPageIds.join(', ')})`,
        );
    });
  return out.slice(0, 12);
}
