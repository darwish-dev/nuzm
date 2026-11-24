import { TEMPLATES } from '@nuzm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactFile } from './artifact';
import { cspAllows, parseCsp, strictnessProblems } from './csp';
import { parseHtml, textOf, byTag } from './html';
import { repairFindings, runWebsiteQa } from './runner';
import { buildWebsiteArtifact } from './static-build';
import type { QaOptions } from './types';

const FORMS = 'https://api.nuzm.test/p/00000000-0000-7000-8000-000000000001';
const enc = new TextEncoder();
const dec = new TextDecoder();
const OPTS: QaOptions = { axe: 'off', formsOrigin: 'https://api.nuzm.test' };

let base: ArtifactFile[] = [];
beforeAll(async () => {
  const t = TEMPLATES.find((x) => x.id.includes('services')) ?? TEMPLATES[0]!;
  const model = t.build({
    name: { ar: 'نموذج الاختبار', en: 'Test Sample' },
    locales: ['ar', 'en'],
    baseUrl: 'https://example.test',
  });
  const r = await buildWebsiteArtifact({
    model,
    baseUrl: 'https://example.test',
    formsBaseUrl: FORMS,
    qa: OPTS,
  });
  expect(r.failures).toEqual([]);
  base = r.files;
}, 120_000);

/** a copy of the baseline with one file's text rewritten (or added/removed) */
function mutate(path: string, fn: (s: string) => string): ArtifactFile[] {
  return base.map((f) =>
    f.path === path ? { ...f, bytes: enc.encode(fn(dec.decode(f.bytes))) } : f,
  );
}
const without = (path: string) => base.filter((f) => f.path !== path);
const codes = async (files: ArtifactFile[], o: QaOptions = OPTS) => {
  const r = await runWebsiteQa(files, o);
  return {
    r,
    codes: r.gates.flatMap((g) =>
      g.findings.filter((f) => f.severity === 'error').map((f) => f.code),
    ),
  };
};
const HOME_AR = 'ar/index.html';
const HOME_EN = 'en/index.html';
const page = (locale: string, slug: string) =>
  base.find((f) => f.path === `${locale}/${slug}/index.html`)?.path ?? `${locale}/index.html`;

describe('HTML reader', () => {
  it('reads attributes, raw text and recovers from stray tags', () => {
    const d = parseHtml(
      '<!doctype html><html lang=ar><body><p class="a b">x &amp; y</p></span><script>if(a<b){}</script><img alt="" src=x.png></body></html>',
    );
    expect(d.hasDoctype).toBe(true);
    expect(byTag(d.root, 'html')[0]!.attrs.lang).toBe('ar');
    expect(textOf(byTag(d.root, 'p')[0]!)).toBe('x & y');
    expect(d.errors).toContain('unmatched </span>');
    expect(byTag(d.root, 'script')[0]!.children[0]).toBe('if(a<b){}');
    expect(byTag(d.root, 'img')[0]!.attrs.alt).toBe('');
  });
});

describe('CSP evaluator', () => {
  const policy = parseCsp(
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://api.nuzm.test; base-uri 'none'",
  );
  it('allows first-party and the forms origin, blocks everything else', () => {
    expect(cspAllows(policy, 'script-src', 'assets/site.js')).toBe(true);
    expect(cspAllows(policy, 'script-src', 'https://cdn.evil.example/a.js')).toBe(false);
    expect(cspAllows(policy, 'img-src', 'data:image/png;base64,AAAA')).toBe(true);
    expect(cspAllows(policy, 'img-src', 'https://img.example/a.png')).toBe(false);
    expect(cspAllows(policy, 'form-action', 'https://api.nuzm.test/v1/public/forms/x')).toBe(true);
    expect(cspAllows(policy, 'form-action', 'https://evil.example/steal')).toBe(false);
    expect(cspAllows(policy, 'frame-src', 'https://www.youtube.com/embed/x')).toBe(false);
  });
  it('flags weak policies', () => {
    expect(
      strictnessProblems(
        policy.size ? "default-src 'self'; base-uri 'none'; form-action 'self'" : '',
      ),
    ).toEqual([]);
    expect(strictnessProblems("default-src *; script-src 'unsafe-inline'")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("default-src must be 'self'"),
        expect.stringContaining("script-src allows 'unsafe-inline'"),
        expect.stringContaining('base-uri'),
        expect.stringContaining('form-action'),
      ]),
    );
  });
});

