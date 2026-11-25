import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

const node = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex equals node:crypto', () => {
  it('known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('block-boundary lengths, non-ASCII text and a large file', () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000])
      expect(sha256Hex('x'.repeat(n)), String(n)).toBe(node('x'.repeat(n)));
    for (const s of ['مرحبا بالعالم', 'aé中😀z', 'line1\nline2\r\n', '\u0000\u001f'])
      expect(sha256Hex(s)).toBe(node(s));
    const big = 'export const a = 1;\n'.repeat(60_000); // ~1.2 MB
    expect(sha256Hex(big)).toBe(node(big));
  });
});
