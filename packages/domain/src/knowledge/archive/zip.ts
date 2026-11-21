import { crc32, createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';
import { ArchiveRejected, type ExtractLimits } from './errors';
import { checkEntryPath } from './paths';
import type {
  ArchiveSource,
  EntryInfo,
  ExtractContext,
  ExtractHandlers,
  ExtractSummary,
} from './types';

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  lho: number;
  isDirectory: boolean;
  unixExecutable: boolean;
}
const CHUNK = 256 * 1024;
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => {
  const v = b.readBigUInt64LE(o);
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ArchiveRejected('too_large', 'an archive field is larger than this platform accepts');
  return Number(v);
};

/** Reads and validates the central directory without touching any file data. Everything here is structure: counts, sizes, offsets, types, names. */
export async function parseZipDirectory(
  src: ArchiveSource,
  limits: ExtractLimits,
): Promise<ZipEntry[]> {
  if (src.size < 22)
    throw new ArchiveRejected('corrupt', 'the archive is too small to be a ZIP file');
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await src.readRange(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new ArchiveRejected('corrupt', 'no ZIP end-of-central-directory record was found');
  const eocdAbs = src.size - tailLen + eocd;
  let disk = tail.readUInt16LE(eocd + 4);
  let cdDisk = tail.readUInt16LE(eocd + 6);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (eocdAbs < 20) throw new ArchiveRejected('corrupt', 'a ZIP64 archive has no ZIP64 locator');
    const loc = await src.readRange(eocdAbs - 20, 20);
    if (u32(loc, 0) !== 0x07064b50)
      throw new ArchiveRejected('corrupt', 'a ZIP64 archive has no ZIP64 locator');
    const z64 = u64(loc, 8);
    if (z64 + 56 > src.size)
      throw new ArchiveRejected('corrupt', 'the ZIP64 record is outside the archive');
    const rec = await src.readRange(z64, 56);
    if (u32(rec, 0) !== 0x06064b50)
      throw new ArchiveRejected('corrupt', 'the ZIP64 record is malformed');
    disk = rec.readUInt32LE(16);
    cdDisk = rec.readUInt32LE(20);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (disk !== 0 || cdDisk !== 0)
    throw new ArchiveRejected('unsupported_format', 'multi-disk ZIP archives are not accepted');
  if (count > limits.maxEntries)
    throw new ArchiveRejected(
      'too_many_entries',
      `the archive has ${count} entries; the limit is ${limits.maxEntries}`,
    );
  if (cdSize > limits.maxMetadataBytes)
    throw new ArchiveRejected('too_large', 'the ZIP directory is unreasonably large');
  if (cdOffset + cdSize > eocdAbs)
    throw new ArchiveRejected('corrupt', 'the ZIP directory extends past the end of the archive');
  const cd = await src.readRange(cdOffset, cdSize);
  if (cd.length !== cdSize) throw new ArchiveRejected('corrupt', 'the ZIP directory is truncated');

  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50)
      throw new ArchiveRejected('corrupt', 'the ZIP directory is malformed');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = u32(cd, p + 16);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const extAttr = u32(cd, p + 38);
    let lho = u32(cd, p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ArchiveRejected('corrupt', 'a ZIP directory entry is truncated');
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      let found = false;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) {
            usize = u64(extra, r);
            r += 8;
          }
          if (csize === 0xffffffff) {
            csize = u64(extra, r);
            r += 8;
          }
          if (lho === 0xffffffff) lho = u64(extra, r);
          found = true;
          break;
        }
        q += 4 + len;
      }
      if (!found) throw new ArchiveRejected('corrupt', 'a ZIP64 entry has no ZIP64 extra field');
    }
    if (flags & 0x1 || flags & 0x40)
      throw new ArchiveRejected('encrypted', 'the archive contains encrypted entries');
    if (method !== 0 && method !== 8)
      throw new ArchiveRejected(
        'unsupported_method',
        `an entry uses compression method ${method}; only stored and deflate are accepted`,
      );
    const name = Buffer.from(rawName).toString('utf8');
    // entry type: Unix mode from a Unix-made archive, DOS attributes otherwise
    const host = madeBy >> 8;
    let mode = 0;
    if (host === 3) {
      mode = extAttr >>> 16;
      const type = mode & 0o170000;
      if (type === 0o120000)
        throw new ArchiveRejected('symlink', 'the archive contains a symbolic link');
      if (type !== 0 && type !== 0o100000 && type !== 0o040000)
        throw new ArchiveRejected(
          'special_file',
          'the archive contains a device, pipe or socket entry',
        );
    }
    if ((extAttr & 0x400) !== 0)
      throw new ArchiveRejected('symlink', 'the archive contains a reparse point (link)');
    const isDirectory =
      name.endsWith('/') || (extAttr & 0x10) !== 0 || (mode & 0o170000) === 0o040000;
    if (isDirectory && usize > 0)
      throw new ArchiveRejected('corrupt', 'a directory entry has content');
    if (method === 0 && csize !== usize)
      throw new ArchiveRejected(
        'size_mismatch',
        'a stored entry declares different compressed and uncompressed sizes',
      );
    entries.push({
      name,
      flags,
      method,
      crc,
      csize,
      usize,
      lho,
      isDirectory,
      unixExecutable: (mode & 0o111) !== 0,
    });
    p = end;
  }

  // structure: data ranges must be disjoint and inside the archive before the directory
  const files = entries.filter((e) => !e.isDirectory).sort((a, b) => a.lho - b.lho);
  for (let i = 0; i < files.length; i++) {
    const e = files[i]!;
    const minEnd = e.lho + 30 + Buffer.byteLength(e.name, 'utf8') + e.csize;
    const limit = i + 1 < files.length ? files[i + 1]!.lho : cdOffset;
    if (i + 1 < files.length && files[i + 1]!.lho === e.lho)
      throw new ArchiveRejected('overlap', 'two entries share the same data');
    if (minEnd > limit)
      throw new ArchiveRejected(
        'overlap',
        'entries overlap or run past the directory (a ZIP bomb or a crafted archive)',
      );
  }
  return entries;
}

