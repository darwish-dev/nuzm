import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { ProblemException } from '../../../common/errors';

/**
 * Platform object-store port for the AI Intelligence Center (ADR-065, D-42): original archives, extracted snapshots, preview assets and reports live in object
 * storage, never in Postgres. The port is small on purpose; the provider adapter (built on the data module's `ObjectStorageAdapter`, ADR-052) is added when the
 * provider and region are chosen. Until then only the development filesystem adapter exists, and production configuration must refuse it.
 *
 * Keys are relative, lower-case, slash-separated and cannot climb out of the store. Archives are content addressed (`archives/<sha256>`), so identical
 * uploads share one immutable object and an object is never overwritten.
 */
export interface ComposedObject {
  key: string;
  sha256: string;
  bytes: number;
  deduplicated: boolean;
}

export abstract class KnowledgeObjectStore {
  /** Stores one part of an upload (idempotent for the same bytes). */
  abstract putPart(uploadId: string, partNumber: number, data: Buffer): Promise<void>;
  /** Concatenates the parts in order into a content-addressed archive; the caller verifies the checksum BEFORE promoting. */
  abstract compose(
    uploadId: string,
    partNumbers: number[],
    expectedSha256: string,
  ): Promise<ComposedObject | { mismatch: true; sha256: string; bytes: number }>;
  abstract exists(key: string): Promise<boolean>;
  abstract read(key: string): Promise<Buffer>;
  /** Removes every part and temporary object of one upload. Never touches content-addressed archives. */
  abstract discardUpload(uploadId: string): Promise<void>;
  /** Short-lived access to an object for a staff download (S-K1 has none yet): kept in the port so adapters implement it once. */
  abstract signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,380}$/;
const sanitizeKey = (key: string) => {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//'))
    throw new Error('invalid object key');
  return key;
};

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
    const p = resolve(this.root, sanitizeKey(key));
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error('invalid object key');
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

  async compose(uploadId: string, partNumbers: number[], expectedSha256: string) {
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
    await fs.chmod(dest, 0o400); // immutable by convention: a content-addressed object is never rewritten
    return { key, sha256, bytes, deduplicated: false };
  }

  async exists(key: string): Promise<boolean> {
    const p = this.path(key); // an invalid key is an error, not "absent"
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.path(key));
  }
  async discardUpload(uploadId: string): Promise<void> {
    await fs.rm(join(this.root, 'uploads', uploadId), { recursive: true, force: true });
  }
  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    // there is no network endpoint in development: a clearly non-fetchable reference, so no caller treats it as a real URL
    return Promise.resolve(`dev-store://${sanitizeKey(key)}?ttl=${ttlSeconds}`);
  }
}

/**
 * What production gets until the provider adapter exists (D-42): every call answers "not available", so the library cannot silently write to local disk.
 * The library flag stays off in production until a real adapter replaces this.
 */
export class UnconfiguredObjectStore extends KnowledgeObjectStore {
  private fail<T>(): Promise<T> {
    return Promise.reject(
      new ProblemException(
        'not_found',
        'the AI knowledge library is not available: no object store is configured (D-42)',
      ),
    );
  }
  putPart(): Promise<void> {
    return this.fail();
  }
  compose(): Promise<never> {
    return this.fail();
  }
  exists(): Promise<boolean> {
    return this.fail();
  }
  read(): Promise<Buffer> {
    return this.fail();
  }
  discardUpload(): Promise<void> {
    return this.fail();
  }
  signedUrl(): Promise<string> {
    return this.fail();
  }
}

/**
 * Which object store the platform uses (D-42, ADR-065). There is NO production adapter yet: outside production the development filesystem adapter is used;
 * in production the "unconfigured" adapter, which refuses every call, so no package can be written to local disk by accident. `status` says so in words for
 * the readiness report and the tests. When the ADR-052 provider is chosen, a provider adapter is selected here (by configuration) and `status.production`
 * becomes "provider".
 */
export function createKnowledgeObjectStore(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeObjectStore {
  if (env.NODE_ENV === 'production') return new UnconfiguredObjectStore();
  return new FsObjectStore(env.KNOWLEDGE_STORE_DIR ?? join(tmpdir(), 'nuzm-knowledge-store'));
}
export const knowledgeObjectStoreStatus = (env: NodeJS.ProcessEnv = process.env) =>
  env.NODE_ENV === 'production'
    ? ({ adapter: 'unconfigured', production: 'none', blockedBy: 'D-42' } as const)
    : ({ adapter: 'filesystem', production: 'none', blockedBy: 'D-42' } as const);
