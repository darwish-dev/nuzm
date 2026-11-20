import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Alibaba Cloud "V3" request signature, ACS3-HMAC-SHA256, for RPC-style APIs (ECS 2014-05-26, BSS 2017-12-14).
 * Source: https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature (read 2026-11-18).
 * `signer.spec.ts` reproduces the page's own worked example byte for byte (hashed canonical request 7ea06492…e259, signature 06563a9e…83c0).
 * Note (ECS overview page): the vendor recommends its SDK and asks to contact technical support before hand-writing a signer; a live
 * verification run must therefore confirm acceptance by the real endpoint (NOT VERIFIED here).
 */
export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');
export const EMPTY_BODY_SHA256 = sha256Hex('');

/** RFC 3986 percent-encoding: only A-Z a-z 0-9 - _ . ~ stay; space is %20, `*` is %2A. */
export const pctEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export const canonicalQuery = (params: Record<string, string>): string =>
  Object.keys(params)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(params[k]!)}`)
    .join('&');

export interface SignInput {
  method: 'GET' | 'POST';
  host: string; // value of the Host header (host[:port])
  action: string;
  version: string;
  query: Record<string, string>;
  date: string; // yyyy-MM-ddTHH:mm:ssZ (must be within 15 minutes of the request)
  nonce: string;
  accessKeyId: string;
  accessKeySecret: string;
}
export interface Signed {
  headers: Record<string, string>;
  queryString: string;
  canonicalRequest: string;
  stringToSign: string;
}

export function signV3(i: SignInput): Signed {
  const qs = canonicalQuery(i.query);
  const hdrs: Record<string, string> = {
    host: i.host,
    'x-acs-action': i.action,
    'x-acs-content-sha256': EMPTY_BODY_SHA256, // parameters travel in the query string; no body
    'x-acs-date': i.date,
    'x-acs-signature-nonce': i.nonce,
    'x-acs-version': i.version,
  };
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    i.method,
    '/',
    qs,
    canonicalHeaders, // already ends with \n, producing the blank line the page shows
    signedHeaders,
    EMPTY_BODY_SHA256,
  ].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac('sha256', i.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('hex');
  const { host: _host, ...sendable } = hdrs; // fetch sets Host itself from the URL
  return {
    headers: {
      ...sendable,
      authorization: `ACS3-HMAC-SHA256 Credential=${i.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
    queryString: qs,
    canonicalRequest,
    stringToSign,
  };
}

export const newNonce = (): string => randomBytes(16).toString('hex');
export const acsDate = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
