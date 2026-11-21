import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { KnowledgeObjectStore, ObjectStoreError, checkKey, type ComposeResult } from './port';
import { presign, sha256Hex, signHeaders, type Credentials } from './sigv4';

/**
 * S3-compatible object store (D-42). Works with AWS S3, MinIO, Ceph/RGW, Wasabi, Backblaze B2 S3 and the like through configuration only.
 * Safety properties, each proved in `s3.spec.ts` against a signature-verifying fake and re-checkable against a real provider with `selfTest()`:
 *  - the bucket is PRIVATE: no ACL is ever set, reads outside this adapter go through short-lived presigned URLs (SigV4 query signing);
 *  - encryption at rest is REQUIRED and VERIFIED: every write asks for SSE-S3 (`AES256`) or SSE-KMS and the response must confirm it, otherwise the object is
 *    deleted and the write fails (`encryption_not_applied`): a provider that silently ignores the header is not accepted;
 *  - transport is TLS except for loopback endpoints (development), and credentials come from a provider callback (the caller resolves vault references);
 *  - nothing is ever overwritten under a content-addressed key; temporary objects live under `uploads/<id>/` and are removed.
 */
export type Encryption = { type: 'AES256' } | { type: 'aws:kms'; keyId?: string };
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: () => Promise<Credentials>;
  /** Path-style addressing (`https://host/bucket/key`), needed by most non-AWS providers; default true. */
  forcePathStyle?: boolean;
  encryption: Encryption;
  /** Per-request timeout; large part transfers use `partTimeoutMs`. */
  timeoutMs?: number;
  partTimeoutMs?: number;
  /** Retries of idempotent requests on network errors, 429 and 5xx. */
  retries?: number;
  fetch?: typeof fetch;
  /** Size of the parts of a composed archive (S3 needs ≥ 5 MiB except the last). */
  composePartBytes?: number;
}
const isLoopback = (h: string) =>
  h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');

