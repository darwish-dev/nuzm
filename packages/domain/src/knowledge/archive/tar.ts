import { createGunzip } from 'node:zlib';
import { ArchiveRejected } from './errors';
import { checkEntryPath } from './paths';
import type {
  ArchiveSource,
  EntryInfo,
  ExtractContext,
  ExtractHandlers,
  ExtractSummary,
} from './types';

/** Pull-based reader over a byte stream with exact-length reads. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  consumed = 0;
  private readonly it: AsyncIterator<Buffer>;
  constructor(
    source: AsyncIterable<Buffer>,
    private readonly onBytes: (total: number) => void,
  ) {
    this.it = source[Symbol.asyncIterator]();
  }
  private async fill(): Promise<boolean> {
    if (this.done) return false;
    let r: IteratorResult<Buffer>;
    try {
      r = await this.it.next();
    } catch (err) {
      if (err instanceof ArchiveRejected) throw err;
      throw new ArchiveRejected('corrupt', 'the archive could not be decompressed');
    }
    if (r.done) {
      this.done = true;
      return false;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    return true;
  }
  /** Exactly `n` bytes, or fewer only at the end of the stream. */
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n && (await this.fill())) void 0;
    const out = this.buf.subarray(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    this.consumed += out.length;
    this.onBytes(this.consumed);
    return out;
  }
  /** Up to `max` bytes of whatever is next (at least one unless at the end). */
  async chunk(max: number): Promise<Buffer> {
    if (this.buf.length === 0) await this.fill();
    const out = this.buf.subarray(0, Math.min(max, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    this.consumed += out.length;
    this.onBytes(this.consumed);
    return out;
  }
  async skip(n: number): Promise<void> {
    while (n > 0) {
      const c = await this.chunk(n);
      if (c.length === 0) throw new ArchiveRejected('corrupt', 'the archive is truncated');
      n -= c.length;
    }
  }
  destroy(): void {
    void this.it.return?.();
  }
}

const field = (b: Buffer, off: number, len: number): string => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
};
function octal(b: Buffer, off: number, len: number): number {
  if (b[off]! & 0x80)
    throw new ArchiveRejected('unsupported_format', 'a tar entry uses a binary size field');
  const s = field(b, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s))
    throw new ArchiveRejected('corrupt', 'a tar header has an invalid number');
  return parseInt(s, 8);
}
function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === octal(h, 148, 8);
}
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) throw new ArchiveRejected('corrupt', 'a tar extended header is malformed');
    const len = parseInt(data.subarray(p, sp).toString('ascii'), 10);
    if (!Number.isInteger(len) || len <= sp - p + 1 || p + len > data.length)
      throw new ArchiveRejected('corrupt', 'a tar extended header is malformed');
    const rec = data.subarray(sp + 1, p + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

export async function extractTarGz(
  src: ArchiveSource,
  h: ExtractHandlers,
  ctx: ExtractContext,
): Promise<ExtractSummary> {
  const { limits } = ctx;
  const gunzip = createGunzip();
  const raw = await src.openStream();
  raw.on('error', (e) => gunzip.destroy(e));
  raw.pipe(gunzip);
  const rd = new ByteReader(gunzip, (total) => {
    // the stream is bounded as a whole: headers and padding count too, so a tar of nothing but metadata cannot run forever
    if (total > limits.maxTotalBytes + limits.maxEntries * 1024 + 2048)
      throw new ArchiveRejected(
        'too_large',
        'the archive unpacks to more than the total size limit',
      );
    if (total > limits.ratioFloorBytes && total / Math.max(src.size, 1) > limits.maxTotalRatio)
      throw new ArchiveRejected(
        'ratio_exceeded',
        'the archive expands far more than a real project does (a decompression bomb)',
      );
    if (ctx.now() > ctx.deadline)
      throw new ArchiveRejected('timeout', 'the extraction took longer than its time budget');
  });
  const summary: ExtractSummary = {
    format: 'tar.gz',
    entries: 0,
    files: 0,
    directories: 0,
    bytes: 0,
    skipped: [],
  };
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let sawEnd = false;
  try {
    for (;;) {
      if (h.shouldCancel?.()) throw new ArchiveRejected('cancelled', 'the job was cancelled');
      const hd = await rd.read(512);
      if (hd.length === 0) break;
      if (hd.length < 512) throw new ArchiveRejected('corrupt', 'the archive is truncated');
      if (hd.every((x) => x === 0)) {
        sawEnd = true;
        break;
      }
      if (!checksumOk(hd)) throw new ArchiveRejected('corrupt', 'a tar header failed its checksum');
      const type = String.fromCharCode(hd[156] || 0x30);
      let size = octal(hd, 124, 12);
      const mode = octal(hd, 100, 8);
      const padded = Math.ceil(size / 512) * 512;

      if (type === 'x' || type === 'L' || type === 'g' || type === 'K') {
        if (size > limits.maxMetadataBytes || size > 1024 * 1024)
          throw new ArchiveRejected('too_large', 'a tar metadata record is unreasonably large');
        const data = await rd.read(padded);
        if (data.length < padded) throw new ArchiveRejected('corrupt', 'the archive is truncated');
        const body = data.subarray(0, size);
        if (type === 'x') pax = { ...pax, ...parsePax(body) };
        else if (type === 'L') longName = field(body, 0, body.length);
        else if (type === 'K') throw new ArchiveRejected('symlink', 'the archive contains a link');
        continue;
      }
      if (pax.size !== undefined) {
        const s = Number(pax.size);
        if (!Number.isSafeInteger(s) || s < 0)
          throw new ArchiveRejected('corrupt', 'a tar header has an invalid size');
        size = s;
      }
      const prefix = field(hd, 345, 155);
      const base = field(hd, 0, 100);
      const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
      pax = {};
      longName = null;

      if (type === '2')
        throw new ArchiveRejected('symlink', 'the archive contains a symbolic link');
      if (type === '1') throw new ArchiveRejected('hardlink', 'the archive contains a hard link');
      if (type === '3' || type === '4' || type === '6')
        throw new ArchiveRejected(
          'special_file',
          'the archive contains a device, pipe or socket entry',
        );
      if (type === 'S')
        throw new ArchiveRejected('unsupported_format', 'sparse tar entries are not accepted');
      if (type !== '0' && type !== '5' && type !== '7')
        throw new ArchiveRejected(
          'unsupported_format',
          `a tar entry has the unsupported type "${type}"`,
        );

      summary.entries++;
      if (summary.entries > limits.maxEntries)
        throw new ArchiveRejected(
          'too_many_entries',
          `the archive has more than ${limits.maxEntries} entries`,
        );
      const cp = checkEntryPath(type === '5' && !name.endsWith('/') ? `${name}/` : name, limits);
      ctx.registry.add(cp);
      if (type === '5') {
        summary.directories++;
        continue;
      }
      if (size > limits.maxFileBytes)
        throw new ArchiveRejected(
          'file_too_large',
          `a file is larger than ${limits.maxFileBytes} bytes`,
        );
      summary.files++;
      const info: EntryInfo = { path: cp.path, size, unixExecutable: (mode & 0o111) !== 0 };
      const pad = Math.ceil(size / 512) * 512 - size;
      const d = h.decide(info);
      if (d !== 'read') {
        summary.skipped.push({ path: cp.path, reason: d.skip });
        await rd.skip(size + pad);
        continue;
      }
      let left = size;
      const data = (async function* () {
        while (left > 0) {
          const c = await rd.chunk(Math.min(left, 256 * 1024));
          if (c.length === 0) throw new ArchiveRejected('corrupt', 'the archive is truncated');
          left -= c.length;
          ctx.total += c.length;
          if (ctx.total > limits.maxTotalBytes)
            throw new ArchiveRejected(
              'too_large',
              'the package unpacks to more than the total size limit',
            );
          yield c;
        }
      })();
      await h.onFile(info, data);
      for await (const _ of data) void _;
      summary.bytes += size;
      if (pad) await rd.skip(pad);
    }
    if (!sawEnd && rd.consumed === 0) throw new ArchiveRejected('corrupt', 'the archive is empty');
  } finally {
    rd.destroy();
    gunzip.destroy();
    raw.destroy();
  }
  return summary;
}
