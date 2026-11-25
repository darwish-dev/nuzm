import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../templates';
import { attrOf, tokenize } from './html-scan';
import { renderSite } from './index';

/**
 * DEFECT-22: a real-Chrome pass saw a 404 on the first page load of 7 of 8 templates, because no page declared an icon and browsers then request /favicon.ico. The jsdom gates
 * never saw it (nothing in the markup referenced a missing file). Two guards below the browser level: every page declares an icon, and every URL a page references resolves
 * to a file inside the artifact.
 */
const REFERENCING: Record<string, string> = {
  a: 'href',
  link: 'href',
  img: 'src',
  script: 'src',
  source: 'src',
  form: 'action',
};
const resolve = (from: string, ref: string): string | undefined => {
  if (/^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(ref)) return undefined; // external, scheme or fragment: not an artifact path
  const clean = ref.split('#')[0]!.split('?')[0]!;
  if (clean === '') return undefined;
  const abs = clean.startsWith('/') ? clean : `${from.replace(/[^/]*$/, '')}${clean}`;
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const p = parts.join('/');
  return abs.endsWith('/') || p === '' ? `${p}${p ? '/' : ''}index.html` : p;
};

type Files = { path: string; content: string | Uint8Array }[];
/** Pages that declare no icon, and references (links, scripts, images, form actions) that resolve to nothing in the file set. */
function audit(files: Files): { noIcon: string[]; dangling: string[] } {
  const paths = new Set(files.map((f) => f.path));
  const noIcon: string[] = [];
  const dangling: string[] = [];
  for (const pg of files.filter((f) => f.path.endsWith('.html'))) {
    let icon = false;
    for (const tok of tokenize(pg.content as string)) {
      if (tok.kind !== 'start') continue;
      if (
        tok.name === 'link' &&
        (attrOf(tok, 'rel') ?? '').toLowerCase().split(/\s+/).includes('icon')
      )
        icon = true;
      // a form posts to the platform's public forms endpoint, not to an artifact file
      if (tok.name === 'form') {
        const act = attrOf(tok, 'action') ?? '';
        if (!/^(https?:\/\/|\/v1\/public\/forms\/)/.test(act))
          dangling.push(`${pg.path}: <form action="${act}"> is not the platform forms endpoint`);
        continue;
      }
      const attr = REFERENCING[tok.name];
      const ref = attr ? attrOf(tok, attr) : undefined;
      if (!ref) continue;
      // canonical/alternate links name the PUBLIC url (absolute), they are skipped by `resolve`
      const target = resolve(pg.path, ref);
      if (target && !paths.has(target))
        dangling.push(`${pg.path}: <${tok.name} ${attr}="${ref}"> -> ${target}`);
    }
    if (!icon && !paths.has('favicon.ico')) noIcon.push(pg.path);
  }
  return { noIcon, dangling };
}

const render = (id: string) =>
  renderSite(
    TEMPLATES.find((t) => t.id === id)!.build({
      name: { ar: 'نموذج الاختبار', en: 'Test Sample' },
      locales: ['ar', 'en'],
      baseUrl: 'https://example.test',
    }),
    { baseUrl: 'https://example.test' },
  );

describe('every rendered page declares an icon and references only files that exist (DEFECT-22)', () => {
  it('the audit is not vacuous: a missing favicon file and a page without an icon are both caught', () => {
    const r = render('services');
    expect(audit(r.files).dangling).toEqual([]);
    const withoutFile = audit(r.files.filter((f) => f.path !== 'assets/favicon.svg'));
    expect(withoutFile.dangling.some((d) => d.includes('assets/favicon.svg'))).toBe(true);
    const stripped = r.files.map((f) =>
      f.path === 'ar/index.html'
        ? { ...f, content: (f.content as string).replace(/<link rel="icon"[^>]*>/, '') }
        : f,
    );
    expect(audit(stripped).noIcon).toEqual(['ar/index.html']);
  });

  for (const t of TEMPLATES)
    it(`${t.id}`, () => {
      const r = render(t.id);
      expect(r.files.filter((f) => f.path.endsWith('.html')).length).toBeGreaterThanOrEqual(2);
      const { noIcon, dangling } = audit(r.files);
      expect(noIcon).toEqual([]);
      expect(dangling).toEqual([]);
    });
});
