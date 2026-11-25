import { TEMPLATES } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { loadAxe } from './axe';
import { repairText, summarize } from './runner';
import { buildWebsiteArtifact } from './static-build';

const FORMS = 'https://api.nuzm.test/p/00000000-0000-7000-8000-000000000001';
const axeAvailable = !('error' in loadAxe());
// axe on jsdom costs tens of seconds per template: the default unit run checks every template with the fast gates and ONE template with axe (both languages);
// P3_S04_AXE_ALL=1 runs axe on all of them (this is how the report's all-templates axe evidence was produced).
const AXE_ALL = process.env.P3_S04_AXE_ALL === '1';

const build = (id: string, axe: 'off' | 'require') => {
  const t = TEMPLATES.find((x) => x.id === id)!;
  return buildWebsiteArtifact({
    model: t.build({
      name: { ar: 'نموذج الاختبار', en: 'Test Sample' },
      locales: ['ar', 'en'],
      baseUrl: 'https://example.test',
    }),
    baseUrl: 'https://example.test',
    formsBaseUrl: FORMS,
    qa: { axe },
  });
};
const warnings = (r: Awaited<ReturnType<typeof build>>) =>
  r.qa?.gates.flatMap((g) =>
    g.findings.filter((f) => f.severity === 'warning').map((f) => `${f.code} ${f.file}`),
  );

describe('every shipped template passes the website QA gates in ar and en', () => {
  for (const t of TEMPLATES)
    it(`${t.id}: fast gates, no errors and no warnings (titles name the business, descriptions are long enough)`, async () => {
      const r = await build(t.id, 'off');
      if (!r.ok) console.log(summarize(r.qa!), '\n', repairText(r.qa!, 40));
      expect(r.failures.map((f) => `${f.code} ${f.file ?? ''} ${f.message}`)).toEqual([]);
      expect(warnings(r)).toEqual([]);
      expect(r.qa?.passed).toBe(true);
    }, 120_000);

  for (const id of AXE_ALL ? TEMPLATES.map((t) => t.id) : ['services'])
    it.skipIf(!axeAvailable)(
      `${id}: QUALIFIED with axe-core (WCAG 2.1 A/AA) on both languages`,
      async () => {
        const r = await build(id, 'require');
        expect(r.failures.map((f) => `${f.code} ${f.file ?? ''} ${f.message}`)).toEqual([]);
        expect(warnings(r)).toEqual([]);
        expect(r.qa?.qualified).toBe(true);
        // every page of every locale was really checked by axe
        expect(r.qa?.gates.find((g) => g.gate === 'a11y-axe')?.metrics.pagesChecked).toBe(
          r.qa?.pages,
        );
      },
      300_000,
    );
});
