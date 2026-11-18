import { describe, expect, it } from 'vitest';
import { hexOr } from './contrast';
import { buildCss } from './css';
import { computePalette } from './palette';
import { minimalModel, richModel } from './fixtures';
import {
  checkAltText,
  checkLinks,
  contrastIssues,
  contrastRatio,
  lintPhysicalDirectionCss,
  validateHtml,
} from './validate';
import type { RenderedFile } from './types';

const frag = (html: string) => validateHtml(html, { fragment: true }).map((i) => i.code);
const doc = (body: string, head = '', attrs = 'lang="en" dir="ltr"') =>
  `<!doctype html><html ${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T</title>${head}</head><body><main>${body}</main></body></html>`;

describe('validateHtml: security rules', () => {
  const rejected: [string, string, string][] = [
    ['inline script', '<script>alert(1)</script>', 'script_not_allowed'],
    ['external script', '<script src="https://evil.example/x.js"></script>', 'script_not_allowed'],
    [
      'protocol-relative script',
      '<script src="//evil.example/x.js"></script>',
      'script_not_allowed',
    ],
    [
      'script with text/javascript type',
      '<script type="text/javascript">1</script>',
      'script_not_allowed',
    ],
    ['inline handler', '<p onclick="x()">a</p>', 'inline_event_handler'],
    [
      'handler without quotes',
      '<img src="/a.png" alt="a" onerror=alert(1)>',
      'inline_event_handler',
    ],
    ['style attribute', '<p style="color:red">a</p>', 'inline_style'],
    ['style element', '<style>p{color:red}</style>', 'inline_style'],
    ['javascript: href', '<a href="javascript:alert(1)">a</a>', 'unsafe_url'],
    ['mixed-case javascript: href', '<a href="JaVaScRiPt:alert(1)">a</a>', 'unsafe_url'],
    [
      'entity-encoded javascript: href',
      '<a href="jav&#x61;script&colon;alert(1)">a</a>',
      'unsafe_url',
    ],
    ['tab-split javascript: href', '<a href="java&Tab;script:alert(1)">a</a>', 'unsafe_url'],
    ['leading-space javascript: href', '<a href="  javascript:alert(1)">a</a>', 'unsafe_url'],
    ['data: href', '<a href="data:text/html;base64,PHNjcmlwdD4=">a</a>', 'unsafe_url'],
    ['data: img src', '<img src="data:image/svg+xml;base64,AAAA" alt="a">', 'unsafe_url'],
    ['javascript: form action', '<form action="javascript:alert(1)"></form>', 'unsafe_url'],
    ['iframe', '<iframe src="/x"></iframe>', 'forbidden_tag'],
    ['object', '<object data="/x"></object>', 'forbidden_tag'],
    ['base', '<base href="/">', 'forbidden_tag'],
    ['meta set-cookie', '<meta http-equiv="set-cookie" content="a=b">', 'forbidden_meta'],
    [
      'blank target without rel',
      '<a href="https://a.example" target="_blank">a</a>',
      'target_blank_noopener',
    ],
    ['raw < in attribute', '<a href="/a" title="a<b">a</a>', 'raw_lt_in_attribute'],
  ];
  it.each(rejected)('rejects %s', (_name, html, code) => {
    expect(frag(html)).toContain(code);
  });

  it('accepts a valid ld+json data block and the first-party script', () => {
    expect(
      frag('<script type="application/ld+json">{"a":"\\u003c/script\\u003e"}</script>'),
    ).toEqual([]);
    expect(frag('<script src="/assets/site.js" defer></script>')).toEqual([]);
  });
  it('rejects ld+json with a raw < or invalid JSON', () => {
    expect(frag('<script type="application/ld+json">{"a":"<b>"}</script>')).toContain(
      'ldjson_unsafe',
    );
    expect(frag('<script type="application/ld+json">{oops}</script>')).toContain('ldjson_invalid');
  });
  it('a </script> inside JSON-LD ends the block and exposes the second script', () => {
    const codes = frag(
      '<script type="application/ld+json">{"a":"</script><script>alert(1)</script>"}</script>',
    );
    expect(codes).toContain('script_not_allowed');
  });
  it('accepts rel="noopener noreferrer" with target=_blank', () => {
    expect(
      frag('<a href="https://a.example" target="_blank" rel="noopener noreferrer">a</a>'),
    ).toEqual([]);
  });
});

