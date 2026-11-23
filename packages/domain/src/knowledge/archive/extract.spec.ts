import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  ArchiveRejected,
  extractArchive,
  type ArchiveRejectCode,
  type ExtractLimits,
} from './extract';
import {
  buildTar,
  buildZip,
  memSource,
  pad,
  paxRecord,
  tarGz,
  tarHeader,
  type TEntry,
  type ZEntry,
} from './testing/builders';

// the bomb and fuzz cases allocate and compress tens of MiB: under a loaded CI machine the default 5 s is too tight
vi.setConfig({ testTimeout: 60_000 });

const files = async (buf: Buffer, limits: Partial<ExtractLimits> = {}, read = true) => {
  const got: Record<string, string> = {};
  const summary = await extractArchive(
    memSource(buf),
    {
      decide: () => (read ? 'read' : { skip: 'test' }),
      onFile: async (e, data) => {
        const parts: Buffer[] = [];
        for await (const c of data) parts.push(c);
        got[e.path] = Buffer.concat(parts).toString('utf8');
      },
    },
    { limits },
  );
  return { got, summary };
};
const rejects = async (
  buf: Buffer,
  code: ArchiveRejectCode,
  limits: Partial<ExtractLimits> = {},
) => {
  const err = await files(buf, limits).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected rejection ${code}`).toBeInstanceOf(ArchiveRejected);
  expect((err as ArchiveRejected).code).toBe(code);
};
const z = (name: string, data = 'x', extra: Partial<ZEntry> = {}): ZEntry => ({
  name,
  data: Buffer.from(data),
  ...extra,
});

describe('well-formed archives', () => {
  it('extracts a ZIP (stored + deflated) and verifies content', async () => {
    const buf = buildZip([
      z('package.json', '{"name":"a"}'),
      z('src/', '', { data: Buffer.alloc(0) }),
      z('src/a.ts', 'export const a = 1;', { method: 0 }),
    ]);
    const { got, summary } = await files(buf);
    expect(got).toEqual({ 'package.json': '{"name":"a"}', 'src/a.ts': 'export const a = 1;' });
    expect(summary).toMatchObject({ format: 'zip', files: 2, directories: 1 });
  });
  it('extracts a tar.gz, long names (pax + GNU) and directories', async () => {
    const long = `${'d/'.repeat(20)}${'n'.repeat(120)}.ts`;
    const pax = Buffer.concat([
      tarHeader({
        name: 'PaxHeader',
        size: paxRecord('path', long).length,
        type: 'x',
        mode: 0o644,
      }),
      pad(paxRecord('path', long)),
    ]);
    const tar = Buffer.concat([
      pax,
      buildTar([{ name: 'ignored-by-pax', data: Buffer.from('pax-body') }], { noEnd: true }),
      buildTar([
        { name: 'a/', type: '5' },
        { name: 'a/b.txt', data: Buffer.from('hello') },
      ]),
    ]);
    const { got, summary } = await files(tarGz(tar));
    expect(got[long]).toBe('pax-body');
    expect(got['a/b.txt']).toBe('hello');
    expect(summary).toMatchObject({ format: 'tar.gz', files: 2, directories: 1 });
  });
  it('skipped entries are never read but still consumed', async () => {
    const { got, summary } = await files(
      buildZip([z('a.txt', 'aaa'), z('b.txt', 'bbb')]),
      {},
      false,
    );
    expect(got).toEqual({});
    expect(summary.skipped).toHaveLength(2);
    const t = await files(
      tarGz(
        buildTar([
          { name: 'a', data: Buffer.from('x'.repeat(2000)) },
          { name: 'b', data: Buffer.from('y') },
        ]),
      ),
      {},
      false,
    );
    expect(t.summary.skipped.map((s) => s.path)).toEqual(['a', 'b']);
  });
  it('detects the format from bytes, not names', async () => {
    await rejects(Buffer.from('this is not an archive at all'), 'unsupported_format');
    await rejects(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'unsupported_format');
    await rejects(Buffer.alloc(0), 'corrupt');
  });
});

describe('hostile ZIP: paths', () => {
  it.each([
    ['../evil.txt', 'path_traversal'],
    ['a/../../evil.txt', 'path_traversal'],
    ['/etc/passwd', 'path_traversal'],
    ['C:/Windows/x.dll', 'path_traversal'],
    ['..\\..\\evil.txt', 'path_invalid'],
    ['a\\b.txt', 'path_invalid'],
    ['a/./b.txt', 'path_invalid'],
    ['a//b.txt', 'path_invalid'],
    ['a/b.txt.', 'path_invalid'],
    ['a/b.txt ', 'path_invalid'],
    ['CON.txt', 'path_invalid'],
    ['a/nul', 'path_invalid'],
    ['a\u0000b.txt', 'path_invalid'],
    ['a\u0007b.txt', 'path_invalid'],
    ['a\u202ecod.exe', 'path_invalid'],
    ['a\u200bb.txt', 'path_invalid'],
    ['\ufeffa.txt', 'path_invalid'],
  ] as [string, ArchiveRejectCode][])('rejects %j', async (name, code) => {
    await rejects(buildZip([z(name)]), code);
  });
  it('rejects names that are too long or too deep', async () => {
    await rejects(buildZip([z('a'.repeat(300))]), 'path_invalid');
    await rejects(buildZip([z(`${'d/'.repeat(40)}f.txt`)]), 'too_deep');
    await rejects(buildZip([z(`${'d'.repeat(200)}/${'e'.repeat(200)}/f`)]), 'path_invalid');
  });
  it('rejects case / Unicode collisions and file-vs-directory clashes', async () => {
    await rejects(buildZip([z('README.md'), z('readme.md')]), 'path_collision');
    await rejects(buildZip([z('caf\u00e9.txt'), z('cafe\u0301.txt')]), 'path_collision');
    await rejects(buildZip([z('a'), z('a/b')]), 'path_collision');
    await rejects(buildZip([z('a/b'), z('a')]), 'path_collision');
    await rejects(buildZip([z('a'), z('a/', '')]), 'path_collision');
    await rejects(buildZip([z('same.txt'), z('same.txt')]), 'path_collision');
  });
});

describe('hostile ZIP: entry types and structure', () => {
  it('rejects symlinks, devices, pipes and reparse points', async () => {
    await rejects(buildZip([z('link', '/etc/passwd', { mode: 0o120777 })]), 'symlink');
    await rejects(buildZip([z('dev', '', { mode: 0o060644 })]), 'special_file');
    await rejects(buildZip([z('fifo', '', { mode: 0o010644 })]), 'special_file');
    await rejects(buildZip([z('sock', '', { mode: 0o140644 })]), 'special_file');
    await rejects(buildZip([z('rp', 'x', { dos: 0x400 })]), 'symlink');
  });
  it('rejects encryption and exotic compression', async () => {
    await rejects(buildZip([z('a', 'x', { flags: 1 })]), 'encrypted');
    await rejects(buildZip([z('a', 'x', { flags: 0x40 })]), 'encrypted');
    const b = buildZip([z('a', 'x', { method: 0 })]);
    b.writeUInt16LE(12, b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10); // bzip2 in the directory
    await rejects(b, 'unsupported_method');
  });
  it('rejects a lying size: declared small, real large (decompression bomb)', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    await rejects(
      buildZip([z('a', '', { data: big, declaredUsize: 10, crc: 0 })]),
      'size_mismatch',
    );
  });
  it('rejects a lying size: declared large, real small', async () => {
    await rejects(buildZip([z('a', 'tiny', { declaredUsize: 5000 })]), 'size_mismatch');
  });
  it('rejects a bad CRC', async () => {
    await rejects(buildZip([z('a', 'hello', { crc: 123 })]), 'crc_mismatch');
  });
  it('rejects a stored entry whose sizes disagree', async () => {
    await rejects(buildZip([z('a', 'hello', { method: 0, declaredUsize: 99 })]), 'size_mismatch');
  });
  it('rejects a local header that disagrees with the directory', async () => {
    await rejects(buildZip([z('good.txt', 'x', { localName: 'evil.txt' })]), 'corrupt');
  });
  it('rejects overlapping entries (zip quine / overlapping-file bomb)', async () => {
    const a = buildZip([z('a.txt', 'hello world')]);
    const same = buildZip([z('a.txt', 'hello world'), z('b.txt', 'hello world', { lho: 0 })]);
    expect(a.length).toBeGreaterThan(0);
    await rejects(same, 'overlap');
  });
  it('rejects an entry offset beyond the archive', async () => {
    await rejects(buildZip([z('a.txt', 'x', { lho: 9_999_999 })]), 'overlap');
  });
  it('rejects a directory entry with content, and truncated / garbage directories', async () => {
    await rejects(buildZip([z('d/', 'content', { mode: 0o040755 })]), 'corrupt');
    const b = buildZip([z('a.txt', 'x')]);
    await rejects(b.subarray(0, b.length - 5), 'corrupt');
    await rejects(buildZip([z('a.txt', 'x')], { eocdCdOffset: 3 }), 'corrupt');
    await rejects(buildZip([z('a.txt', 'x')], { disk: 1 }), 'unsupported_format');
  });
  it('rejects too many entries before reading any data', async () => {
    const many = Array.from({ length: 30 }, (_, i) => z(`f${i}.txt`));
    await rejects(buildZip(many), 'too_many_entries', { maxEntries: 10 });
  });
  it('rejects data that is not valid deflate', async () => {
    await rejects(
      buildZip([z('a', 'x', { raw: randomBytes(64), declaredUsize: 100, declaredCsize: 64 })]),
      'corrupt',
    );
  });
  it('is not fooled by junk appended after the archive', async () => {
    const b = buildZip([z('a.txt', 'x')], { trailing: Buffer.from('PK\x03\x04junk') });
    await rejects(b, 'corrupt');
  });
});

describe('decompression bombs', () => {
  it('rejects a high-ratio file by declared size before inflating', async () => {
    const bomb = Buffer.alloc(40 * 1024 * 1024, 0);
    await rejects(buildZip([z('zeros.bin', '', { data: bomb })]), 'ratio_exceeded');
  });
  it('rejects by total size limit', async () => {
    await rejects(
      buildZip([z('a', 'x'.repeat(600)), z('b', 'y'.repeat(600))], undefined),
      'too_large',
      { maxTotalBytes: 1000 },
    );
  });
  it('rejects a single oversized file', async () => {
    await rejects(buildZip([z('a', 'x'.repeat(600))]), 'file_too_large', { maxFileBytes: 500 });
  });
  it('rejects a tar.gz bomb while streaming', async () => {
    const tar = buildTar([{ name: 'zeros', data: Buffer.alloc(30 * 1024 * 1024, 0) }]);
    await rejects(tarGz(tar), 'ratio_exceeded');
  });
  it('rejects a tar header that promises more than the stream holds', async () => {
    const tar = Buffer.concat([
      tarHeader({ name: 'a', size: 100000, type: '0', mode: 0o644 }),
      Buffer.alloc(512),
    ]);
    await rejects(gzipSync(tar), 'corrupt');
  });
  it('stays under the time budget', async () => {
    let t = 0;
    const err = await extractArchive(
      memSource(buildZip([z('a', 'x'), z('b', 'y')])),
      { decide: () => 'read', onFile: async () => void (t += 1_000_000) },
      { now: () => t, limits: { maxMillis: 10 } },
    ).catch((e: unknown) => e);
    expect((err as ArchiveRejected).code).toBe('timeout');
  });
  it('honours cancellation', async () => {
    const err = await extractArchive(memSource(buildZip([z('a', 'x')])), {
      decide: () => 'read',
      onFile: async () => undefined,
      shouldCancel: () => true,
    }).catch((e: unknown) => e);
    expect((err as ArchiveRejected).code).toBe('cancelled');
  });
});

describe('hostile tar.gz', () => {
  const tg = (e: TEntry[]) => tarGz(buildTar(e));
  it.each([
    [{ name: 'l', type: '2', linkname: '/etc/passwd' }, 'symlink'],
    [{ name: 'h', type: '1', linkname: 'a' }, 'hardlink'],
    [{ name: 'dev', type: '3' }, 'special_file'],
    [{ name: 'blk', type: '4' }, 'special_file'],
    [{ name: 'fifo', type: '6' }, 'special_file'],
    [{ name: 'sparse', type: 'S' }, 'unsupported_format'],
    [{ name: 'weird', type: 'Z' }, 'unsupported_format'],
    [{ name: '../evil', data: Buffer.from('x') }, 'path_traversal'],
    [{ name: '/abs', data: Buffer.from('x') }, 'path_traversal'],
    [{ name: 'a/../../b', data: Buffer.from('x') }, 'path_traversal'],
    [{ name: 'a\\b', data: Buffer.from('x') }, 'path_invalid'],
  ] as [TEntry, ArchiveRejectCode][])('rejects %j', async (e, code) => {
    await rejects(tg([e]), code);
  });
  it('rejects collisions', async () => {
    await rejects(
      tg([
        { name: 'A', data: Buffer.from('1') },
        { name: 'a', data: Buffer.from('2') },
      ]),
      'path_collision',
    );
  });
  it('rejects a bad header checksum and truncated archives', async () => {
    const tar = buildTar([{ name: 'a', data: Buffer.from('x') }]);
    tar[10] = 0x7a;
    await rejects(gzipSync(tar), 'corrupt');
    const ok = buildTar([{ name: 'a', data: Buffer.from('x'.repeat(2000)) }]);
    await rejects(gzipSync(ok.subarray(0, 700)), 'corrupt');
  });
  it('rejects a corrupt gzip stream and gzip that is not a tar', async () => {
    const g = tg([{ name: 'a', data: Buffer.from('x') }]);
    g[g.length - 12] = (g[g.length - 12] ?? 0) ^ 0xff;
    await rejects(g, 'corrupt');
    await rejects(
      gzipSync(Buffer.from('just some text, definitely not a tar archive'.repeat(30))),
      'corrupt',
    );
  });
  it('rejects a pax size that disagrees (cannot smuggle a larger body)', async () => {
    const px = paxRecord('size', '-5');
    const tar = Buffer.concat([
      tarHeader({ name: 'p', size: px.length, type: 'x', mode: 0o644 }),
      pad(px),
      buildTar([{ name: 'a', data: Buffer.from('x') }]),
    ]);
    await rejects(gzipSync(tar), 'corrupt');
  });
  it('rejects binary size fields and oversize metadata records', async () => {
    const hd = tarHeader({ name: 'a', size: 1, type: '0', mode: 0o644 });
    hd[124] = 0x80;
    hd.write('        ', 148);
    hd.write(
      `${[...hd]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
    );
    await rejects(gzipSync(Buffer.concat([hd, Buffer.alloc(1024)])), 'unsupported_format');
    const big = tarHeader({ name: 'x', size: 5 * 1024 * 1024, type: 'x', mode: 0o644 });
    await rejects(gzipSync(Buffer.concat([big, Buffer.alloc(1024)])), 'too_large');
  });
  it('rejects too many entries', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }));
    await rejects(tg(many), 'too_many_entries', { maxEntries: 10 });
  });
  it('rejects an empty gzip', async () => {
    await rejects(gzipSync(Buffer.alloc(0)), 'corrupt');
  });
  it('handles a stream that errors mid-way', async () => {
    const buf = tg([{ name: 'a', data: Buffer.from('x'.repeat(5000)) }]);
    const src = {
      size: buf.length,
      readRange: async (o: number, l: number) => buf.subarray(o, o + l),
      openStream: async () =>
        new Readable({
          read() {
            this.push(buf.subarray(0, 30));
            this.destroy(new Error('disk gone'));
          },
        }),
    };
    const err = await extractArchive(src, {
      decide: () => 'read',
      onFile: async (_e, d) => void (await d[Symbol.asyncIterator]().next()),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveRejected);
  });
});

