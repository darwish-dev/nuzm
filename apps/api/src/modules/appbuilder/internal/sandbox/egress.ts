import { isIP } from 'node:net';

/**
 * Egress policy of the sandbox (M10 §9): DEFAULT DENY. Allowed: the package mirror, Nuzm Git, the Nuzm model gateway and the declared preview origin, by EXACT host
 * (no wildcard zone, so a name under an allowed zone cannot carry data out). Everything else needs an `egress_or_dependency` approval bound to the exact host and port
 * and time-boxed. Control-plane, private, loopback, link-local, metadata and reserved ranges are blocked whatever the name resolves to; every redirect is re-checked;
 * a resolved address is pinned for the connection (no DNS rebinding). This module decides; the sandbox proxy enforces. It is pure: the resolver is injected.
 */
export type EgressControl =
  | 'default_deny'
  | 'scheme_denied'
  | 'port_denied'
  | 'userinfo_denied'
  | 'ip_literal_private'
  | 'metadata_endpoint'
  | 'resolved_private'
  | 'resolution_failed'
  | 'redirect_denied'
  | 'allowlist';
export interface EgressDecision {
  allow: boolean;
  control: EgressControl;
  reason: string;
  /** The address the proxy must connect to (resolved once, never re-resolved). */
  pinnedIp?: string;
}
export interface AllowEntry {
  host: string;
  ports: number[];
  purpose: 'package_mirror' | 'nuzm_git' | 'model_gateway' | 'preview_origin';
}
export interface ApprovedEgress {
  host: string;
  port: number;
  /** Epoch ms after which the approval no longer applies (time-boxed). */
  until: number;
}
export type Resolver = (host: string) => Promise<string[]>;

export const DEFAULT_ALLOW: AllowEntry[] = [
  { host: 'npm-mirror.nuzm.internal', ports: [443], purpose: 'package_mirror' },
  { host: 'pub-mirror.nuzm.internal', ports: [443], purpose: 'package_mirror' },
  { host: 'git.nuzm.internal', ports: [443], purpose: 'nuzm_git' },
  { host: 'models.nuzm.internal', ports: [443], purpose: 'model_gateway' },
];

/** Parses every spelling of an IPv4 address that a libc (inet_aton) accepts: dotted decimal, octal, hex, and 1-3 part forms. Returns the 32-bit value or null. */
export function parseIpv4Loose(s: string): number | null {
  if (!s || /[^0-9a-fx.]/i.test(s)) return null;
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  const maxLast = 256 ** (4 - nums.length);
  if (last >= maxLast || nums.some((n) => n > 255)) return null;
  let v = 0;
  nums.forEach((n, i) => (v += n * 256 ** (3 - i)));
  return v + last;
}
const inV4 = (v: number, base: string, bits: number): boolean => {
  const b = parseIpv4Loose(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v & mask) >>> 0) === ((b & mask) >>> 0);
};
const V4_BLOCKED: [string, number, string][] = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];
/** Non-public IPv4 (32-bit value)? Returns the reason or null when public. */
export function blockedV4(v: number): string | null {
  for (const [base, bits, why] of V4_BLOCKED) if (inV4(v, base, bits)) return why;
  return null;
}
const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', '168.63.129.16', '192.0.0.192', '169.254.169.123']);
const METADATA_HOSTS = /^(metadata(\.google)?\.internal|instance-data(\.ec2\.internal)?|metadata\.tencentyun\.com|metadata\.packet\.net|kubernetes\.default(\.svc(\.cluster\.local)?)?)\.?$/i;

/** Expands an IPv6 literal to eight 16-bit groups (supports ::, embedded IPv4 and zone ids). Returns null when invalid. */
export function parseIpv6(s: string): number[] | null {
  let x = s.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (isIP(x) !== 6) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) {
    const n = parseIpv4Loose(v4[1]!);
    if (n === null) return null;
    x = x.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, tail] = x.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const missing = 8 - h.length - t.length;
  if (x.includes('::') ? missing < 0 : h.length !== 8) return null;
  const groups = [...h, ...Array<string>(x.includes('::') ? missing : 0).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}
/** Non-public IPv6? Also checks every embedded-IPv4 form (mapped, compatible, NAT64, 6to4, Teredo prefix). */
export function blockedV6(g: number[]): string | null {
  const embedded = (hi: number, lo: number) => blockedV4(((hi << 16) | lo) >>> 0);
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6]!, g[7]!) ? `IPv4-embedded ${embedded(g[6]!, g[7]!)}` : null;
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6]!, g[7]!) ? `NAT64-embedded ${embedded(g[6]!, g[7]!)}` : null;
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!) ? `6to4-embedded ${embedded(g[1]!, g[2]!)}` : null;
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo tunnelling';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique-local (fc00::/7)';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'documentation';
  if (g[0] === 0xfd00 && g[1] === 0xec2) return 'cloud metadata';
  return null;
}

