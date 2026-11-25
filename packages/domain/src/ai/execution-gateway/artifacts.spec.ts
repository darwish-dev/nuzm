import { describe, expect, it } from 'vitest';
import {
  ARTIFACTS_AUTO_APPLY,
  DEFAULT_ARTIFACT_POLICY,
  collectArtifacts,
  type ProducedFile,
} from './index';

const f = (path: string, content: string, over: Partial<ProducedFile> = {}): ProducedFile => ({
  path,
  bytes: Buffer.byteLength(content),
  kind: 'file',
  content,
  ...over,
});
const at = () => new Date('2026-11-24T00:00:00Z');

describe('collectArtifacts', () => {
  it('is never auto-applied', () => expect(ARTIFACTS_AUTO_APPLY).toBe(false));
  it('accepts files under the declared roots and hashes them', () => {
    const r = collectArtifacts(
      [f('dist/app.js', 'abc'), f('coverage/lcov.info', 'x')],
      DEFAULT_ARTIFACT_POLICY,
      at,
    );
    expect(r.refused).toEqual([]);
    expect(r.accepted[0]).toMatchObject({
      id: 'art-1',
      path: 'dist/app.js',
      bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      createdAt: '2026-11-24T00:00:00.000Z',
    });
  });
  it.each([
    ['../etc/passwd', 'path_invalid'],
    ['/abs/x', 'path_invalid'],
    ['dist/../../x', 'path_invalid'],
    ['src/main.ts', 'outside_output_roots'],
    ['distribution/x', 'outside_output_roots'],
    ['dist/.env', 'sensitive_path'],
    ['dist/node_modules/x/index.js', 'sensitive_path'],
    ['build/.git/config', 'sensitive_path'],
    ['dist/id_rsa', 'sensitive_path'],
  ])('refuses %s (%s)', (path, reason) => {
    expect(collectArtifacts([f(path, 'x')]).refused).toEqual([{ path, reason }]);
  });
  it('refuses links, devices and directories', () => {
    for (const kind of ['symlink', 'hardlink', 'dir', 'device'] as const) {
      const r = collectArtifacts([f('dist/x', 'x', { kind })]);
      expect(r.refused[0]!.reason).toBe(`not_a_regular_file_${kind}`);
    }
  });
  it('enforces size and count bounds and a total', () => {
    const policy = { roots: ['dist'], maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    const r = collectArtifacts(
      [
        f('dist/a', '12345678'),
        f('dist/big', 'x'.repeat(11)),
        f('dist/b', '1234567'),
        f('dist/c', '1'),
        f('dist/d', '1'),
      ],
      policy,
    );
    expect(r.accepted.map((a) => a.path)).toEqual(['dist/a', 'dist/b']);
    expect(r.refused).toEqual([
      { path: 'dist/big', reason: 'file_too_large' },
      { path: 'dist/c', reason: 'too_many_files' },
      { path: 'dist/d', reason: 'too_many_files' },
    ]);
    const t = collectArtifacts([f('dist/a', '12345678'), f('dist/b', '12345678')], {
      ...policy,
      maxTotalBytes: 12,
    });
    expect(t.refused).toEqual([{ path: 'dist/b', reason: 'total_too_large' }]);
  });
  it('catches a runtime that lies about the size, and requires a hash when no content is given', () => {
    expect(collectArtifacts([f('dist/a', 'abc', { bytes: 99 })]).refused[0]!.reason).toBe(
      'size_mismatch',
    );
    expect(collectArtifacts([{ path: 'dist/a', bytes: 3, kind: 'file' }]).refused[0]!.reason).toBe(
      'no_content_hash',
    );
    expect(
      collectArtifacts([{ path: 'dist/a', bytes: 3, kind: 'file', sha256: 'zz' }]).refused[0]!
        .reason,
    ).toBe('no_content_hash');
    const ok = collectArtifacts([
      { path: 'dist/a', bytes: 3, kind: 'file', sha256: 'a'.repeat(64) },
    ]);
    expect(ok.accepted).toHaveLength(1);
  });
  it('rejects a negative or fractional size and bounds echoed paths', () => {
    expect(collectArtifacts([f('dist/a', 'x', { bytes: -1 })]).refused[0]!.reason).toBe(
      'size_invalid',
    );
    expect(collectArtifacts([f('dist/a', 'x', { bytes: 1.5 })]).refused[0]!.reason).toBe(
      'size_invalid',
    );
    const long = collectArtifacts([f('d/' + 'a'.repeat(1000), 'x')]);
    expect(long.refused[0]!.path.length).toBeLessThanOrEqual(120);
  });
});
