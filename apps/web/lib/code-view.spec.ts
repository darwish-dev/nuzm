import { describe, expect, it } from 'vitest';
import { fileKind, highlight, searchFiles, toLines } from './code-view';

const joined = (t: { s: string }[]) => t.map((x) => x.s).join('');

describe('code view helpers', () => {
  it('knows the kind of a file from its extension', () => {
    expect(fileKind('ar/index.html')).toBe('html');
    expect(fileKind('assets/styles.css')).toBe('css');
    expect(fileKind('assets/site.js')).toBe('js');
    expect(fileKind('a/b.PNG')).toBe('image');
    expect(fileKind('README')).toBe('text');
  });
  it('tints HTML tags, attributes, strings and comments, and loses no character', () => {
    const src = '<!-- hi --><a href="/x" class=\'y\'>Home</a>';
    const t = highlight(src, 'html');
    expect(joined(t)).toBe(src);
    expect(t.find((x) => x.c === 'com')?.s).toBe('<!-- hi -->');
    expect(t.filter((x) => x.c === 'tag').map((x) => x.s)).toEqual(['<a', '</a']);
    expect(t.filter((x) => x.c === 'attr').map((x) => x.s.trim())).toEqual(['href', 'class']);
    expect(t.filter((x) => x.c === 'str').map((x) => x.s)).toEqual(['"/x"', "'y'"]);
  });
  it('tints CSS properties, numbers, colours and at-rules', () => {
    const src = '@media (max-width: 640px) { a { color: #fff; margin: 0 8px; } } /* c */';
    const t = highlight(src, 'css');
    expect(joined(t)).toBe(src);
    expect(t.filter((x) => x.c === 'at').map((x) => x.s)).toEqual(['@media']);
    expect(t.filter((x) => x.c === 'prop').map((x) => x.s)).toEqual([
      'max-width',
      'color',
      'margin',
    ]);
    expect(t.some((x) => x.c === 'num' && x.s === '#fff')).toBe(true);
    expect(t.some((x) => x.c === 'com')).toBe(true);
  });
  it('tints JavaScript keywords, strings, numbers and comments', () => {
    const src = "const a = 'x'; // note\nif (a) return 42;";
    const t = highlight(src, 'js');
    expect(joined(t)).toBe(src);
    expect(t.filter((x) => x.c === 'kw').map((x) => x.s)).toEqual(['const', 'if', 'return']);
    expect(t.find((x) => x.c === 'str')?.s).toBe("'x'");
    expect(t.find((x) => x.c === 'com')?.s).toBe('// note');
    expect(t.find((x) => x.c === 'num')?.s).toBe('42');
  });
  it('tints JSON keys, strings, numbers and literals, and the tokens give back the text', () => {
    const text = '{"a": "x", "n": 1, "ok": true}';
    const t = highlight(text, 'json');
    expect(t.map((x) => x.s).join('')).toBe(text);
    expect(t.filter((x) => x.c === 'prop').map((x) => x.s)).toEqual(['"a"', '"n"', '"ok"']);
    expect(t.find((x) => x.c === 'str')?.s).toBe('"x"');
    expect(t.find((x) => x.c === 'num')?.s).toBe('1');
    expect(t.find((x) => x.c === 'kw')?.s).toBe('true');
  });
  it('anything else, and anything very large, stays plain text', () => {
    expect(highlight('plain words', 'text')).toEqual([{ c: 'plain', s: 'plain words' }]);
    expect(highlight('x'.repeat(300_000), 'html')).toHaveLength(1);
    expect(highlight('', 'html')).toEqual([{ c: 'plain', s: '' }]);
  });
  it('splits tokens into numbered lines, cutting a multi-line comment at each newline', () => {
    const lines = toLines(highlight('a\n/* x\ny */\nb', 'css'));
    expect(lines.map((l) => joined(l))).toEqual(['a', '/* x', 'y */', 'b']);
  });
  it('searches file names and contents, case-insensitively, with line numbers', () => {
    const files = [{ path: 'ar/index.html' }, { path: 'assets/styles.css' }];
    const contents = {
      'ar/index.html': '<h1>Hello</h1>\n<p>hello again</p>',
      'assets/styles.css': 'a{}',
    };
    expect(searchFiles(files, contents, 'HELLO')).toEqual([
      { path: 'ar/index.html', line: 1, text: '<h1>Hello</h1>' },
      { path: 'ar/index.html', line: 2, text: '<p>hello again</p>' },
    ]);
    expect(searchFiles(files, contents, 'style')[0]).toEqual({
      path: 'assets/styles.css',
      line: 0,
      text: 'assets/styles.css',
    });
    expect(searchFiles(files, contents, '   ')).toEqual([]);
    expect(searchFiles(files, contents, 'a', 2)).toHaveLength(2);
  });
});
