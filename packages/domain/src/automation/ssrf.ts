import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * M11 S52: SSRF defence for every outbound call a tenant can cause (workflow HTTP actions, outbound webhooks, OAuth endpoints).
 * Layers: (1) URL policy (https only, no credentials in the URL, port allow-list, no internal-looking names); (2) address policy
 * (RFC 1918, loopback, link-local, metadata, CGNAT, multicast, reserved, IPv6 ULA/link-local, IPv4-mapped/NAT64/6to4 embeddings);
 * (3) the host is RESOLVED HERE and EVERY answer must be public, and the connection is made to the vetted IP itself (the DNS answer cannot
 * change between check and use: DNS rebinding); (4) every redirect hop is re-validated from step 1; (5) 30 s deadline and 5 MB response cap.
 * The WHATWG URL parser normalises decimal/octal/hex/short IPv4 forms, percent-encoding and IDNA dots before any check runs.
 */
export type SsrfCode =
  | 'url_invalid'
  | 'scheme_denied'
  | 'credentials_denied'
  | 'port_denied'
  | 'host_denied'
  | 'address_denied'
  | 'dns_failed'
  | 'redirect_limit'
  | 'redirect_denied'
  | 'response_too_large'
  | 'timeout'
  | 'transport_error';

export class SsrfError extends Error {
  constructor(
    readonly code: SsrfCode,
    message: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface EgressPolicy {
  allowedPorts: readonly number[];
  /** Exact hosts (lower-case) that are always refused, in addition to the built-in list. */
  denyHosts?: readonly string[];
  /** Optional allow-list: when non-empty, ONLY these hosts (or `*.suffix`) may be called. */
  allowHosts?: readonly string[];
  maxResponseBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}
export const DEFAULT_EGRESS: EgressPolicy = {
  allowedPorts: [443, 8443],
  maxResponseBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 3,
};

const BLOCKED_NAMES = ['localhost', 'metadata.google.internal', 'metadata', 'instance-data', 'kubernetes', 'kubernetes.default', 'broadcasthost', 'ip6-localhost', 'ip6-loopback'];
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.home.arpa', '.cluster.local', '.svc', '.in-addr.arpa', '.ip6.arpa'];

// ---- address policy -------------------------------------------------------------------------------------------------------------
function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}
const cidr4 = (base: string, bits: number): [number, number] => [ipv4ToInt(base), bits];
const DENY4: [number, number][] = [
  cidr4('0.0.0.0', 8),
  cidr4('10.0.0.0', 8),
  cidr4('100.64.0.0', 10), // CGNAT, includes Alibaba metadata 100.100.100.200
  cidr4('127.0.0.0', 8),
  cidr4('169.254.0.0', 16), // link-local, cloud metadata 169.254.169.254
  cidr4('172.16.0.0', 12),
  cidr4('192.0.0.0', 24),
  cidr4('192.0.2.0', 24),
  cidr4('192.88.99.0', 24),
  cidr4('192.168.0.0', 16),
  cidr4('198.18.0.0', 15),
  cidr4('198.51.100.0', 24),
  cidr4('203.0.113.0', 24),
  cidr4('224.0.0.0', 4),
  cidr4('240.0.0.0', 4),
];
export function isDeniedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return DENY4.some(([base, bits]) => bits === 0 || (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

/** IPv6 text → 16 bytes, or null when malformed. Accepts `::` compression and a dotted IPv4 tail. Zone ids are rejected. */
export function parseIPv6(text: string): Uint8Array | null {
  if (text.includes('%')) return null;
  let s = text.toLowerCase();
  let tail: number[] = [];
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (isIP(m[1]!) !== 4) return null;
    const v = m[1]!.split('.').map(Number);
    tail = [(v[0]! << 8) | v[1]!, (v[2]! << 8) | v[3]!];
    s = s.slice(0, -m[1]!.length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':'));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest] : head;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i]!)) return null;
    const v = parseInt(groups[i]!, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 255;
  }
  if (tail.length) {
    out[12] = tail[0]! >> 8;
    out[13] = tail[0]! & 255;
    out[14] = tail[1]! >> 8;
    out[15] = tail[1]! & 255;
  }
  return out;
}
const v4of = (b: Uint8Array, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

export function isDeniedIPv6(ip: string): boolean {
  const b = parseIPv6(ip);
  if (!b) return true; // unparsable = refuse
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isDeniedIPv4(v4of(b, 12)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZero(0, 12)) return true; // ::a.b.c.d (IPv4-compatible, deprecated)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return isDeniedIPv4(v4of(b, 12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (embeds an IPv4 the tenant picks)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! & 0xfe) === 0x00) return true; // 2001::/23 IETF protocol assignments
  if (b[0] === 0x01 && b[1] === 0x00 && allZero(2, 8)) return true; // 100::/64 discard
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true; // multicast
  return (b[0]! & 0xe0) !== 0x20; // only 2000::/3 global unicast is allowed
}
export function isDeniedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isDeniedIPv4(ip);
  if (v === 6) return isDeniedIPv6(ip);
  return true;
}

// ---- URL policy -----------------------------------------------------------------------------------------------------------------
export interface CheckedUrl {
  url: URL;
  /** Lower-case host without brackets or trailing dot. */
  host: string;
  port: number;
  /** True when the host is an IP literal (already vetted; no DNS needed). */
  literal: boolean;
}

