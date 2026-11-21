import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalRequest, s3Path, sha256Hex, signature } from '../sigv4';

/**
 * A small S3 server for tests: path-style addressing, PutObject, CopyObject, GetObject (ranges), HeadObject, DeleteObject, ListObjectsV2 and multipart. It VERIFIES AWS
 * Signature V4 (header and presigned query forms) with its own copy of the algorithm layer, checks the payload hash and the clock skew, so an adapter that signs wrongly
 * gets 403 exactly as a real provider would. Knobs make it misbehave on purpose: ignore encryption, serve anonymous reads, fail the next requests.
 */
export interface FakeS3Options {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Echo `x-amz-server-side-encryption` on writes (a provider that supports it). Default true. */
  echoEncryption?: boolean;
  /** Serve unsigned GETs (a public bucket): the adapter's self test must notice. */
  publicRead?: boolean;
}
interface Obj {
  data: Buffer;
  sse?: string;
}
export class FakeS3 {
  readonly objects = new Map<string, Obj>();
  readonly requests: { method: string; path: string; query: Record<string, string> }[] = [];
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer>; sse?: string }>();
  private failures: { status: number; times: number; method?: string }[] = [];
  private server: Server | null = null;
  endpoint = '';
  constructor(readonly opts: FakeS3Options) {}

  failNext(status: number, times: number, method?: string) {
    this.failures.push({ status, times, method });
  }
  async start(): Promise<string> {
    this.server = createServer(
      (req, res) =>
        void this.handle(req, res).catch((e) => this.xml(res, 500, 'InternalError', String(e))),
    );
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.endpoint = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.endpoint;
  }
  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }
  private xml(
    res: ServerResponse,
    status: number,
    code: string,
    msg = '',
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { 'content-type': 'application/xml', ...headers });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`);
  }
  private body(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => resolve(Buffer.concat(c)));
      req.on('error', reject);
    });
  }
  /** Null when the request is authentic, else a short reason. */
  private verify(req: IncomingMessage, url: URL, body: Buffer): string | null {
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const { accessKeyId, secretAccessKey, region } = this.opts;
    if (query['X-Amz-Signature']) {
      const sig = query['X-Amz-Signature'];
      const q = { ...query };
      delete q['X-Amz-Signature'];
      const [ak] = (q['X-Amz-Credential'] ?? '').split('/');
      if (ak !== accessKeyId) return 'unknown access key';
      const date = q['X-Amz-Date'] ?? '';
      const t = Date.UTC(
        +date.slice(0, 4),
        +date.slice(4, 6) - 1,
        +date.slice(6, 8),
        +date.slice(9, 11),
        +date.slice(11, 13),
        +date.slice(13, 15),
      );
      if (Date.now() > t + Number(q['X-Amz-Expires'] ?? 0) * 1000) return 'expired';
      const expect = signature(
        secretAccessKey,
        date,
        region,
        's3',
        canonicalRequest({
          method: req.method!,
          canonicalUri: s3Path(url),
          query: q,
          headers: { host: req.headers.host! },
          signedHeaders: ['host'],
          payloadHash: 'UNSIGNED-PAYLOAD',
        }),
      );
      return expect === sig ? null : 'signature mismatch';
    }
    const auth = req.headers.authorization;
    if (!auth) return 'missing authorization';
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        auth,
      );
    if (!m) return 'malformed authorization';
    if (m[1] !== accessKeyId || m[3] !== region) return 'unknown access key or region';
    const dateTime = String(req.headers['x-amz-date'] ?? '');
    const t = Date.UTC(
      +dateTime.slice(0, 4),
      +dateTime.slice(4, 6) - 1,
      +dateTime.slice(6, 8),
      +dateTime.slice(9, 11),
      +dateTime.slice(11, 13),
      +dateTime.slice(13, 15),
    );
    if (Math.abs(Date.now() - t) > 15 * 60_000) return 'clock skew';
    const declared = String(req.headers['x-amz-content-sha256'] ?? '');
    if (declared !== 'UNSIGNED-PAYLOAD' && declared !== sha256Hex(body))
      return 'payload hash mismatch';
    const signed = m[4]!.split(';');
    const headers: Record<string, string> = {};
    for (const h of signed) headers[h] = String(req.headers[h] ?? '');
    const expect = signature(
      secretAccessKey,
      dateTime,
      region,
      's3',
      canonicalRequest({
        method: req.method!,
        canonicalUri: s3Path(url),
        query,
        headers,
        signedHeaders: signed,
        payloadHash: declared,
      }),
    );
    return expect === m[5] ? null : 'signature mismatch';
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const body = await this.body(req);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    this.requests.push({ method: req.method!, path: url.pathname, query });
    const f = this.failures.find((x) => x.times > 0 && (!x.method || x.method === req.method));
    if (f) {
      f.times--;
      return this.xml(res, f.status, 'SlowDown');
    }
    const bad = this.verify(req, url, body);
    const anonymousOk =
      this.opts.publicRead &&
      req.method === 'GET' &&
      !req.headers.authorization &&
      !query['X-Amz-Signature'];
    if (bad && !anonymousOk) return this.xml(res, 403, 'SignatureDoesNotMatch', bad);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (parts.shift() !== this.opts.bucket) return this.xml(res, 404, 'NoSuchBucket');
    const key = parts.join('/');
    const sseReq = req.headers['x-amz-server-side-encryption'] as string | undefined;
    const sseHdr = (sse?: string): Record<string, string> =>
      sse && this.opts.echoEncryption !== false ? { 'x-amz-server-side-encryption': sse } : {};
    const etag = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

    switch (req.method) {
      case 'PUT': {
        if (query.partNumber && query.uploadId) {
          const u = this.uploads.get(query.uploadId);
          if (!u) return this.xml(res, 404, 'NoSuchUpload');
          u.parts.set(Number(query.partNumber), body);
          res.writeHead(200, { etag: etag(body) });
          return res.end();
        }
        const copy = req.headers['x-amz-copy-source'] as string | undefined;
        if (copy) {
          const src = this.objects.get(
            decodeURIComponent(copy).replace(new RegExp(`^/${this.opts.bucket}/`), ''),
          );
          if (!src) return this.xml(res, 404, 'NoSuchKey');
          this.objects.set(key, { data: src.data, sse: sseReq });
          res.writeHead(200, { 'content-type': 'application/xml', ...sseHdr(sseReq) });
          return res.end('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>');
        }
        this.objects.set(key, { data: body, sse: sseReq });
        res.writeHead(200, { etag: etag(body), ...sseHdr(sseReq) });
        return res.end();
      }
      case 'POST': {
        if ('uploads' in query) {
          const id = `up-${this.uploads.size + 1}-${Date.now()}`;
          this.uploads.set(id, { key, parts: new Map(), sse: sseReq });
          res.writeHead(200, { 'content-type': 'application/xml', ...sseHdr(sseReq) });
          return res.end(
            `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          );
        }
        const u = this.uploads.get(query.uploadId ?? '');
        if (!u) return this.xml(res, 404, 'NoSuchUpload');
        const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
          Number(m[1]),
        );
        const chunks = nums.map((n) => u.parts.get(n));
        if (chunks.some((c) => !c)) return this.xml(res, 400, 'InvalidPart');
        if (chunks.slice(0, -1).some((c) => c!.length < 5 * 1024 * 1024))
          return this.xml(res, 400, 'EntityTooSmall');
        this.objects.set(u.key, { data: Buffer.concat(chunks as Buffer[]), sse: u.sse });
        this.uploads.delete(query.uploadId!);
        res.writeHead(200, { 'content-type': 'application/xml', ...sseHdr(u.sse) });
        return res.end(
          '<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>',
        );
      }
      case 'GET':
      case 'HEAD': {
        if (req.method === 'GET' && query['list-type'] === '2') {
          const prefix = query.prefix ?? '';
          const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(
            `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`,
          );
        }
        const o = this.objects.get(key);
        if (!o) return this.xml(res, 404, 'NoSuchKey');
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (range) {
          const a = Number(range[1]);
          if (a >= o.data.length) return this.xml(res, 416, 'InvalidRange');
          const slice = o.data.subarray(a, Math.min(Number(range[2]) + 1, o.data.length));
          res.writeHead(206, {
            'content-length': slice.length,
            'content-range': `bytes ${a}-${a + slice.length - 1}/${o.data.length}`,
            ...sseHdr(o.sse),
          });
          return res.end(req.method === 'HEAD' ? undefined : slice);
        }
        res.writeHead(200, {
          'content-length': o.data.length,
          etag: etag(o.data),
          ...sseHdr(o.sse),
        });
        return res.end(req.method === 'HEAD' ? undefined : o.data);
      }
      case 'DELETE': {
        if (query.uploadId) this.uploads.delete(query.uploadId);
        else this.objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      default:
        return this.xml(res, 405, 'MethodNotAllowed');
    }
  }
}