describe('validateHtml: structure', () => {
  it('accepts a minimal valid document', () => {
    expect(validateHtml(doc('<h1>a</h1><h2>b</h2>'))).toEqual([]);
  });
  it.each([
    ['missing lang', doc('<h1>a</h1>', '', 'dir="ltr"'), 'missing_lang'],
    ['missing dir', doc('<h1>a</h1>', '', 'lang="en"'), 'missing_dir'],
    ['arabic with ltr', doc('<h1>a</h1>', '', 'lang="ar" dir="ltr"'), 'dir_mismatch'],
    ['english with rtl', doc('<h1>a</h1>', '', 'lang="en" dir="rtl"'), 'dir_mismatch'],
    ['no h1', doc('<h2>a</h2>'), 'h1_count'],
    ['two h1', doc('<h1>a</h1><h1>b</h1>'), 'h1_count'],
    ['heading skip', doc('<h1>a</h1><h3>b</h3>'), 'heading_skip'],
    ['first heading not h1', doc('<h2>a</h2><h1>b</h1>'), 'heading_order'],
    ['duplicate id', doc('<h1 id="a">a</h1><p id="a">b</p>'), 'duplicate_id'],
    ['dangling aria', doc('<h1>a</h1><p aria-labelledby="zzz">b</p>'), 'dangling_reference'],
    ['label for missing', doc('<h1>a</h1><label for="zzz">b</label>'), 'dangling_reference'],
    ['unlabelled input', doc('<h1>a</h1><input type="text" id="q">'), 'unlabelled_input'],
    ['unclosed div', doc('<h1>a</h1><div><span>x</div>'), 'unclosed_tag'],
    ['stray end tag', doc('<h1>a</h1></section>'), 'unmatched_end_tag'],
    ['stray <', doc('<h1>a</h1><p>1 < 2</p>'), 'malformed'],
    [
      'no doctype',
      '<html lang="en" dir="ltr"><head><meta charset="utf-8"><title>t</title></head><body></body></html>',
      'missing_doctype',
    ],
    ['two mains', doc('<h1>a</h1></main><main>'), 'main_count'],
  ])('flags %s', (_n, html, code) => {
    expect(validateHtml(html).map((i) => i.code)).toContain(code);
  });
  it('accepts labelled controls (for/id, wrapping label, aria-label)', () => {
    expect(
      validateHtml(
        doc(
          '<h1>a</h1><label for="a">A</label><input id="a"><label>B<input></label><input aria-label="C"><input type="hidden" name="x">',
        ),
      ),
    ).toEqual([]);
  });
  it('tolerates optional end tags in foreign input', () => {
    expect(frag('<ul><li>a<li>b</ul>')).toEqual([]);
  });
});

describe('checkAltText', () => {
  it('flags missing and empty alt, allows explicit decorative images', () => {
    expect(checkAltText('<img src="/a.png">').map((i) => i.code)).toEqual(['alt_missing']);
    expect(checkAltText('<img src="/a.png" alt=" ">').map((i) => i.code)).toEqual(['alt_empty']);
    expect(checkAltText('<img src="/a.png" alt="" role="presentation">')).toEqual([]);
    expect(checkAltText('<img src="/a.png" alt="" aria-hidden="true">')).toEqual([]);
    expect(checkAltText('<img src="/a.png" alt="A cat">')).toEqual([]);
  });
});

describe('checkLinks', () => {
  const page = (path: string, body: string): RenderedFile => ({
    path,
    mime: 'text/html',
    content: `<html><body>${body}</body></html>`,
  });
  const asset = (path: string): RenderedFile => ({ path, mime: 'text/css', content: 'x' });
  const files: RenderedFile[] = [
    page('index.html', '<a href="/en/">en</a>'),
    page(
      'en/index.html',
      '<h1 id="top-h">x</h1><a href="/en/about/">a</a><a href="about/#team">b</a><a href="#top-h">c</a><link href="/assets/s.css"><img src="/assets/i.svg" alt="i">',
    ),
    page('en/about/index.html', '<h2 id="team">t</h2><a href="../">home</a><a href="/">root</a>'),
    asset('assets/s.css'),
    asset('assets/i.svg'),
  ];
  it('resolves directory URLs, relative URLs, anchors and assets', () => {
    expect(checkLinks(files)).toEqual([]);
  });
  it('reports broken paths, anchors and assets; ignores external links', () => {
    const bad = [
      ...files,
      page(
        'en/broken/index.html',
        '<a href="/en/nope/">x</a><a href="/en/about/#zzz">y</a><a href="#zzz">z</a><img src="/assets/missing.png" alt="m"><a href="https://example.com/x">e</a><a href="mailto:a@b.c">m</a><a href="../../../x">up</a>',
      ),
    ];
    const hrefs = checkLinks(bad).map((i) => i.href);
    expect(hrefs).toEqual([
      '/en/nope/',
      '/en/about/#zzz',
      '#zzz',
      '/assets/missing.png',
      '../../../x',
    ]);
  });
  it('checks meta refresh targets', () => {
    const f = [page('index.html', '<meta http-equiv="refresh" content="0; url=/zz/">')];
    expect(checkLinks(f)).toHaveLength(1);
  });
});

