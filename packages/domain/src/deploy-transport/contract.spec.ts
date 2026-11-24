import { describe, expect, it } from 'vitest';
import {
  ArtifactTransportError,
  artifactManifestHash,
  assertArtifactAcceptable,
  assertArtifactPath,
  assertReleaseId,
  DEFAULT_TRANSPORT_LIMITS,
} from './contract';
import { buildConformanceArtifact, CONFORMANCE_VECTOR } from './conformance';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ArtifactTransportError).code;
  }
  return 'none';
};
const enc = (s: string) => new TextEncoder().encode(s);

describe('manifest hash', () => {
  it('matches the pinned vector and ignores file order', () => {
    const a = buildConformanceArtifact(CONFORMANCE_VECTOR.body);
    expect(a.hash).toBe(CONFORMANCE_VECTOR.hash);
    expect(artifactManifestHash([...a.files].reverse())).toBe(a.hash);
  });
  it('changes with a path or a byte', () => {
    const a = buildConformanceArtifact('x');
    const b = buildConformanceArtifact('y');
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('path and release-id rules', () => {
  it('accepts normal and Arabic paths', () => {
    for (const p of ['index.html', 'a/b/c.css', 'صفحة/مرحبا.html', 'img/logo.v2.png'])
      expect(
        code(() => assertArtifactPath(p)),
        p,
      ).toBe('none');
  });
  it('refuses unsafe paths', () => {
    for (const p of [
      '',
      '/a',
      '../a',
      'a/../b',
      'a/./b',
      'a//b',
      'a\\b',
      'a\u0000b',
      'a/',
      '..',
      '.',
      'a'.repeat(513),
      'a/b/c/d/e/f/g/h/i.txt',
      'é.html',
    ])
      expect(
        code(() => assertArtifactPath(p)),
        p,
      ).toBe('invalid_path');
  });
  it('release ids', () => {
    for (const id of ['abcdefgh', '0198-aaaa-bbbb', 'conf-put-xyz-1'])
      expect(
        code(() => assertReleaseId(id)),
        id,
      ).toBe('none');
    for (const id of [
      '',
      'short',
      '../abcdefgh',
      'current',
      'releases',
      'Abcdefgh1',
      'a b c d e f g',
    ])
      expect(
        code(() => assertReleaseId(id)),
        id,
      ).toBe('invalid_release_id');
  });
});

describe('artifact acceptance', () => {
  it('bounds and hash', () => {
    const lim = { maxFiles: 2, maxBytes: 10, maxFileBytes: 6 };
    const mk = (files: { path: string; content: Uint8Array }[]) => ({
      hash: artifactManifestHash(files),
      files: files.map((f) => ({ ...f, mime: 'x' })),
    });
    expect(code(() => assertArtifactAcceptable(mk([]), lim))).toBe('empty_artifact');
    expect(
      code(() =>
        assertArtifactAcceptable(
          mk([1, 2, 3].map((i) => ({ path: `f${i}`, content: enc('a') }))),
          lim,
        ),
      ),
    ).toBe('limit_exceeded');
    expect(
      code(() => assertArtifactAcceptable(mk([{ path: 'a', content: enc('1234567') }]), lim)),
    ).toBe('limit_exceeded');
    expect(
      code(() =>
        assertArtifactAcceptable(
          mk([
            { path: 'a', content: enc('123456') },
            { path: 'b', content: enc('12345') },
          ]),
          lim,
        ),
      ),
    ).toBe('limit_exceeded');
    expect(
      code(() =>
        assertArtifactAcceptable({ ...mk([{ path: 'a', content: enc('1') }]), hash: 'bad' }, lim),
      ),
    ).toBe('transfer_failed');
    expect(assertArtifactAcceptable(mk([{ path: 'a', content: enc('1') }]), lim)).toEqual({
      files: 1,
      bytes: 1,
    });
    expect(DEFAULT_TRANSPORT_LIMITS.maxBytes).toBe(60 * 1024 * 1024);
  });
});
