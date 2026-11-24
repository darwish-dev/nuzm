import { TEMPLATES } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { buildWebsiteArtifact } from './static-build';
import { repairText, summarize } from './runner';

const FORMS = 'https://api.nuzm.test/p/00000000-0000-7000-8000-000000000001';

describe('every shipped template passes the website QA gates in ar and en', () => {
  for (const t of TEMPLATES)
    it(`${t.id}`, async () => {
      const model = t.build({
        name: { ar: 'نموذج الاختبار', en: 'Test Sample' },
        locales: ['ar', 'en'],
        baseUrl: 'https://example.test',
      });
      const r = await buildWebsiteArtifact({
        model,
        baseUrl: 'https://example.test',
        formsBaseUrl: FORMS,
        qa: { axe: 'require' },
      });
      if (!r.ok) console.log(summarize(r.qa!), '\n', repairText(r.qa!, 40));
      expect(r.failures.map((f) => `${f.code} ${f.file ?? ''} ${f.message}`)).toEqual([]);
      expect(r.qa?.qualified).toBe(true);
    }, 120_000);
});