/** If `host` is an IP literal in ANY spelling, returns its address family and the reason it is blocked (or null when public). */
export function classifyIpLiteral(host: string): { literal: true; blocked: string | null; metadata: boolean } | { literal: false } {
  const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const g = parseIpv6(h);
  if (g) return { literal: true, blocked: blockedV6(g), metadata: g[0] === 0xfd00 && g[1] === 0xec2 };
  const v = parseIpv4Loose(h);
  if (v !== null) {
    const dotted = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
    return { literal: true, blocked: blockedV4(v), metadata: METADATA_V4.has(dotted) };
  }
  return { literal: false };
}

export class EgressPolicy {
  constructor(
    private readonly allow: AllowEntry[] = DEFAULT_ALLOW,
    private readonly resolve: Resolver,
    private readonly now: () => number = Date.now,
  ) {}

  private matchAllow(host: string, port: number, approved: ApprovedEgress[]): AllowEntry | ApprovedEgress | null {
    const a = this.allow.find((e) => e.host === host && e.ports.includes(port));
    if (a) return a;
    return approved.find((e) => e.host === host && e.port === port && e.until > this.now()) ?? null;
  }

  /** Decide one outbound connection (`url` = what the generated code asked for). */
  async decide(url: string, approved: ApprovedEgress[] = []): Promise<EgressDecision> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { allow: false, control: 'default_deny', reason: 'not a valid absolute URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { allow: false, control: 'scheme_denied', reason: `scheme ${u.protocol} is not allowed` };
    if (u.username || u.password) return { allow: false, control: 'userinfo_denied', reason: 'credentials in the URL are not allowed' };
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    const host = u.hostname.replace(/\.$/, '').toLowerCase(); // URL already punycodes IDN and lower-cases
    const ip = classifyIpLiteral(host);
    if (ip.literal) {
      if (ip.metadata) return { allow: false, control: 'metadata_endpoint', reason: 'cloud metadata endpoints are blocked' };
      return { allow: false, control: ip.blocked ? 'ip_literal_private' : 'default_deny', reason: ip.blocked ? `IP literal in a blocked range (${ip.blocked})` : 'IP literals are not allowed: use an allow-listed host name' };
    }
    if (METADATA_HOSTS.test(host)) return { allow: false, control: 'metadata_endpoint', reason: 'cloud metadata host names are blocked' };
    const entry = this.matchAllow(host, port, approved);
    if (!entry) return { allow: false, control: this.allow.some((e) => e.host === host) ? 'port_denied' : 'default_deny', reason: `${host}:${port} is not on the allow-list (default deny); an approval can allow it for a limited time` };
    // resolve ONCE; every address must be public; the connection is pinned to the first (no second lookup)
    let addrs: string[];
    try {
      addrs = await this.resolve(host);
    } catch {
      return { allow: false, control: 'resolution_failed', reason: 'the name did not resolve' };
    }
    if (addrs.length === 0) return { allow: false, control: 'resolution_failed', reason: 'the name did not resolve' };
    for (const a of addrs) {
      const c = classifyIpLiteral(a);
      if (!c.literal) return { allow: false, control: 'resolved_private', reason: 'the resolver returned a non-address' };
      if (c.blocked || c.metadata) return { allow: false, control: c.metadata ? 'metadata_endpoint' : 'resolved_private', reason: `${host} resolves to a blocked address (${c.blocked ?? 'metadata'}): DNS rebinding refused` };
    }
    return { allow: true, control: 'allowlist', reason: `allow-listed: ${'purpose' in entry ? entry.purpose : 'approved egress'}`, pinnedIp: addrs[0]! };
  }

  /** Follows `Location` headers hop by hop: every hop is decided again (max 5). `hops` are the successive Location values the origin returned. */
  async decideRedirectChain(first: string, hops: string[], approved: ApprovedEgress[] = []): Promise<EgressDecision> {
    let cur = first;
    let d = await this.decide(cur, approved);
    for (let i = 0; d.allow && i < hops.length; i++) {
      if (i >= 5) return { allow: false, control: 'redirect_denied', reason: 'too many redirects' };
      cur = new URL(hops[i]!, cur).toString();
      d = await this.decide(cur, approved);
      if (!d.allow) return { ...d, control: d.control, reason: `redirect to ${new URL(cur).hostname} refused: ${d.reason}` };
    }
    return d;
  }

  /**
   * The filtered DNS resolver answers ONLY the exact allow-listed (or approved) names: any other name is NXDOMAIN. Because zones are never delegated, a query such as
   * `<data>.allowed.example` is NXDOMAIN too, so DNS cannot be used as a covert channel.
   */
  decideDns(name: string, approved: ApprovedEgress[] = []): { answer: boolean; reason: string } {
    const n = name.replace(/\.$/, '').toLowerCase();
    if (n.length > 253 || n.split('.').some((l) => l.length > 63)) return { answer: false, reason: 'malformed name' };
    const ok = this.allow.some((e) => e.host === n) || approved.some((e) => e.host === n && e.until > this.now());
    return ok ? { answer: true, reason: 'allow-listed host' } : { answer: false, reason: 'NXDOMAIN: not an exact allow-listed host' };
  }
}
