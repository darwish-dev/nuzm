import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256 } from '../core';

/** Deterministic tar.gz: sorted paths, fixed mtime 0, uid/gid 0, mode 0644, no extra headers. The same files always give the same bytes (and the same sha256). */
function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  let prefix = '';
  let nm = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name) - cut - 1 > 100)
      throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    nm = name.slice(cut + 1);
  }
  h.write(nm, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime 0
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}
export function tarGz(files: ReadonlyMap<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = Buffer.from(files.get(path)!, 'utf8');
    parts.push(header(path, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
/** Reads an archive produced by `tarGz` (used by the export rebuild test and the artifact verifier). Rejects anything that is not a regular file with a safe path. */
export function untarGz(buf: Buffer): Map<string, string> {
  const tar = gunzipSync(buf);
  const out = new Map<string, string>();
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(h.subarray(124, 135).toString('ascii'), 8);
    const type = String.fromCharCode(h[156]!);
    if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry type for ${full}`);
    if (full.startsWith('/') || full.split('/').includes('..'))
      throw new Error(`unsafe path in archive: ${full}`);
    out.set(full, tar.subarray(off + 512, off + 512 + size).toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
export const archiveSha256 = (buf: Buffer): string => sha256(buf);