describe('no code runs', () => {
  it('extracting a package full of scripts only yields bytes', async () => {
    const marker = `${process.pid}-${Date.now()}`;
    (globalThis as Record<string, unknown>).__pwned = undefined;
    const js = `globalThis.__pwned='${marker}'`;
    const { got } = await files(
      buildZip([
        z('postinstall.js', js),
        z('package.json', '{"scripts":{"postinstall":"node postinstall.js"}}'),
        z('run.sh', 'touch /tmp/pwned', { mode: 0o100755 }),
      ]),
    );
    expect(got['postinstall.js']).toBe(js);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe('fuzz: any corruption is a clean rejection, never a crash or a hang', () => {
  const zipOk = buildZip([
    z('package.json', '{"name":"a"}'),
    z('src/index.ts', 'export const a = 1;'.repeat(20)),
    z('assets/logo.svg', '<svg/>', { method: 0 }),
  ]);
  const tarOk = tarGz(
    buildTar([
      { name: 'a/', type: '5' },
      { name: 'a/b.txt', data: Buffer.from('hello'.repeat(50)) },
      { name: 'c.md', data: Buffer.from('# c') },
    ]),
  );
  const mutate = (base: Buffer, edits: [number, number][], cut: number) => {
    const b = Buffer.from(base);
    for (const [pos, val] of edits) b[pos % b.length] = val;
    return cut > 0 ? b.subarray(0, Math.max(1, b.length - (cut % b.length))) : b;
  };
  it.each([
    ['zip', zipOk],
    ['tar.gz', tarOk],
  ])('%s: random byte edits and truncations', async (_n, base) => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(100_000), fc.nat(255)), { maxLength: 6 }),
        fc.nat(60),
        async (edits, cut) => {
          const out = await files(mutate(base, edits, cut), { maxTotalBytes: 1 << 20 }).then(
            () => 'ok',
            (e: unknown) => (e instanceof ArchiveRejected ? e.code : `CRASH ${String(e)}`),
          );
          expect(out.startsWith('CRASH')).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
  it('random bytes are never accepted', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 3000 }), async (bytes) => {
        const r = await files(Buffer.from(bytes)).then(
          () => 'ok',
          (e: unknown) => (e instanceof ArchiveRejected ? e.code : 'CRASH'),
        );
        expect(['unsupported_format', 'corrupt']).toContain(r);
      }),
      { numRuns: 300 },
    );
  });
  it('accepted paths never escape: every extracted name is relative, clean and unique', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 8 }),
        async (names) => {
          const out = await files(buildZip(names.map((n) => z(n)))).then(
            (r) => Object.keys(r.got),
            () => null,
          );
          if (!out) return;
          for (const p of out) {
            expect(p.startsWith('/')).toBe(false);
            expect(p.split('/')).not.toContain('..');
            // eslint-disable-next-line no-control-regex -- asserting that control characters never survive
            expect(p).not.toMatch(/[\\\u0000-\u001f]/);
          }
          const keys = out.map((p) => p.normalize('NFKC').toLowerCase());
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 500 },
    );
  });
});