export async function extractZip(
  src: ArchiveSource,
  h: ExtractHandlers,
  ctx: ExtractContext,
): Promise<ExtractSummary> {
  const { limits } = ctx;
  const entries = await parseZipDirectory(src, limits);
  const declared = entries.reduce((s, e) => s + e.usize, 0);
  if (declared > limits.maxTotalBytes)
    throw new ArchiveRejected(
      'too_large',
      `the package would unpack to ${declared} bytes; the limit is ${limits.maxTotalBytes}. Remove dependency or build directories and upload again`,
    );
  if (declared > limits.ratioFloorBytes && declared / Math.max(src.size, 1) > limits.maxTotalRatio)
    throw new ArchiveRejected(
      'ratio_exceeded',
      'the archive expands far more than a real project does (a decompression bomb)',
    );
  const summary: ExtractSummary = {
    format: 'zip',
    entries: entries.length,
    files: 0,
    directories: 0,
    bytes: 0,
    skipped: [],
  };

  for (const e of entries) {
    if (h.shouldCancel?.()) throw new ArchiveRejected('cancelled', 'the job was cancelled');
    if (ctx.now() > ctx.deadline)
      throw new ArchiveRejected('timeout', 'the extraction took longer than its time budget');
    const cp = checkEntryPath(e.name, limits);
    ctx.registry.add(cp);
    if (e.isDirectory) {
      summary.directories++;
      continue;
    }
    if (e.usize > limits.maxFileBytes)
      throw new ArchiveRejected(
        'file_too_large',
        `a file is larger than ${limits.maxFileBytes} bytes`,
      );
    if (e.usize > limits.ratioFloorBytes && e.usize / Math.max(e.csize, 1) > limits.maxEntryRatio)
      throw new ArchiveRejected(
        'ratio_exceeded',
        'a file expands far more than a real file does (a decompression bomb)',
      );
    summary.files++;
    const info: EntryInfo = {
      path: cp.path,
      size: e.usize,
      compressedSize: e.csize,
      unixExecutable: e.unixExecutable,
    };
    const d = h.decide(info);
    if (d !== 'read') {
      summary.skipped.push({ path: cp.path, reason: d.skip });
      continue;
    }
    // the local header must agree with the directory (a mismatch is how some crafted archives hide content)
    const lh = await src.readRange(e.lho, 30);
    if (lh.length < 30 || u32(lh, 0) !== 0x04034b50)
      throw new ArchiveRejected('corrupt', 'a local file header is missing');
    const ln = lh.readUInt16LE(26);
    const lx = lh.readUInt16LE(28);
    const lname = await src.readRange(e.lho + 30, ln);
    if (lname.toString('utf8') !== e.name)
      throw new ArchiveRejected('corrupt', 'a local file header disagrees with the directory');
    const dataOffset = e.lho + 30 + ln + lx;
    if (dataOffset + e.csize > src.size)
      throw new ArchiveRejected('corrupt', 'an entry runs past the end of the archive');
    const data = entryData(src, e, dataOffset, ctx);
    await h.onFile(info, data);
    for await (const _ of data) void _; // drain: size, CRC and limits are verified even if the handler stopped early
    summary.bytes += e.usize;
  }
  return summary;
}

async function* entryData(
  src: ArchiveSource,
  e: ZipEntry,
  dataOffset: number,
  ctx: ExtractContext,
): AsyncGenerator<Buffer> {
  const { limits } = ctx;
  const compressed = (async function* () {
    for (let off = 0; off < e.csize; off += CHUNK) {
      const part = await src.readRange(dataOffset + off, Math.min(CHUNK, e.csize - off));
      if (part.length === 0) throw new ArchiveRejected('corrupt', 'an entry is truncated');
      yield part;
    }
  })();
  let out = 0;
  let crc = 0;
  let stream: AsyncIterable<Buffer>;
  if (e.method === 0) stream = compressed;
  else {
    const inflate = createInflateRaw();
    Readable.from(compressed)
      .on('error', (err) => inflate.destroy(err))
      .pipe(inflate);
    stream = inflate;
  }
  try {
    for await (const chunk of stream) {
      out += chunk.length;
      ctx.total += chunk.length;
      if (out > e.usize)
        throw new ArchiveRejected(
          'size_mismatch',
          'an entry is larger than its declared size (a decompression bomb or a crafted archive)',
        );
      if (ctx.total > limits.maxTotalBytes)
        throw new ArchiveRejected(
          'too_large',
          'the package unpacks to more than the total size limit',
        );
      if (out > limits.ratioFloorBytes && out / Math.max(e.csize, 1) > limits.maxEntryRatio)
        throw new ArchiveRejected(
          'ratio_exceeded',
          'an entry expands far more than a real file does',
        );
      if (ctx.now() > ctx.deadline)
        throw new ArchiveRejected('timeout', 'the extraction took longer than its time budget');
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } catch (err) {
    if (err instanceof ArchiveRejected) throw err;
    throw new ArchiveRejected('corrupt', 'an entry could not be decompressed');
  }
  if (out !== e.usize)
    throw new ArchiveRejected('size_mismatch', 'an entry is shorter than its declared size');
  if (crc >>> 0 !== e.crc)
    throw new ArchiveRejected('crc_mismatch', 'an entry does not match its checksum');
}
