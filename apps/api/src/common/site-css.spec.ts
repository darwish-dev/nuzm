import { describe, expect, it } from 'vitest';
import { TEMPLATES, lintPhysicalDirectionCss, renderSite } from '@nuzm/domain';
import { compileSiteCss, renderSiteCss } from './site-css';

/** Class names that are markup hooks (the editor and the stylesheet's base layer key off them), not Tailwind utilities. */
const HOOK =
  /^(sec|sec-[a-z_]+|tone-(default|muted|primary)|align-(start|center)|card|cards|plan|price|amount|cur|period|author|role|fig|gallery|hero-(grid|copy|media)|has-media|lead|btn|logo|brand|lang|skip|nav-toggle|nav-list|site-header|site-footer|page-head|preview-banner|qa|faq|form|field|req|hp|form-status|map-card|address|icon|stat|stat-value|stat-label|stats-grid|cta-box|steps-list|step|step-num)$/;
const cssEscape = (c: string) => c.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

describe('site stylesheet: Tailwind compiled at build time', () => {
  const t = TEMPLATES.find((x) => x.id === 'services')!;
  const model = t.build({ name: { ar: 'نظم', en: 'Nuzm' }, locales: ['ar', 'en'] });

  it('turns the source into a stylesheet with exactly the utilities the pages use', async () => {
    const out = renderSite(model);
    const css = await compileSiteCss(out.tailwind);
    expect(css).toContain('--c-primary:');
    expect(css).toContain('.max-w-site');
    expect(css).toContain('.rounded-site');
    expect(css).not.toContain('@import'); // resolved, not left for the browser
    expect(css).not.toContain('url(');
    expect(css.length).toBeLessThan(120_000);
  });

  it('every utility class a page uses produces a rule (a typo would silently stay unstyled)', async () => {
    const out = renderSite(model);
    const css = await compileSiteCss(out.tailwind);
    const missing = out.tailwind.candidates.filter(
      (c) => !HOOK.test(c) && !css.includes(`.${cssEscape(c)}`),
    );
    expect(missing).toEqual([]);
  });

  it('one stylesheet for both reading directions: no left/right rules', async () => {
    const css = await compileSiteCss(renderSite(model).tailwind);
    expect(lintPhysicalDirectionCss(css)).toEqual([]);
  });

  it('is deterministic and replaces assets/styles.css in the rendered files', async () => {
    const a = await renderSiteCss(model);
    const b = await renderSiteCss(model);
    const file = (r: typeof a) => r.files.find((f) => f.path === 'assets/styles.css')!.content;
    expect(file(a)).toBe(file(b));
    expect(String(file(a))).not.toContain('@import');
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('refuses a source that imports anything but the Tailwind package', async () => {
    await expect(
      compileSiteCss({ source: '@import "/etc/passwd";', candidates: [] }),
    ).rejects.toThrow();
  });

  it('compiles every template (all business types) without errors', async () => {
    for (const tpl of TEMPLATES) {
      const m = tpl.build({ name: { ar: 'م', en: 'M' }, locales: ['ar', 'en'] });
      const r = await renderSiteCss(m);
      expect(
        r.issues.filter((i) => i.severity === 'error'),
        tpl.id,
      ).toEqual([]);
    }
  });
});
