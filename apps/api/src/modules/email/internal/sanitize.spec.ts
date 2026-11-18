import { describe, expect, it } from 'vitest';
import { escapeHtml, safeUrl, sanitizeHtml } from './sanitize';
import { hasControl, parseAddress, prepareTemplate, renderTemplate } from './template';

const XSS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="javascript:alert(1)">',
  '<svg/onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href=" JaVaScRiPt:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;&#x61;vascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<object data="x"></object>',
  '<embed src="x">',
  '<form action="https://evil"><input></form>',
  '<body onload=alert(1)>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<div style="expression(alert(1))">x</div>',
  '<p onclick="alert(1)">x</p>',
  '<p ONMOUSEOVER="alert(1)">x</p>',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
  '<img src=x onerror=alert(1) src=y>',
  '<<script>alert(1)//<</script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<style>@import "javascript:alert(1)"</style>',
  '<link rel=stylesheet href=javascript:alert(1)>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<math><mtext></mtext><script>alert(1)</script></math>',
  '<!--><script>alert(1)</script>-->',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<?php echo 1 ?>',
  '<a href="https://ok.example"><img src="x" onerror="alert(1)"></a>',
  '<img src="https://ok.example/a.png" onload="alert(1)">',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<video><source onerror=alert(1)></video>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<a href="//evil.example">x</a>',
  '<img src="//evil.example/x.png">',
  '<img src="http://insecure.example/x.png">',
  '<a href="mailto:a@b.c?body=x">ok</a><script>1</script>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '<a href="https://ok.example" target="_blank" onfocus="x">x</a>',
  '<td background="javascript:alert(1)">x</td>',
  '<table onclick=alert(1)><tr><td>x</td></tr></table>',
];
const BAD =
  /<\s*(script|iframe|object|embed|svg|math|form|input|button|style|link|meta|base|video|audio|details|body|html)\b|\son[a-z]+\s*=|javascript:|vbscript:|data:|expression\(|style\s*=|<\?|<!\[CDATA/i;

describe('sanitizeHtml: XSS corpus (AC: template XSS fuzz)', () => {
  it.each(XSS)('neutralizes %s', (payload) => {
    const out = sanitizeHtml(payload);
    expect(out).not.toMatch(BAD);
    expect(out).not.toMatch(/src="(?!https:)/i);
    for (const m of out.matchAll(/href="([^"]*)"/g))
      expect(m[1]).toMatch(/^(https?:|mailto:|tel:|\{\{)/i);
    // idempotent: sanitizing the output again changes nothing
    expect(sanitizeHtml(out)).toBe(out);
  });
  it('keeps what a transactional email needs: paragraphs, links with rel, RTL, tables, images over https, lists', () => {
    const html =
      '<div dir="rtl" lang="ar"><h1>مرحبا</h1><p>Hi <b>there</b>, <a href="https://app.example.com/x?a=1&b=2">open</a></p><ul><li>one</li></ul><img src="https://cdn.example.com/a.png" alt="logo" width="120"><table width="100%"><tr><td colspan="2">x</td></tr></table></div>';
    const out = sanitizeHtml(html);
    expect(out).toContain('dir="rtl"');
    expect(out).toContain('lang="ar"');
    expect(out).toContain('مرحبا');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="https://app.example.com/x?a=1&amp;b=2"');
    expect(out).toContain('<img src="https://cdn.example.com/a.png" alt="logo" width="120">');
    expect(out).toContain('<td colspan="2">x</td>');
  });
  it('fuzz: random tag soup never yields an executable construct and stays idempotent (1000 cases)', () => {
    const atoms = [
      '<',
      '>',
      '"',
      "'",
      '=',
      '/',
      'script',
      'img',
      'a',
      'href',
      'src',
      'onerror',
      'javascript:',
      'alert(1)',
      ' ',
      '&#106;',
      '&lt;',
      '<!--',
      '-->',
      'svg',
      'style',
      'x',
      String.fromCharCode(0),
      '\n',
    ];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 1000; n++) {
      let s = '';
      for (let i = 0; i < 25; i++) s += atoms[Math.floor(rnd() * atoms.length)];
      const out = sanitizeHtml(s);
      expect(out, s).not.toMatch(/<\s*(script|iframe|object|embed|svg|style)\b/i);
      for (const tag of out.match(/<[^>]*>/g) ?? []) expect(tag, s).not.toMatch(/\son[a-z]+\s*=/i); // text may mention onerror=; a TAG may not carry it
      expect(out, s).not.toMatch(/(?:href|src)="\s*(?:javascript|vbscript|data):/i);
      expect(sanitizeHtml(out), s).toBe(out);
    }
  });
  it('safeUrl only passes absolute http(s)/mailto/tel', () => {
    expect(safeUrl('https://a.example', ['https'])).toBe('https://a.example');
    expect(safeUrl('HTTPS://a.example', ['https'])).toBe('HTTPS://a.example');
    for (const bad of [
      'javascript:1',
      '/relative',
      '//a.example',
      'ftp://a.example',
      'https://',
      ' java\nscript:1',
    ])
      expect(safeUrl(bad, ['http', 'https', 'mailto', 'tel'])).toBeNull();
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('templates: variables, header injection, rendering', () => {
  const ok = {
    subject: 'Hello {{name}}',
    html: '<p dir="rtl">مرحبا {{name}}, <a href="{{link}}">open</a></p>',
    variables: {
      name: { type: 'string', required: true },
      link: { type: 'string', required: true },
    },
  };
  it('refuses undeclared variables, header injection in the subject, empty content', () => {
    try {
      prepareTemplate({ ...ok, html: '<p>{{ghost}}</p>' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { detail?: string }).detail).toMatch(/undeclared/);
    }
    for (const subject of ['a\r\nBcc: evil@x.y', 'a\nb', 'a b', ''])
      expect(() => prepareTemplate({ ...ok, subject })).toThrow();
    try {
      prepareTemplate({ ...ok, html: '<script>1</script>' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { detail?: string }).detail).toMatch(/visible content/);
    }
    expect(() =>
      prepareTemplate({ ...ok, variables: { 'bad name': { type: 'string' } } }),
    ).toThrow();
    expect(() => prepareTemplate({ ...ok, variables: { a: { type: 'date' } } })).toThrow();
  });
  it('escapes values in html, strips line breaks from the subject, re-sanitizes (a javascript: href from a variable is dropped), validates variables', () => {
    const t = prepareTemplate(ok);
    const r = renderTemplate(t, {
      name: '<script>alert(1)</script>\r\nBcc: x@y.z',
      link: 'https://app.example.com/ok',
    });
    expect(r.html).not.toContain('<script');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).toContain('href="https://app.example.com/ok"');
    const bad = renderTemplate(t, { name: 'x', link: 'javascript:alert(1)' });
    expect(bad.html).not.toMatch(/javascript:/i);
    expect(() => renderTemplate(t, { name: 'x' })).toThrow();
    expect(() => renderTemplate(t, { name: 'x', link: 'https://a.example', extra: 1 })).toThrow();
    expect(() => renderTemplate(t, { name: 5, link: 'https://a.example' })).toThrow();
    expect(() =>
      renderTemplate(t, { name: 'x'.repeat(1001), link: 'https://a.example' }),
    ).toThrow();
  });
  it('addresses: one plain address only; header-injection fuzz', () => {
    expect(parseAddress('User@Example.COM')).toBe('user@example.com');
    for (const bad of [
      'a@b.c\r\nBcc: x@y.z',
      'a@b.c,d@e.f',
      'a@b.c;d@e.f',
      '"A B" <a@b.c>',
      'a b@c.de',
      'a@b',
      '@b.cd',
      'a..b@c.de',
      '.a@b.cd',
      'a.@b.cd',
      'a@b.c' + String.fromCharCode(0),
      'a@b.cd\n',
      'a@-b.cd',
      'x'.repeat(300) + '@b.cd',
      5,
      null,
      'a@b.cd>',
    ])
      expect(() => parseAddress(bad), String(bad)).toThrow();
    expect(
      hasControl('a\rb') &&
        hasControl('a\nb') &&
        hasControl('a' + String.fromCharCode(0)) &&
        !hasControl('abc'),
    ).toBe(true);
  });
});
