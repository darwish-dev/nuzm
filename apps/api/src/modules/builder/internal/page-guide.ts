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
