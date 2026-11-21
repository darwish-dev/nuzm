import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { ArchiveSource } from '../types';

export const memSource = (buf: Buffer): ArchiveSource => ({
  size: buf.length,
  readRange: async (o, l) => buf.subarray(o, o + l),
  openStream: async () => Readable.from([buf]),
});

export interface ZEntry {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** Unix mode incl. type bits, written as made-by Unix. */
  mode?: number;
  flags?: number;
  /** Lies, to build hostile archives. */
  declaredUsize?: number;
  declaredCsize?: number;
  crc?: number;
  localName?: string;
  lho?: number;
  dos?: number;
  raw?: Buffer;
}

/** Builds a ZIP exactly as told, including inconsistent ones that real tools refuse to write. */
export function buildZip(
  entries: ZEntry[],
  opts: { eocdCount?: number; eocdCdOffset?: number; trailing?: Buffer; disk?: number } = {},
): Buffer {
  const parts: Buffer[] = [];
  const dir: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const comp = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(e.name, 'utf8');
    const lname = Buffer.from(e.localName ?? e.name, 'utf8');
    const crc = e.crc ?? crc32(data);
    const csize = e.declaredCsize ?? comp.length;
    const usize = e.declaredUsize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(lname.length, 26);
    const start = off;
    parts.push(lh, lname, comp);
    off += 30 + lname.length + comp.length;
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);
    ch.writeUInt32LE(((mode << 16) | (e.dos ?? 0)) >>> 0, 38);
    ch.writeUInt32LE(e.lho ?? start, 42);
    dir.push(ch, name);
  }
  const cd = Buffer.concat(dir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.disk ?? 0, 4);
  eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(opts.eocdCdOffset ?? off, 16);
  return Buffer.concat([...parts, cd, eocd, opts.trailing ?? Buffer.alloc(0)]);
}

export interface TEntry {
  name: string;
  data?: Buffer;
  type?: string;
  mode?: number;
  linkname?: string;
  size?: number;
}
function tarHeader(e: {
  name: string;
  size: number;
  type: string;
  mode: number;
  linkname?: string;
}): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name.slice(0, 100), 0, 'utf8');
  h.write(e.mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(e.size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(e.type, 156);
  if (e.linkname) h.write(e.linkname, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b: Buffer) =>
  b.length % 512 === 0 ? b : Buffer.concat([b, Buffer.alloc(512 - (b.length % 512))]);
export function buildTar(entries: TEntry[], opts: { noEnd?: boolean } = {}): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    out.push(
      tarHeader({
        name: e.name,
        size: e.size ?? data.length,
        type: e.type ?? (e.name.endsWith('/') ? '5' : '0'),
        mode: e.mode ?? 0o644,
        linkname: e.linkname,
      }),
    );
    if (data.length) out.push(pad(data));
  }
  if (!opts.noEnd) out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}
export const tarGz = (tar: Buffer): Buffer => gzipSync(tar);
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.from(`${len}${body}`);
}
export { tarHeader, pad };
