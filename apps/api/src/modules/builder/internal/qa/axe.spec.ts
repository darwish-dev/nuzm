import { describe, expect, it } from 'vitest';
import type { ArtifactFile } from './artifact';
import { loadAxe } from './axe';
import { runWebsiteQa } from './runner';

const enc = new TextEncoder();
const doc = (lang: 'ar' | 'en', body: string, head = '') =>
  `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${lang === 'ar' ? 'الصفحة الرئيسية للاختبار' : 'Home page for the test'}</title><meta name="description" content="${lang === 'ar' ? 'وصف الصفحة الرئيسية لموقع اختبار الجودة الآلي للمواقع الإلكترونية' : 'The description of the home page of an automated website quality test site'}">${head}<link rel="stylesheet" href="../assets/styles.css"></head><body><a href="#main">${lang === 'ar' ? 'تخطي' : 'Skip'}</a><header><nav aria-label="main"><a href="index.html">${lang === 'ar' ? 'الرئيسية' : 'Home'}</a></nav></header><main id="main">${body}</main><footer><p>${lang === 'ar' ? 'جميع الحقوق محفوظة' : 'All rights reserved'}</p></footer></body></html>`;
const site = (arBody: string, enBody: string): ArtifactFile[] => [
  {
    path: 'index.html',
    bytes: enc.encode(
      '<!doctype html><html lang="ar"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=ar/"><title>Redirect</title></head><body><a href="ar/">ar</a></body></html>',
    ),
  },
  { path: 'ar/index.html', bytes: enc.encode(doc('ar', arBody)) },
  { path: 'en/index.html', bytes: enc.encode(doc('en', enBody)) },
  { path: 'assets/styles.css', bytes: enc.encode('body{margin:0}') },
];
const GOOD_AR = '<h1>مرحبا بكم في موقعنا</h1><p>نص تجريبي للصفحة</p>';
const GOOD_EN = '<h1>Welcome to our site</h1><p>Sample text for the page</p>';

const axeAvailable = !('error' in loadAxe());

describe.skipIf(!axeAvailable)('axe-core gate (jsdom, WCAG 2.1 A/AA)', () => {
  it('passes a clean ar+en site and reports that it really ran', async () => {
    const r = await runWebsiteQa(site(GOOD_AR, GOOD_EN), { axe: 'require' });
    const g = r.gates.find((x) => x.gate === 'a11y-axe')!;
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.status).toBe('pass');
    expect(g.metrics.pagesChecked).toBe(2);
    expect(String(g.metrics.axeVersion)).toMatch(/^\d+\.\d+/);
  });
  it('finds violations in either language (invalid ARIA role, unlabelled select, empty button)', async () => {
    const bad =
      '<h1>Title</h1><div role="foo">x</div><select name="s"><option>a</option></select><button></button>';
    const r = await runWebsiteQa(site(bad.replace('Title', 'العنوان'), bad), { axe: 'require' });
    const g = r.gates.find((x) => x.gate === 'a11y-axe')!;
    expect(g.status).toBe('fail');
    const ids = new Set(g.findings.map((f) => f.code));
    expect(ids).toContain('a11y-axe.aria-roles');
    expect(ids).toContain('a11y-axe.select-name');
    expect(ids).toContain('a11y-axe.button-name');
    // both languages were checked
    expect(new Set(g.findings.map((f) => f.file))).toEqual(
      new Set(['ar/index.html', 'en/index.html']),
    );
  });
  it("does not run the page's own scripts (scripts are disabled in the throw-away window)", async () => {
    // if this script ran it would remove lang and axe would report `html-has-lang`; it must not run
    const trap = '<h1>T</h1><script>document.documentElement.removeAttribute("lang");</script>';
    const r = await runWebsiteQa(site(GOOD_AR, trap), { axe: 'require', gates: ['a11y-axe'] });
    expect(r.gates[0]!.findings.map((f) => f.code)).not.toContain('a11y-axe.html-has-lang');
    expect(r.gates[0]!.metrics.pagesChecked).toBe(2);
  });
});

describe('axe unavailable', () => {
  it('is skipped (never a pass) when not required, and not qualified', async () => {
    const r = await runWebsiteQa(site(GOOD_AR, GOOD_EN), { axe: 'off' });
    expect(r.gates.find((g) => g.gate === 'a11y-axe')!.status).toBe('skipped');
    expect(r.qualified).toBe(false);
  });
});