export class S3ObjectStore extends KnowledgeObjectStore {
  private readonly f: typeof fetch;
  constructor(private readonly cfg: S3Config) {
    super();
    const u = new URL(cfg.endpoint);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname)))
      throw new ObjectStoreError(
        'config',
        'the object-store endpoint must use https (http is only allowed for loopback development endpoints)',
      );
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket))
      throw new ObjectStoreError('config', 'invalid bucket name');
    if (
      cfg.encryption.type === 'aws:kms' &&
      cfg.encryption.keyId !== undefined &&
      cfg.encryption.keyId.length < 4
    )
      throw new ObjectStoreError('config', 'invalid KMS key id');
    this.f = cfg.fetch ?? fetch;
  }

  private url(key: string, query: Record<string, string> = {}): URL {
    const u = new URL(this.cfg.endpoint);
    const pathStyle = this.cfg.forcePathStyle !== false;
    if (!pathStyle) u.hostname = `${this.cfg.bucket}.${u.hostname}`;
    const base = u.pathname.replace(/\/$/, '');
    u.pathname = `${base}${pathStyle ? `/${this.cfg.bucket}` : ''}/${key}`;
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }
  private sseHeaders(): Record<string, string> {
    const e = this.cfg.encryption;
    return e.type === 'AES256'
      ? { 'x-amz-server-side-encryption': 'AES256' }
      : {
          'x-amz-server-side-encryption': 'aws:kms',
          ...(e.keyId ? { 'x-amz-server-side-encryption-aws-kms-key-id': e.keyId } : {}),
        };
  }
  private checkEncrypted(res: Response): void {
    const want = this.cfg.encryption;
    const got = res.headers.get('x-amz-server-side-encryption');
    if (got !== want.type)
      throw new ObjectStoreError(
        'encryption_not_applied',
        `the provider did not confirm ${want.type} encryption (got ${got ?? 'none'})`,
      );
  }

  private async req(
    method: string,
    key: string,
    o: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Buffer;
      timeoutMs?: number;
      retry?: boolean;
      ok?: number[];
      expect404?: boolean;
    } = {},
  ): Promise<Response> {
    const retries = o.retry === false ? 0 : (this.cfg.retries ?? 3);
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const url = this.url(key, o.query);
      const creds = await this.cfg.credentials();
      const headers = signHeaders({
        method,
        url,
        headers: {
          ...(o.headers ?? {}),
          ...(o.body ? { 'content-length': String(o.body.length) } : {}),
        },
        payloadHash: sha256Hex(o.body ?? ''),
        creds,
        region: this.cfg.region,
      });
      try {
        const res = await this.f(url, {
          method,
          headers,
          body: o.body ? new Uint8Array(o.body) : undefined,
          signal: AbortSignal.timeout(o.timeoutMs ?? this.cfg.timeoutMs ?? 30_000),
        });
        if (res.ok || (o.expect404 && res.status === 404) || (o.ok ?? []).includes(res.status))
          return res;
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await res.arrayBuffer().catch(() => undefined);
          last = new ObjectStoreError(
            'unavailable',
            `object store answered ${res.status}`,
            res.status,
          );
        } else {
          const body = await res.text().catch(() => '');
          const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
          throw new ObjectStoreError(
            res.status === 404 ? 'not_found' : res.status >= 500 ? 'unavailable' : 'rejected',
            `object store answered ${res.status}${code ? ` ${code}` : ''}`,
            res.status,
          );
        }
      } catch (e) {
        if (e instanceof ObjectStoreError) {
          if (e.code !== 'unavailable' || attempt >= retries) throw e;
          last = e;
        } else if (attempt >= retries)
          throw new ObjectStoreError(
            'unavailable',
            `object store unreachable: ${(e as Error).message}`,
          );
        else last = e;
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt + Math.floor(Math.random() * 50)));
    }
    throw last instanceof Error
      ? last
      : new ObjectStoreError('unavailable', 'object store unavailable');
  }

  private async putEncrypted(key: string, data: Buffer, timeoutMs?: number): Promise<void> {
    const res = await this.req('PUT', checkKey(key), {
      body: data,
      headers: { 'content-type': 'application/octet-stream', ...this.sseHeaders() },
      timeoutMs,
    });
    try {
      this.checkEncrypted(res);
    } catch (e) {
      await this.req('DELETE', key, { ok: [204, 404] }).catch(() => undefined); // an unencrypted object must not stay
      throw e;
    }
  }

  async putPart(uploadId: string, partNumber: number, data: Buffer): Promise<void> {
    await this.putEncrypted(
      `uploads/${uploadId}/part-${partNumber}`,
      data,
      this.cfg.partTimeoutMs ?? 120_000,
    );
  }

  async compose(
    uploadId: string,
    partNumbers: number[],
    expectedSha256: string,
  ): Promise<ComposeResult> {
    const chunk = Math.max(5 * 1024 * 1024, this.cfg.composePartBytes ?? 8 * 1024 * 1024);
    const tmp = `uploads/${uploadId}/composed`;
    const hash = createHash('sha256');
    let bytes = 0;
    let uploadIdS3: string | null = null;
    const etags: string[] = [];
    let buf: Buffer[] = [];
    let buffered = 0;
    const flushPart = async () => {
      const body = Buffer.concat(buf);
      buf = [];
      buffered = 0;
      const n = etags.length + 1;
      const res = await this.req('PUT', tmp, {
        query: { partNumber: String(n), uploadId: uploadIdS3! },
        body,
        timeoutMs: this.cfg.partTimeoutMs ?? 120_000,
      });
      etags.push(res.headers.get('etag') ?? '');
    };
    try {
      let single: Buffer | null = null;
      for (const n of partNumbers) {
        const res = await this.req('GET', `uploads/${uploadId}/part-${n}`, {
          timeoutMs: this.cfg.partTimeoutMs ?? 120_000,
        });
        const data = Buffer.from(await res.arrayBuffer());
        hash.update(data);
        bytes += data.length;
        buf.push(data);
        buffered += data.length;
        if (uploadIdS3 === null && bytes > chunk) {
          const c = await this.req('POST', tmp, {
            query: { uploads: '' },
            headers: this.sseHeaders(),
          });
          this.checkEncrypted(c);
          uploadIdS3 = /<UploadId>([^<]+)<\/UploadId>/.exec(await c.text())?.[1] ?? null;
          if (!uploadIdS3)
            throw new ObjectStoreError('rejected', 'the provider returned no multipart upload id');
        }
        while (uploadIdS3 && buffered >= chunk) {
          const all = Buffer.concat(buf);
          buf = [all.subarray(chunk)];
          buffered = all.length - chunk;
          const body = all.subarray(0, chunk);
          const nn = etags.length + 1;
          const r = await this.req('PUT', tmp, {
            query: { partNumber: String(nn), uploadId: uploadIdS3 },
            body,
            timeoutMs: this.cfg.partTimeoutMs ?? 120_000,
          });
          etags.push(r.headers.get('etag') ?? '');
        }
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== expectedSha256) {
        if (uploadIdS3)
          await this.req('DELETE', tmp, { query: { uploadId: uploadIdS3 }, ok: [204, 404] }).catch(
            () => undefined,
          );
        return { mismatch: true as const, sha256, bytes };
      }
      const key = `archives/${sha256}`;
      if (await this.exists(key)) {
        if (uploadIdS3)
          await this.req('DELETE', tmp, { query: { uploadId: uploadIdS3 }, ok: [204, 404] }).catch(
            () => undefined,
          );
        return { key, sha256, bytes, deduplicated: true };
      }
      if (uploadIdS3) {
        if (buffered > 0) await flushPart();
        const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
        const done = await this.req('POST', tmp, {
          query: { uploadId: uploadIdS3 },
          body: Buffer.from(xml),
          headers: { 'content-type': 'application/xml' },
          retry: false,
        });
        if ((await done.text()).includes('<Error>'))
          throw new ObjectStoreError(
            'rejected',
            'the provider failed to complete the multipart upload',
          );
      } else {
        single = Buffer.concat(buf);
        await this.putEncrypted(tmp, single);
      }
      const copy = await this.req('PUT', key, {
        headers: {
          'x-amz-copy-source': `/${this.cfg.bucket}/${tmp}`,
          'x-amz-metadata-directive': 'REPLACE',
          'content-type': 'application/octet-stream',
          ...this.sseHeaders(),
        },
        retry: false,
      });
      const copyBody = await copy.text();
      if (copyBody.includes('<Error>'))
        throw new ObjectStoreError('rejected', 'the provider failed to copy the composed object');
      try {
        this.checkEncrypted(copy);
      } catch (e) {
        await this.req('DELETE', key, { ok: [204, 404] }).catch(() => undefined);
        throw e;
      }
      await this.req('DELETE', tmp, { ok: [204, 404] }).catch(() => undefined);
      return { key, sha256, bytes, deduplicated: false };
    } catch (e) {
      if (uploadIdS3)
        await this.req('DELETE', tmp, { query: { uploadId: uploadIdS3 }, ok: [204, 404] }).catch(
          () => undefined,
        );
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const r = await this.req('HEAD', checkKey(key), { expect404: true });
    return r.status !== 404;
  }
  async size(key: string): Promise<number | null> {
    const r = await this.req('HEAD', checkKey(key), { expect404: true });
    return r.status === 404 ? null : Number(r.headers.get('content-length') ?? 0);
  }
  async read(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.req('GET', checkKey(key))).arrayBuffer());
  }
  async open(key: string): Promise<Readable> {
    const r = await this.req('GET', checkKey(key), {
      timeoutMs: this.cfg.partTimeoutMs ?? 120_000,
    });
    if (!r.body) return Readable.from([]);
    return Readable.fromWeb(r.body as never);
  }
  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const r = await this.req('GET', checkKey(key), {
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
      ok: [206, 416],
    });
    if (r.status === 416) return Buffer.alloc(0);
    return Buffer.from(await r.arrayBuffer());
  }
  async put(
    key: string,
    data: Buffer,
    opts: { ifAbsent?: boolean } = {},
  ): Promise<{ existed: boolean }> {
    if (opts.ifAbsent && (await this.exists(key))) return { existed: true };
    await this.putEncrypted(key, data);
    return { existed: false };
  }
  async delete(key: string): Promise<void> {
    await this.req('DELETE', checkKey(key), { ok: [204, 404] });
  }
  async discardUpload(uploadId: string): Promise<void> {
    const prefix = `uploads/${uploadId}/`;
    const r = await this.req('GET', '', { query: { 'list-type': '2', prefix } });
    const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((m) => m[1]!)
      .filter((k) => k.startsWith(prefix));
    for (const k of keys) await this.delete(k);
  }
  async signedUrl(
    key: string,
    ttlSeconds: number,
    opts: { filename?: string } = {},
  ): Promise<string> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)
      throw new ObjectStoreError('config', 'a signed URL lives 1 to 3600 seconds');
    const creds = await this.cfg.credentials();
    return presign({
      url: this.url(checkKey(key)),
      creds,
      region: this.cfg.region,
      expiresSeconds: ttlSeconds,
      extraQuery: opts.filename
        ? {
            'response-content-disposition': `attachment; filename="${opts.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
          }
        : undefined,
    });
  }

  /**
   * The live verification procedure (HG for D-42): run it against the real provider and bucket and keep the output as evidence. It writes, reads, signs and deletes one
   * small object under `selftest/` and reports each property separately; any `false` means the provider must not be used.
   */
  async selfTest(): Promise<{
    ok: boolean;
    checks: Record<
      | 'encryptionApplied'
      | 'roundTrip'
      | 'signedReadWorks'
      | 'anonymousReadDenied'
      | 'rangeRead'
      | 'cleanup',
      boolean
    >;
  }> {
    const key = `selftest/${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const body = Buffer.from('nuzm-knowledge-store-selftest');
    const checks = {
      encryptionApplied: false,
      roundTrip: false,
      signedReadWorks: false,
      anonymousReadDenied: false,
      rangeRead: false,
      cleanup: false,
    };
    try {
      await this.putEncrypted(key, body);
      checks.encryptionApplied = true;
      checks.roundTrip = (await this.read(key)).equals(body);
      checks.rangeRead = (await this.readRange(key, 4, 5)).equals(body.subarray(4, 9));
      const signed = await this.f(await this.signedUrl(key, 60));
      checks.signedReadWorks = signed.ok && Buffer.from(await signed.arrayBuffer()).equals(body);
      const anon = await this.f(this.url(key).toString());
      await anon.arrayBuffer().catch(() => undefined);
      checks.anonymousReadDenied = anon.status === 401 || anon.status === 403;
    } catch {
      /* a failing check stays false */
    } finally {
      await this.delete(key).catch(() => undefined);
      checks.cleanup = !(await this.exists(key).catch(() => true));
    }
    return { ok: Object.values(checks).every(Boolean), checks };
  }
}
