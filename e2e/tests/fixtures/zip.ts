import { crc32 } from 'node:zlib';

/**
 * A minimal ZIP writer (method 0, "stored": no compression) for test fixtures. The files are plain text or deterministic bytes; nothing here is executable and
 * nothing in the platform opens the archive in slice S-K1 (it is only quarantined).
 */
export interface ZipEntry {
  path: string;
  data: Buffer | string;
}
const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = 0x5a21; // 2025-01-01

export function zip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(DOS_TIME, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/** Deterministic, incompressible-looking bytes (xorshift32): the same size and seed always give the same file, so a checksum can be asserted across runs. */
export function filler(bytes: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < bytes; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out.writeUInt32LE(x, Math.min(i, bytes - 4 < 0 ? 0 : bytes - 4));
  }
  return out;
}