describe('lintPhysicalDirectionCss', () => {
  it.each([
    'margin-left: 1px',
    'margin-right: 1px',
    'padding-left: 1px',
    'padding-right: 2px',
    'border-left: 1px solid red',
    'border-right-width: 2px',
    'float: left',
    'float: right',
    'clear: right',
    'text-align: left',
    'text-align: right',
    'left: 0',
    'right: 10px',
    'border-top-left-radius: 4px',
    'border-bottom-right-radius: 4px',
    'scroll-margin-left: 3px',
  ])('reports %s', (decl) => {
    expect(lintPhysicalDirectionCss(`a { ${decl}; }`)).toHaveLength(1);
  });
  it('does not report logical properties, centred text or comments', () => {
    const css = `/* margin-left: 1px */ a { margin-inline-start: 1px; padding-inline: 2px; inset-inline-end: 0; text-align: start; text-align: center; border-start-start-radius: 4px; float: none; }`;
    expect(lintPhysicalDirectionCss(css)).toEqual([]);
  });
  it('honours the allow list', () => {
    expect(
      lintPhysicalDirectionCss('a { border-left: 1px solid red; margin-right: 1px }', [
        'border-left',
      ]),
    ).toEqual(['margin-right: 1px']);
  });
  it('the generated stylesheet is direction-neutral for every token combination', () => {
    for (const radius of ['none', 'sm', 'md', 'lg'] as const)
      for (const width of ['narrow', 'normal', 'wide'] as const) {
        const m = richModel();
        m.tokens = { radius, spacing: 'relaxed', fontFamily: 'serif', width };
        expect(lintPhysicalDirectionCss(buildCss(m, computePalette(m).palette))).toEqual([]);
      }
  });
});

describe('contrast', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#336699', '#336699')).toBe(1);
  });
  it('rejects non-hex input', () => {
    expect(() => contrastRatio('red', '#fff')).toThrow(RangeError);
  });
  it('contrastIssues reports a failing user text/background pair only', () => {
    expect(contrastIssues(richModel())).toEqual([]);
    expect(contrastIssues(minimalModel())).toEqual([]);
    const m = richModel();
    m.brand.colors = { text: '#aaaaaa', background: '#ffffff' };
    const issues = contrastIssues(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ pair: 'text-on-background', required: 4.5 });
  });
  it('every derived pair meets AA for a sweep of colours', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const hex = () =>
      `#${Math.floor(rnd() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`;
    for (let i = 0; i < 300; i++) {
      const m = minimalModel();
      m.brand.colors = { primary: hex(), accent: hex(), background: hex(), text: hex() };
      const { palette: p } = computePalette(m);
      const pairs: [string, string][] = [
        [p.text, p.bg],
        [p.text, p.mutedBg],
        [p.onPrimary, p.primary],
        [p.onAccent, p.accent],
        [p.link, p.bg],
        [p.link, p.mutedBg],
        [p.mutedText, p.bg],
        [p.mutedText, p.mutedBg],
      ];
      for (const [fg, bg] of pairs) expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('hexOr re-validates colours before CSS', () => {
    expect(hexOr('#ABC', '#000000')).toBe('#aabbcc');
    expect(hexOr('red;}body{display:none', '#000000')).toBe('#000000');
    expect(hexOr('#12345', '#000000')).toBe('#000000');
    expect(hexOr(undefined, '#123456')).toBe('#123456');
  });
});
