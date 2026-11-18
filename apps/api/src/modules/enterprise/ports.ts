import { lookup, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Fetches IdP metadata documents. Production uses `SafeMetadataFetcher` (https only, no private addresses); tests inject a fake. */
export abstract class MetadataFetcher {
  abstract fetch(url: string): Promise<string>;
}

/** Public-DNS TXT lookup (used when the domain is not hosted in the organization's own Nuzm zones). */
export abstract class DnsTxtResolver {
  abstract txt(fqdn: string): Promise<string[]>;
}

const privateV4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
};
export const isPrivateAddress = (ip: string): boolean => {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateV4(v.slice(7));
  return (
    v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
  );
};

/** SSRF-safe fetch: https only, public addresses only, no redirects, 5 s, 512 KiB. */
export class SafeMetadataFetcher extends MetadataFetcher {
  async fetch(urlRaw: string): Promise<string> {
    const u = new URL(urlRaw);
    if (u.protocol !== 'https:') throw new Error('metadata URL must be https');
    const addrs = isIP(u.hostname)
      ? [{ address: u.hostname }]
      : await lookup(u.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address)))
      throw new Error('metadata host is not a public address');
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`metadata fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 512 * 1024) throw new Error('metadata too large');
    return buf.toString('utf8');
  }
}

export class NodeDnsTxtResolver extends DnsTxtResolver {
  async txt(fqdn: string): Promise<string[]> {
    try {
      return (await resolveTxt(fqdn)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  }
}
