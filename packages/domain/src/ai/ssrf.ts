import { isIP } from 'node:net';

/**
 * SSRF-safe URL fetcher (M09 S38 task 6). The DNS resolver and the HTTP client are INJECTED so the policy is testable without a network and the production
 * wiring decides the transport. Rules: http/https only, ports 80/443 only, no credentials in the URL, every resolved address must be public, every redirect hop is
 * re-checked (re-resolved), redirect count, body size and total time are capped. A hostname that resolves to ANY blocked address is refused (no "pick the
 * good one"): that is the DNS-rebinding-resistant choice; callers must also connect to the vetted address (`connectTo`) rather than re-resolving.
 */
const v4 = (s: string): number[] | null => {
  const p = s.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};
export function isBlockedAddress(addr: string): boolean {
  const a = addr
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const kind = isIP(a);
  if (kind === 0) return true; // not an IP literal: refuse
  if (kind === 4) {
    const p = v4(a)!;
    const [x, y] = [p[0]!, p[1]!];
    return (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0 && p[2] === 0) ||
      (x === 192 && y === 0 && p[2] === 2) ||
      (x === 198 && (y === 18 || y === 19)) ||
      (x === 198 && y === 51 && p[2] === 100) ||
      (x === 203 && y === 0 && p[2] === 113) ||
      x >= 224
    );
  }
  // IPv6
  if (a === '::' || a === '::1') return true;
  const mapped =
    /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    if (mapped[2] === undefined) return isBlockedAddress(mapped[1]!);
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8:') || a.startsWith('fec0:')) return true;
  return false;
}

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}
export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBytes: 2_000_000,
  timeoutMs: 8_000,
  maxRedirects: 3,
};
export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  /** reads at most `max` bytes; implementations MUST stop reading beyond it */
  readBody(max: number): Promise<{ bytes: Uint8Array; truncated: boolean }>;
}
export interface SafeFetchDeps {
  resolve(host: string): Promise<string[]>;
  /** `connectTo` is the vetted address: the transport must connect to it (with SNI/Host of the original hostname) */
  request(url: URL, connectTo: string, signal: AbortSignal): Promise<HttpResponseLike>;
}
export class SsrfError extends Error {
  constructor(
    readonly code:
      'bad_url' | 'blocked_address' | 'too_many_redirects' | 'too_large' | 'timeout' | 'bad_status',
    message: string,
  ) {
    super(message);
  }
}
async function vet(url: URL, deps: SafeFetchDeps): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SsrfError('bad_url', 'only http and https are allowed');
  if (url.username || url.password)
    throw new SsrfError('bad_url', 'credentials in the URL are not allowed');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443)
    throw new SsrfError('bad_url', 'only ports 80 and 443 are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host))
    throw new SsrfError('blocked_address', 'internal host name');
  const addrs = isIP(host) ? [host] : await deps.resolve(host);
  if (addrs.length === 0 || addrs.some(isBlockedAddress))
    throw new SsrfError('blocked_address', 'the host resolves to a non-public address');
  return addrs[0]!;
}
export async function safeFetch(
  rawUrl: string,
  deps: SafeFetchDeps,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
): Promise<{ url: string; status: number; body: Uint8Array }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('bad_url', 'not a valid URL');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limits.timeoutMs);
  try {
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      const to = await vet(url, deps);
      let res: HttpResponseLike;
      try {
        res = await deps.request(url, to, ac.signal);
      } catch (e) {
        if (ac.signal.aborted) throw new SsrfError('timeout', 'the request timed out');
        throw e;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new SsrfError('bad_status', 'redirect without a location');
        url = new URL(loc, url); // re-checked at the top of the next hop
        continue;
      }
      if (res.status < 200 || res.status >= 300)
        throw new SsrfError('bad_status', `status ${res.status}`);
      const { bytes, truncated } = await res.readBody(limits.maxBytes);
      if (truncated || bytes.length > limits.maxBytes)
        throw new SsrfError('too_large', 'the response is larger than the limit');
      return { url: url.toString(), status: res.status, body: bytes };
    }
    throw new SsrfError('too_many_redirects', 'too many redirects');
  } finally {
    clearTimeout(timer);
  }
}
