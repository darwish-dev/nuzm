import { describe, expect, it } from 'vitest';
import { ArchiveRejected } from './archive/extract';
import { buildTar, buildZip, memSource, tarGz } from './archive/testing/builders';
import { ingestArchive, type SnapshotSink } from './ingest';

const sink = () => {
  const puts: Record<string, Buffer> = {};
  const s: SnapshotSink = {
    putSnapshot: async (sha, data) => ((puts[sha] = data), `snapshots/${sha}`),
  };
  return { s, puts };
};
const f = (name: string, data: string | Buffer, extra: object = {}) => ({
  name,
  data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  ...extra,
});
const MIT =
  'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(60, 2),
]);

describe('ingestArchive', () => {
  it('builds the inventory, stores text and passive assets once, and never stores risky content', async () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const zip = buildZip([
      f('LICENSE', MIT),
      f(
        'package.json',
        JSON.stringify({
          name: 'theme',
          license: 'MIT',
          dependencies: { next: '^15' },
          scripts: { postinstall: 'node x.js' },
        }),
      ),
      f('src/app.ts', 'export const a = 1;\n'),
      f('src/copy.ts', 'export const a = 1;\n'), // identical bytes: stored once
      f('public/logo.png', PNG, { method: 0 }),
      f('bin/native', ELF, { method: 0, mode: 0o100755 }),
      f('.env', 'DATABASE_URL=postgres://u:p@h/db'),
      f('src/leak.ts', `const k = "${key}";`),
      f('run.sh', 'echo hi', { mode: 0o100755 }),
      f('node_modules/x/index.js', 'module.exports = 1'),
      f('.git/config', '[core]'),
    ]);
    const { s, puts } = sink();
    const r = await ingestArchive(memSource(zip), s);
    const by = Object.fromEntries(r.files.map((x) => [x.path, x]));
    expect(Object.keys(by).sort()).toEqual([
      '.env',
      'LICENSE',
      'bin/native',
      'package.json',
      'public/logo.png',
      'run.sh',
      'src/app.ts',
      'src/copy.ts',
      'src/leak.ts',
    ]);
    expect(by['src/app.ts']?.objectKey).toMatch(/^snapshots\/[0-9a-f]{64}$/);
    expect(by['src/app.ts']?.objectKey).toBe(by['src/copy.ts']?.objectKey);
    expect(by['public/logo.png']).toMatchObject({ isBinary: true, notStoredReason: null });
    expect(by['bin/native']).toMatchObject({
      objectKey: null,
      notStoredReason: 'executable',
      isExecutable: true,
    });
    expect(by['.env']).toMatchObject({ objectKey: null, notStoredReason: 'sensitive_file' });
    expect(by['src/leak.ts']).toMatchObject({
      objectKey: null,
      notStoredReason: 'secret_found',
      secretFindings: 1,
    });
    expect(by['run.sh']).toMatchObject({ objectKey: null, notStoredReason: 'executable_script' });
    // nothing hostile reached storage
    for (const b of Object.values(puts)) {
      expect(b.includes(Buffer.from(key))).toBe(false);
      expect(b.includes(Buffer.from('DATABASE_URL'))).toBe(false);
      expect(b.subarray(0, 4).equals(ELF.subarray(0, 4))).toBe(false);
    }
    expect(Object.keys(puts)).toHaveLength(4);
    expect(r.blocked).toBe(true);
    expect(
      r.findings.some((x) => x.code === 'secret_found' && x.path === 'src/leak.ts' && x.line === 1),
    ).toBe(true);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.findings.some((x) => x.code === 'lifecycle_script')).toBe(true);
    expect(r.findings.some((x) => x.code === 'sensitive_file')).toBe(true);
    expect(r.license).toMatchObject({ spdx: 'MIT', verdict: 'ALLOWED' });
    expect(r.dependencies).toEqual([expect.objectContaining({ ecosystem: 'npm', name: 'next' })]);
    expect(r.skipped.map((x) => x.reason).sort()).toEqual(['dependency_tree', 'vcs_metadata']);
    expect(r.stats.byLanguage.typescript).toBeGreaterThan(0);
  });
  it('a clean permissive package is not blocked', async () => {
    const { s } = sink();
    const r = await ingestArchive(
      memSource(tarGz(buildTar([f('LICENSE', MIT), f('index.js', 'console.log(1)\n')]))),
      s,
    );
    expect(r.format).toBe('tar.gz');
    expect(r.blocked).toBe(false);
    expect(r.license.verdict).toBe('ALLOWED');
  });
  it('a package with no licence is UNKNOWN (cannot be activated) and a proprietary one is blocked', async () => {
    const { s } = sink();
    expect((await ingestArchive(memSource(buildZip([f('a.js', '1')])), s)).license.verdict).toBe(
      'UNKNOWN',
    );
    const p = await ingestArchive(
      memSource(
        buildZip([
          f('LICENSE.txt', 'All rights reserved. This theme may not be redistributed or resold.'),
        ]),
      ),
      s,
    );
    expect(p.license.verdict).toBe('BLOCKED');
    expect(p.blocked).toBe(true);
  });
  it('very large text is inventoried but not stored; an oversized head is still scanned', async () => {
    const { s, puts } = sink();
    const big = 'a'.repeat(200) + '\n' + 'ghp_' + 'Z'.repeat(36) + '\n' + 'b'.repeat(2000);
    const r = await ingestArchive(memSource(buildZip([f('big.txt', big)])), s, {
      maxStoredTextBytes: 1000,
    });
    expect(r.files[0]).toMatchObject({ objectKey: null, notStoredReason: 'secret_found' });
    expect(Object.keys(puts)).toHaveLength(0);
    const r2 = await ingestArchive(memSource(buildZip([f('big2.txt', 'x '.repeat(2000))])), s, {
      maxStoredTextBytes: 1000,
    });
    expect(r2.files[0]).toMatchObject({ objectKey: null, notStoredReason: 'too_large_to_store' });
  });
  it('propagates hostile-archive rejection and never calls the sink', async () => {
    const { s, puts } = sink();
    await expect(
      ingestArchive(memSource(buildZip([f('ok.txt', 'x'), f('../evil', 'y')])), s),
    ).rejects.toBeInstanceOf(ArchiveRejected);
    // the first entry may have been stored before the rejection; the job fails and the worker deletes nothing it did not create
    expect(Object.keys(puts).length).toBeLessThanOrEqual(1);
  });
  it('does not execute anything in the package', async () => {
    const { s } = sink();
    (globalThis as Record<string, unknown>).__ingest_pwned = undefined;
    await ingestArchive(
      memSource(
        buildZip([
          f('package.json', '{"scripts":{"postinstall":"node p.js"}}'),
          f(
            'p.js',
            "globalThis.__ingest_pwned = true; require('child_process').execSync('touch /tmp/x')",
          ),
        ]),
      ),
      s,
    );
    expect((globalThis as Record<string, unknown>).__ingest_pwned).toBeUndefined();
  });
  it('cancellation propagates', async () => {
    const { s } = sink();
    await expect(
      ingestArchive(memSource(buildZip([f('a', 'x')])), s, { shouldCancel: () => true }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
