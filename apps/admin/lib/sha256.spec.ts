import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from './sha256';

const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('Sha256 (incremental, browser side of the upload checksum)', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex(
        new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  it('agrees with Node for every length around the block and padding boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const d = randomBytes(n);
      expect(sha256Hex(d), `length ${n}`).toBe(node(d));
    }
  });
  it('gives the same digest however the input is chunked', () => {
    const d = randomBytes(10_000);
    for (const size of [1, 3, 63, 64, 65, 127, 1000, 4096, 9999]) {
      const h = new Sha256();
      for (let i = 0; i < d.length; i += size) h.update(d.subarray(i, i + size));
      expect(h.digestHex(), `chunk ${size}`).toBe(node(d));
    }
  });
  it('hashes a large input in 8 MiB steps', () => {
    const d = randomBytes(20 * 1024 * 1024 + 17);
    const h = new Sha256();
    for (let i = 0; i < d.length; i += 8 * 1024 * 1024)
      h.update(d.subarray(i, i + 8 * 1024 * 1024));
    expect(h.digestHex()).toBe(node(d));
  });
  it('refuses to be used after the digest was taken, and the digest is stable', () => {
    const h = new Sha256().update(new TextEncoder().encode('x'));
    const a = h.digestHex();
    expect(h.digestHex()).toBe(a);
    expect(() => h.update(new Uint8Array(1))).toThrow();
  });
});