export function checkUrl(raw: string, policy: EgressPolicy = DEFAULT_EGRESS): CheckedUrl {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) throw new SsrfError('url_invalid', 'the URL is empty or too long');
  if (/[\u0000-\u001f\u007f]/.test(raw) || /[\u0000- ]/.test(raw.trim())) throw new SsrfError('url_invalid', 'the URL contains control characters or spaces');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfError('url_invalid', 'the URL cannot be parsed');
  }
  if (url.protocol !== 'https:') throw new SsrfError('scheme_denied', 'only https:// URLs are allowed');
  if (url.username || url.password) throw new SsrfError('credentials_denied', 'credentials in a URL are not allowed');
  const port = url.port === '' ? 443 : Number(url.port);
  if (!policy.allowedPorts.includes(port)) throw new SsrfError('port_denied', `port ${port} is not allowed`);
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') throw new SsrfError('host_denied', 'the URL has no host');
  const literal = isIP(host) !== 0;
  if (literal) {
    if (isDeniedAddress(host)) throw new SsrfError('address_denied', 'the address is not a public address');
  } else {
    if (!host.includes('.')) throw new SsrfError('host_denied', 'single-label host names are not allowed');
    if (/^[0-9x.]+$/i.test(host)) throw new SsrfError('host_denied', 'numeric host names are not allowed');
    if (BLOCKED_NAMES.includes(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || policy.denyHosts?.includes(host))
      throw new SsrfError('host_denied', 'this host name is internal');
  }
  if (policy.allowHosts && policy.allowHosts.length > 0) {
    const ok = policy.allowHosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));
    if (!ok) throw new SsrfError('host_denied', 'the host is not on the egress allow-list');
  }
  return { url, host, port, literal };
}

/** Resolve (A + AAAA) and require EVERY answer to be public. Returns the vetted addresses. */
export type LookupAll = (host: string) => Promise<string[]>;
export const systemLookup: LookupAll = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function resolvePublic(c: CheckedUrl, lookup: LookupAll = systemLookup): Promise<string[]> {
  if (c.literal) return [c.host];
  let answers: string[];
  try {
    answers = await lookup(c.host);
  } catch {
    throw new SsrfError('dns_failed', 'the host name did not resolve');
  }
  if (answers.length === 0) throw new SsrfError('dns_failed', 'the host name did not resolve');
  // A single non-public answer refuses the whole name: an attacker-controlled name may return several A records and rotate between them.
  if (answers.some((a) => isDeniedAddress(a))) throw new SsrfError('address_denied', 'the host name resolves to a non-public address');
  return answers;
}

// ---- guarded client -------------------------------------------------------------------------------------------------------------
export interface TransportRequest {
  url: URL;
  /** The vetted address to connect to. The transport MUST connect to this address, never resolve the name again. */
  ip: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type Transport = (r: TransportRequest) => Promise<TransportResponse>;

/** Production transport: TLS to the vetted IP with SNI/Host of the original name; streams the body and aborts above the cap. */
export const httpsTransport: Transport = (r) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: r.ip,
        port: r.url.port === '' ? 443 : Number(r.url.port),
        path: `${r.url.pathname}${r.url.search}`,
        method: r.method,
        servername: r.url.hostname,
        headers: { ...r.headers, host: r.url.host },
        timeout: r.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > r.maxBytes) {
            req.destroy(new SsrfError('response_too_large', 'the response is larger than the cap'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new SsrfError('timeout', 'the request timed out')));
    req.on('error', (e) => reject(e instanceof SsrfError ? e : new SsrfError('transport_error', e.message)));
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });

export interface SafeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface SafeResponse extends TransportResponse {
  finalUrl: string;
  redirects: number;
}

export class SafeHttpClient {
  constructor(
    private readonly policy: EgressPolicy = DEFAULT_EGRESS,
    private readonly lookup: LookupAll = systemLookup,
    private readonly transport: Transport = httpsTransport,
    private readonly now: () => number = Date.now,
  ) {}

  async request(r: SafeRequest): Promise<SafeResponse> {
    const started = this.now();
    let current = r.url;
    let method = (r.method ?? 'GET').toUpperCase();
    let body = r.body;
    for (let hop = 0; ; hop++) {
      const checked = checkUrl(current, this.policy);
      const addrs = await resolvePublic(checked, this.lookup);
      const left = this.policy.timeoutMs - (this.now() - started);
      if (left <= 0) throw new SsrfError('timeout', 'the request timed out');
      const res = await this.transport({
        url: checked.url,
        ip: addrs[0]!,
        method,
        headers: r.headers ?? {},
        body,
        timeoutMs: left,
        maxBytes: this.policy.maxResponseBytes,
      });
      if (Buffer.byteLength(res.body, 'utf8') > this.policy.maxResponseBytes) throw new SsrfError('response_too_large', 'the response is larger than the cap');
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        // redirects are followed for safe methods only; a POST/PATCH answer is returned to the caller as it is (never replayed at another URL)
        if (!['GET', 'HEAD'].includes(method)) return { ...res, finalUrl: current, redirects: hop };
        if (hop >= this.policy.maxRedirects) throw new SsrfError('redirect_limit', 'too many redirects');
        try {
          current = new URL(res.headers.location, checked.url).href; // validated again at the top of the loop, from scratch
        } catch {
          throw new SsrfError('redirect_denied', 'the redirect target is not a URL');
        }
        body = undefined;
        continue;
      }
      return { ...res, finalUrl: current, redirects: hop };
    }
  }
}
