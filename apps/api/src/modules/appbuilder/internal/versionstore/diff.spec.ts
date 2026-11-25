import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyHunks, editScript, fileDiff, splitLines, unifiedHunks } from './diff';

const side = (s: string) => ({ oid: 'a'.repeat(40), bytes: Buffer.from(s), binary: false });

describe('unified diff', () => {
  it('prints git-style hunks for a one-line change', () => {
    expect(unifiedHunks('a\nb\nc\n', 'a\nB\nc\n')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  });
  it('omits ",1" counts and starts empty ranges one line earlier', () => {
    expect(unifiedHunks('x\n', 'y\n')).toBe('@@ -1 +1 @@\n-x\n+y\n');
    expect(unifiedHunks('', 'a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(unifiedHunks('a\nb\n', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b\n');
  });
  it('marks a missing newline at the end of a file', () => {
    expect(unifiedHunks('a\nb', 'a\nb\n')).toBe(
      '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n',
    );
  });
  it('splits distant changes into separate hunks and merges near ones', () => {
    const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const far = [...base];
    far[2] = 'X';
    far[30] = 'Y';
    expect(unifiedHunks(base.join('\n') + '\n', far.join('\n') + '\n').match(/^@@/gm)).toHaveLength(
      2,
    );
    const near = [...base];
    near[2] = 'X';
    near[8] = 'Y'; // 5 equal lines between: within 2*context
    expect(
      unifiedHunks(base.join('\n') + '\n', near.join('\n') + '\n').match(/^@@/gm),
    ).toHaveLength(1);
  });
  it('identical texts give no hunks; binary files are reported, never printed', () => {
    expect(unifiedHunks('same\n', 'same\n')).toBe('');
    const bin = { oid: 'b'.repeat(40), bytes: Buffer.from([0, 1, 2]), binary: true };
    expect(fileDiff('x.bin', side('t'), bin)).toContain('Binary files a/x.bin and b/x.bin differ');
    expect(fileDiff('x.bin', null, bin)).toContain('Binary files /dev/null and b/x.bin differ');
  });
  it('file headers: added, deleted, modified, empty file', () => {
    expect(fileDiff('n.txt', null, side('a\n'))).toBe(
      'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..aaaaaaa\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+a\n',
    );
    expect(fileDiff('n.txt', side('a\n'), null)).toContain(
      'deleted file mode 100644\nindex aaaaaaa..0000000\n--- a/n.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n',
    );
    expect(fileDiff('e.txt', null, side(''))).toBe(
      'diff --git a/e.txt b/e.txt\nnew file mode 100644\nindex 0000000..aaaaaaa\n',
    );
  });
  it('splitLines handles the end of the text', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n')).toEqual([{ text: 'a', eol: true }]);
    expect(splitLines('a\nb')).toEqual([
      { text: 'a', eol: true },
      { text: 'b', eol: false },
    ]);
    expect(splitLines('\n')).toEqual([{ text: '', eol: true }]);
  });
});

const lcs = (a: string[], b: string[]) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      t[i]![j] =
        a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
};
const word = fc.constantFrom('a', 'b', 'c', 'd', '', 'e', '}', 'عربي');
const text = fc
  .tuple(fc.array(word, { maxLength: 24 }), fc.boolean())
  .map(([ls, eol]) => (ls.length ? ls.join('\n') + (eol ? '\n' : '') : ''));

describe('property: diff and patch (fuzz)', () => {
  it('the edit script is minimal and replays to the new sequence', () => {
    fc.assert(
      fc.property(fc.array(word, { maxLength: 14 }), fc.array(word, { maxLength: 14 }), (a, b) => {
        const ops = editScript(a, b)!;
        expect(ops).not.toBeNull();
        expect(ops.filter((o) => o.t !== ' ').length).toBe(a.length + b.length - 2 * lcs(a, b));
        const out: string[] = [];
        for (const o of ops) {
          if (o.t === ' ') out.push(a[o.i]!);
          else if (o.t === '+') out.push(b[o.i]!);
        }
        expect(out).toEqual(b);
        expect(ops.filter((o) => o.t !== '+').map((o) => a[o.i])).toEqual(a);
      }),
      { numRuns: 400 },
    );
  });
  it('applying the unified hunks to the old text always gives the new text', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const hunks = unifiedHunks(a, b);
        if (a === b) expect(hunks).toBe('');
        else expect(applyHunks(a, hunks)).toBe(b);
      }),
      { numRuns: 600 },
    );
  });
  it('a corrupted hunk is detected when applied (the patch is checked, not trusted)', () => {
    const hunks = unifiedHunks('a\nb\nc\n', 'a\nB\nc\n');
    expect(() => applyHunks('a\nZ\nc\n', hunks)).toThrow();
  });
  it('very large or fully rewritten input degrades to a notice instead of a runaway', () => {
    const big = Array.from({ length: 70_000 }, (_, i) => `${i}`).join('\n');
    expect(unifiedHunks(big, big + 'x')).toContain('diff omitted');
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expect(unifiedHunks(a, b)).toContain('diff omitted');
  });
});
