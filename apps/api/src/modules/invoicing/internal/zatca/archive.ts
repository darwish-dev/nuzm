import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Archive of issued e-invoice XML (docs/11 §5, D-34 retention, D-14/D-15 in-Kingdom storage). WORM semantics: an object is written once;
 * writing different bytes under an existing key is refused, writing the same bytes again is a no-op, and reading verifies the checksum.
 * The implementation here is a LOCAL directory (development); an in-Kingdom object store is a deployment decision (M04, D-15). The database
 * keeps the authoritative copy of the XML as well, so a missing or damaged object is detected and repairable, never silent.
 */
export interface ArchiveStore {
  put(key: string, bytes: Buffer): Promise<{ ref: string; sha256: string }>;
  get(ref: string, expectedSha256: string): Promise<Buffer>;
}
export class ArchiveConflict extends Error {
  constructor(key: string) {
    super(`archive object ${key} exists with different content (WORM)`);
    this.name = 'ArchiveConflict';
  }
}
export class ArchiveCorrupt extends Error {
  constructor(ref: string) {
    super(`archive object ${ref} does not match its recorded checksum`);
    this.name = 'ArchiveCorrupt';
  }
}
const KEY = /^[a-z0-9][a-z0-9/_.-]{3,200}$/;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class LocalWormArchive implements ArchiveStore {
  private readonly dir: string;
  constructor(dir = process.env.ZATCA_ARCHIVE_DIR ?? '.local/zatca-archive') {
    this.dir = resolve(dir);
  }
  private path(key: string) {
    if (!KEY.test(key) || key.includes('..')) throw new Error('invalid archive key');
    return join(this.dir, key);
  }
  async put(key: string, bytes: Buffer) {
    const p = this.path(key);
    const digest = sha(bytes);
    if (existsSync(p)) {
      if (sha(readFileSync(p)) !== digest) throw new ArchiveConflict(key);
      return { ref: key, sha256: digest };
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes, { flag: 'wx', mode: 0o444 });
    return { ref: key, sha256: digest };
  }
  async get(ref: string, expectedSha256: string) {
    const b = readFileSync(this.path(ref));
    if (sha(b) !== expectedSha256) throw new ArchiveCorrupt(ref);
    return b;
  }
}
