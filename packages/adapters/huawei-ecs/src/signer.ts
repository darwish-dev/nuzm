import { createHash, createHmac } from 'node:crypto';

/**
 * Huawei Cloud AK/SK request signing, algorithm `SDK-HMAC-SHA256`.
 * Sources (read 2026-11-18): https://support.huaweicloud.com/intl/en-us/devg-apisign/api-sign-algorithm-001.html and -002.html.
 * `signer.spec.ts` reproduces the HASHED CANONICAL REQUEST printed in the documentation's worked example (b25362e6…cd7a). The printed signature
 * cannot be reproduced because the page masks the secret key (NOT DOCUMENTED: an unmasked test vector), so the final HMAC step is only
 * checked against an independent recomputation. Acceptance by the real endpoint is NOT VERIFIED.
 */
export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');
export const pctEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
/** `X-Sdk-Date` format YYYYMMDDTHHMMSSZ (UTC). */
export const sdkDate = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

export interface SignInput {
  method: string;
  path: string; // as sent, e.g. /v1/{project_id}/cloudservers
  query: Record<string, string>;
  host: string;
  body: string;
  date: string; // YYYYMMDDTHHMMSSZ, within 15 minutes of the server clock
  accessKey: string;
  secretKey: string;
  contentType?: string;
}
export interface Signed {
  headers: Record<string, string>;
  queryString: string;
  canonicalRequest: string;
  hashedCanonicalRequest: string;
}

export function signSdkHmacSha256(i: SignInput): Signed {
  const contentType = i.contentType ?? 'application/json';
  const qs = Object.keys(i.query)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(i.query[k]!)}`)
    .join('&');
  // "A URI must end with a slash (/) for signature calculation. However, the slash is not required when a request is sent."
  const canonicalUri = (i.path.endsWith('/') ? i.path : i.path + '/')
    .split('/')
    .map((seg) => pctEncode(decodeURIComponent(seg)))
    .join('/');
  const hdrs: Record<string, string> = {
    'content-type': contentType,
    host: i.host,
    'x-sdk-date': i.date,
  };
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';'); // the page's examples use ';' (its prose says "commas": a documented contradiction)
  const canonicalRequest = [
    i.method.toUpperCase(),
    canonicalUri,
    qs,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(i.body),
  ].join('\n');
  const hashed = sha256Hex(canonicalRequest);
  const stringToSign = `SDK-HMAC-SHA256\n${i.date}\n${hashed}`;
  const signature = createHmac('sha256', i.secretKey).update(stringToSign, 'utf8').digest('hex');
  return {
    headers: {
      'content-type': contentType,
      'x-sdk-date': i.date,
      authorization: `SDK-HMAC-SHA256 Access=${i.accessKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    queryString: qs,
    canonicalRequest,
    hashedCanonicalRequest: hashed,
  };
}