describe('the baseline site (a shipped template) is clean', () => {
  it('has the pages a business site needs in ar and en and passes every non-axe gate', async () => {
    const { r, codes: c } = await codes(base, { ...OPTS, minPages: 5, requiredSlugs: ['home'] });
    expect(c).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.locales).toEqual(['ar', 'en']);
    // axe was switched off, so the run must NOT claim to be qualified
    expect(r.qualified).toBe(false);
    expect(r.gates.find((g) => g.gate === 'a11y-axe')!.status).toBe('skipped');
  });
});

describe('each gate catches what it exists for (mutation corpus)', () => {
  const cases: { name: string; code: string; files: () => ArtifactFile[] }[] = [
    {
      name: 'missing lang',
      code: 'structure.lang_missing',
      files: () => mutate(HOME_EN, (s) => s.replace(/ lang="en"/, '')),
    },
    {
      name: 'wrong lang',
      code: 'structure.lang_mismatch',
      files: () => mutate(HOME_EN, (s) => s.replace('lang="en"', 'lang="ar"')),
    },
    {
      name: 'no viewport',
      code: 'structure.viewport_missing',
      files: () => mutate(HOME_EN, (s) => s.replace(/<meta name="viewport"[^>]*>/, '')),
    },
    {
      name: 'zoom blocked',
      code: 'structure.viewport_zoom',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace(/(<meta name="viewport" content=")/, '$1user-scalable=no, '),
        ),
    },
    {
      name: 'two h1',
      code: 'structure.h1',
      files: () => mutate(HOME_EN, (s) => s.replace('</main>', '<h1>Second</h1></main>')),
    },
    {
      name: 'heading skip',
      code: 'structure.heading_skip',
      files: () => mutate(HOME_EN, (s) => s.replace('</main>', '<h5>Deep</h5></main>')),
    },
    {
      name: 'unlabelled input',
      code: 'structure.label',
      files: () => mutate(HOME_EN, (s) => s.replace('</main>', '<input name="q"></main>')),
    },
    {
      name: 'link without name',
      code: 'structure.link_name',
      files: () => mutate(HOME_EN, (s) => s.replace('</main>', '<a href="#"></a></main>')),
    },
    {
      name: 'duplicate id',
      code: 'structure.duplicate_id',
      files: () =>
        mutate(HOME_EN, (s) => s.replace('</main>', '<i id="dup"></i><i id="dup"></i></main>')),
    },
    {
      name: 'inline script',
      code: 'csp.inline_script',
      files: () => mutate(HOME_EN, (s) => s.replace('</body>', '<script>alert(1)</script></body>')),
    },
    {
      name: 'inline handler',
      code: 'csp.inline_handler',
      files: () =>
        mutate(HOME_EN, (s) => s.replace('</main>', '<button onclick="x()">Go</button></main>')),
    },
    {
      name: 'inline style attr',
      code: 'csp.style_attr',
      files: () =>
        mutate(HOME_EN, (s) => s.replace('</main>', '<p style="color:red">x</p></main>')),
    },
    {
      name: 'inline style block',
      code: 'csp.inline_style',
      files: () => mutate(HOME_EN, (s) => s.replace('</head>', '<style>p{}</style></head>')),
    },
    {
      name: 'third-party script',
      code: 'csp.blocked',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace('</body>', '<script src="https://cdn.evil.example/a.js"></script></body>'),
        ),
    },
    {
      name: 'third-party stylesheet (CDN font)',
      code: 'csp.blocked',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace(
            '</head>',
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=X"></head>',
          ),
        ),
    },
    {
      name: 'javascript: url',
      code: 'csp.javascript_url',
      files: () =>
        mutate(HOME_EN, (s) => s.replace('</main>', '<a href="javascript:alert(1)">x</a></main>')),
    },
    {
      name: 'css @import',
      code: 'csp.css_import',
      files: () =>
        mutate('assets/styles.css', (s) => `@import url("https://evil.example/x.css");\n${s}`),
    },
    {
      name: 'form posts elsewhere',
      code: 'forms.action_blocked',
      files: () =>
        mutate(page('en', 'contact'), (s) =>
          s.replace(/action="[^"]*"/, 'action="https://evil.example/collect"'),
        ),
    },
    {
      name: 'broken internal link',
      code: 'links.broken',
      files: () =>
        mutate(HOME_EN, (s) => s.replace('</main>', '<a href="/en/nope/">Nope</a></main>')),
    },
    {
      name: 'target blank without noopener',
      code: 'links.noopener',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace('</main>', '<a href="https://example.org" target="_blank">x</a></main>'),
        ),
    },
    {
      name: 'oversized stylesheet',
      code: 'size.css',
      files: () => mutate('assets/styles.css', (s) => `${s}\n/*${'x'.repeat(130 * 1024)}*/`),
    },
    {
      name: 'physical CSS',
      code: 'rtl.physical_css',
      files: () => mutate('assets/styles.css', (s) => `${s}\n.x{margin-left:4px}`),
    },
    {
      name: 'ar page ltr',
      code: 'rtl.dir',
      files: () => mutate(HOME_AR, (s) => s.replace('dir="rtl"', 'dir="ltr"')),
    },
    {
      name: 'untranslated ar page',
      code: 'rtl.untranslated',
      files: () =>
        base
          .map((f) => (f.path === HOME_AR ? { ...f, bytes: f.bytes } : f))
          .map((f) =>
            f.path === HOME_AR
              ? {
                  ...f,
                  bytes: enc.encode(
                    dec
                      .decode(base.find((x) => x.path === HOME_EN)!.bytes)
                      .replace('lang="en"', 'lang="ar"')
                      .replace('dir="ltr"', 'dir="rtl"'),
                  ),
                }
              : f,
          ),
    },
    {
      name: 'low contrast tokens',
      code: 'contrast.low',
      files: () =>
        mutate('assets/styles.css', (s) =>
          s.replace(/(--c-text\s*:\s*)#[0-9a-fA-F]{6}/, '$1#f4f4f4'),
        ),
    },
    {
      name: 'no description',
      code: 'seo.description',
      files: () => mutate(HOME_EN, (s) => s.replace(/<meta name="description"[^>]*>/, '')),
    },
    {
      name: 'duplicate titles',
      code: 'seo.duplicate_title',
      files: () =>
        mutate(page('en', 'contact'), (s) =>
          s.replace(
            /<title>[^<]*<\/title>/,
            `<title>${/<title>([^<]*)<\/title>/.exec(dec.decode(base.find((x) => x.path === HOME_EN)!.bytes))![1]}</title>`,
          ),
        ),
    },
    {
      name: 'noindex on a published page',
      code: 'seo.noindex',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace('</head>', '<meta name="robots" content="noindex"></head>'),
        ),
    },
    {
      name: 'broken JSON-LD',
      code: 'seo.jsonld',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace('</head>', '<script type="application/ld+json">{oops</script></head>'),
        ),
    },
    {
      name: 'remote image',
      code: 'assets.remote_image',
      files: () =>
        mutate(HOME_EN, (s) =>
          s.replace(
            '</main>',
            '<img src="https://images.example/a.jpg" alt="x" width="1" height="1"></main>',
          ),
        ),
    },
    {
      name: 'SVG with a script',
      code: 'assets.svg_unsafe',
      files: () => [
        ...base,
        {
          path: 'assets/evil.svg',
          bytes: enc.encode(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          ),
        },
      ],
    },
    {
      name: 'fake PNG',
      code: 'assets.mime_mismatch',
      files: () => [...base, { path: 'assets/fake.png', bytes: enc.encode('not a png') }],
    },
    {
      name: 'a locale is missing a page',
      code: 'rtl.locale_parity',
      files: () => base.filter((f) => f.path !== page('en', 'contact')),
    },
    { name: 'no home page', code: 'completeness.home', files: () => without('en/index.html') },
  ];
  for (const k of cases)
    it(k.name, async () => {
      const { codes: c } = await codes(k.files(), { ...OPTS, minPages: 1 });
      expect(c).toContain(k.code);
    });

  it('too few pages and a missing required slug', async () => {
    const { codes: c } = await codes(base, {
      ...OPTS,
      minPages: 50,
      requiredSlugs: ['no-such-page'],
    });
    expect(c).toEqual(expect.arrayContaining(['completeness.pages', 'completeness.required_page']));
  });
  it('a preview must be noindex; a publish must not', async () => {
    expect((await codes(base, { ...OPTS, mode: 'preview' })).codes).toContain(
      'seo.preview_indexable',
    );
  });
  it('a weak policy supplied by the host fails the csp gate', async () => {
    const { codes: c } = await codes(base, {
      ...OPTS,
      policy:
        "default-src 'self'; script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    });
    expect(c).toContain('csp.policy');
  });
});

describe('report shape', () => {
  it('binds the report to the artifact hash and gives the repair loop bounded, ordered findings', async () => {
    const files = mutate(HOME_EN, (s) => s.replace('</body>', '<script>alert(1)</script></body>'));
    const a = await runWebsiteQa(files, OPTS);
    const b = await runWebsiteQa(files, OPTS);
    expect(a.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.rootHash).toBe(b.rootHash);
    expect(a.rootHash).not.toBe((await runWebsiteQa(base, OPTS)).rootHash);
    expect(a.passed).toBe(false);
    const f = repairFindings(a, 5);
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(f)).toBe(JSON.stringify(repairFindings(b, 5)));
  });
});
