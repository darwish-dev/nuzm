import { createHash, createHmac } from 'node:crypto';

/** AWS Signature Version 4 (header and query forms), the parts S3-compatible providers need. Verified against AWS's published vectors in `sigv4.spec.ts`. */
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest();
export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}
/** RFC 3986 encoding as AWS wants it (unreserved characters stay; everything else is %XX upper-case). `keepSlash` for object paths. */
export const awsEncode = (s: string, keepSlash = false) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
export const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface CanonicalInput {
  method: string;
  canonicalUri: string;
  query: Record<string, string>;
  headers: Record<string, string>; // lower-case names, trimmed values
  signedHeaders: string[]; // sorted lower-case names
  payloadHash: string;
}
export function canonicalRequest(i: CanonicalInput): string {
  const hdrs = i.signedHeaders
    .map((h) => `${h}:${i.headers[h]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  return [
    i.method,
    i.canonicalUri,
    canonicalQuery(i.query),
    hdrs,
    i.signedHeaders.join(';'),
    i.payloadHash,
  ].join('\n');
}
export function signature(
  secret: string,
  dateTime: string,
  region: string,
  service: string,
  canonical: string,
): string {
  const scope = `${dateTime.slice(0, 8)}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonical)].join('\n');
  return createHmac('sha256', signingKey(secret, dateTime.slice(0, 8), region, service))
    .update(sts, 'utf8')
    .digest('hex');
}

/** Signs a request with the `Authorization` header. `url` is absolute; the returned headers include the date, payload hash and token. */
export function signHeaders(o: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  creds: Credentials;
  region: string;
  service?: string;
  now?: Date;
}): Record<string, string> {
  const service = o.service ?? 's3';
  const dateTime = amzDate(o.now ?? new Date());
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = v;
  headers.host = o.url.host;
  headers['x-amz-date'] = dateTime;
  headers['x-amz-content-sha256'] = o.payloadHash;
  if (o.creds.sessionToken) headers['x-amz-security-token'] = o.creds.sessionToken;
  const signedHeaders = Object.keys(headers).sort();
  const query: Record<string, string> = {};
  o.url.searchParams.forEach((v, k) => (query[k] = v));
  const sig = signature(
    o.creds.secretAccessKey,
    dateTime,
    o.region,
    service,
    canonicalRequest({
      method: o.method,
      canonicalUri: s3Path(o.url),
      query,
      headers,
      signedHeaders,
      payloadHash: o.payloadHash,
    }),
  );
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${dateTime.slice(0, 8)}/${o.region}/${service}/aws4_request, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`;
  return headers;
}

/** The canonical (single-encoded) path of an S3 URL. */
export const s3Path = (u: URL) =>
  u.pathname
    .split('/')
    .map((seg) => awsEncode(decodeURIComponent(seg)))
    .join('/') || '/';

/** A presigned GET URL (query-string signing, payload `UNSIGNED-PAYLOAD`, only the host header signed). */
export function presign(o: {
  url: URL;
  creds: Credentials;
  region: string;
  expiresSeconds: number;
  extraQuery?: Record<string, string>;
  method?: string;
  now?: Date;
}): string {
  const dateTime = amzDate(o.now ?? new Date());
  const scope = `${dateTime.slice(0, 8)}/${o.region}/s3/aws4_request`;
  const query: Record<string, string> = { ...o.extraQuery };
  o.url.searchParams.forEach((v, k) => (query[k] = v));
  Object.assign(query, {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.creds.accessKeyId}/${scope}`,
    'X-Amz-Date': dateTime,
    'X-Amz-Expires': String(o.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  if (o.creds.sessionToken) query['X-Amz-Security-Token'] = o.creds.sessionToken;
  const sig = signature(
    o.creds.secretAccessKey,
    dateTime,
    o.region,
    's3',
    canonicalRequest({
      method: o.method ?? 'GET',
      canonicalUri: s3Path(o.url),
      query,
      headers: { host: o.url.host },
      signedHeaders: ['host'],
      payloadHash: 'UNSIGNED-PAYLOAD',
    }),
  );
  return `${o.url.origin}${o.url.pathname
    .split('/')
    .map((s) => awsEncode(decodeURIComponent(s)))
    .join('/')}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}
