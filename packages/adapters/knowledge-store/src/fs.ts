import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { KnowledgeObjectStore, ObjectStoreError, checkKey, type ComposeResult } from './port';

/** DEVELOPMENT AND TEST ONLY: objects are files under `root`. Refuses to be constructed in production. */
export class FsObjectStore extends KnowledgeObjectStore {
  private readonly root: string;
  constructor(root: string) {
    super();
    if (process.env.NODE_ENV === 'production')
      throw new Error(
        'the filesystem object store is for development only: configure the provider adapter (D-42)',
      );
    this.root = resolve(root);
  }
  private path(key: string): string {
    const p = resolve(this.root, checkKey(key));
    if (p !== this.root && !p.startsWith(this.root + sep))
      throw new ObjectStoreError('invalid_key', 'invalid object key');
    return p;
  }
  private partKey = (uploadId: string, n: number) => `uploads/${uploadId}/part-${n}`;

  async putPart(uploadId: string, partNumber: number, data: Buffer): Promise<void> {
    const p = this.path(this.partKey(uploadId, partNumber));
    await fs.mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, p);
  }

  async compose(
    uploadId: string,
    partNumbers: number[],
    expectedSha256: string,
  ): Promise<ComposeResult> {
    const tmp = this.path(`uploads/${uploadId}/composed-${randomBytes(4).toString('hex')}.tmp`);
    await fs.mkdir(dirname(tmp), { recursive: true });
    const hash = createHash('sha256');
    const out = createWriteStream(tmp, { mode: 0o600 });
    let bytes = 0;
    try {
      for (const n of partNumbers) {
        for await (const chunk of createReadStream(this.path(this.partKey(uploadId, n)))) {
          const buf = chunk as Buffer;
          hash.update(buf);
          bytes += buf.length;
          if (!out.write(buf)) await once(out, 'drain');
        }
      }
      out.end();
      await once(out, 'finish');
    } catch (e) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      throw e;
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256) {
      await fs.rm(tmp, { force: true });
      return { mismatch: true as const, sha256, bytes };
    }
    const key = `archives/${sha256}`;
    const dest = this.path(key);
    await fs.mkdir(dirname(dest), { recursive: true });
    if (await this.exists(key)) {
      await fs.rm(tmp, { force: true });
      return { key, sha256, bytes, deduplicated: true };
    }
    await fs.rename(tmp, dest);
    await fs.chmod(dest, 0o400);
    return { key, sha256, bytes, deduplicated: false };
  }

  async exists(key: string): Promise<boolean> {
    const p = this.path(key);
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
  async size(key: string): Promise<number | null> {
    try {
      return (await fs.stat(this.path(key))).size;
    } catch {
      return null;
    }
  }
  async read(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ObjectStoreError('not_found', 'object not found');
      throw e;
    }
  }
  async open(key: string): Promise<Readable> {
    const p = this.path(key);
    await fs.access(p).catch(() => {
      throw new ObjectStoreError('not_found', 'object not found');
    });
    return createReadStream(p);
  }
  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    const h = await fs.open(this.path(key), 'r').catch(() => {
      throw new ObjectStoreError('not_found', 'object not found');
    });
    try {
      const size = (await h.stat()).size;
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(n);
      if (n > 0) await h.read(buf, 0, n, offset);
      return buf;
    } finally {
      await h.close();
    }
  }
  async put(
    key: string,
    data: Buffer,
    opts: { ifAbsent?: boolean } = {},
  ): Promise<{ existed: boolean }> {
    const p = this.path(key);
    if (opts.ifAbsent && (await this.exists(key))) return { existed: true };
    await fs.mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, p);
    await fs.chmod(p, 0o400).catch(() => undefined);
    return { existed: false };
  }
  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await fs.chmod(p, 0o600).catch(() => undefined);
    await fs.rm(p, { force: true });
  }
  async discardUpload(uploadId: string): Promise<void> {
    await fs.rm(join(this.root, 'uploads', uploadId), { recursive: true, force: true });
  }
  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    // there is no network endpoint in development: a clearly non-fetchable reference, so no caller treats it as a real URL
    return Promise.resolve(`dev-store://${checkKey(key)}?ttl=${ttlSeconds}`);
  }
}
