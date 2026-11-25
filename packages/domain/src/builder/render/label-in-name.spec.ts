import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../templates';
import { renderSite } from './index';
import { attrOf, tokenize } from './html-scan';

/**
 * WCAG 2.1 SC 2.5.3 Label in Name (axe `label-content-name-mismatch`): when a link or button has an `aria-label`, that name must contain its visible text, otherwise speech-control
 * users cannot say what they see. The jsdom gates do not compute this rule; a real-Chrome pass found it on the language-switch link (DEFECT-21). This test is the browser-free guard.
 */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Every `<a>`/`<button>` with an aria-label whose name does not contain its visible text, as `tag "label" vs "text"`. */
export function labelInNameMismatches(html: string): string[] {
  const out: string[] = [];
  const toks = tokenize(html);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'start' || (t.name !== 'a' && t.name !== 'button')) continue;
    const label = attrOf(t, 'aria-label');
    if (!label) continue;
    let text = '';
    for (let j = i + 1; j < toks.length; j++) {
      const n = toks[j]!;
      if (n.kind === 'end' && n.name === t.name) break;
      if (n.kind === 'text') text += n.text;
    }
    if (norm(text) && !norm(label).includes(norm(text)))
      out.push(`${t.name} "${label}" vs "${norm(text)}"`);
  }
  return out;
}

describe('label in name (WCAG 2.5.3)', () => {
  it('the checker is not vacuous: it flags the old language-link markup and accepts a matching name', () => {
    expect(
      labelInNameMismatches('<a href="/en/" aria-label="تغيير اللغة">English</a>'),
    ).toHaveLength(1);
    expect(
      labelInNameMismatches('<a href="/en/" aria-label="English: switch">English</a>'),
    ).toEqual([]);
    expect(labelInNameMismatches('<a href="/en/" lang="en">English</a>')).toEqual([]);
  });

  for (const t of TEMPLATES)
    it(`${t.id}: every labelled link and button names its visible text, in ar and en`, () => {
      const r = renderSite(
        t.build({
          name: { ar: 'نموذج الاختبار', en: 'Test Sample' },
          locales: ['ar', 'en'],
          baseUrl: 'https://example.test',
        }),
      );
      const pages = r.files.filter((f) => /^(ar|en)\/.*\.html$/.test(f.path));
      expect(pages.length).toBeGreaterThanOrEqual(2);
      // the language switch exists on every page of a two-language site, in both directions
      expect(
        pages.every((f) => /<a class="lang [^>]*hreflang="(ar|en)"/.test(f.content as string)),
      ).toBe(true);
      const bad = pages.flatMap((f) =>
        labelInNameMismatches(f.content as string).map((m) => `${f.path}: ${m}`),
      );
      expect(bad).toEqual([]);
    });
});
