/* MIRROR of @nuzm/adapter-contracts (M05 S16, contractVersion 1.0.0) egress.ts, copied READ-ONLY on 2026-11-18 so M07 can build before M05 lands.
 * Integration: replace this file by `export * from "@nuzm/adapter-contracts"`-style re-exports (docs/reports/M07-m05-interface-assumptions.md §1). */
import { isIP } from 'node:net';

/**
 * Per-adapter egress allow-list + SSRF guard (M05 §9). An adapter may only call hosts listed for it in spec/providers/providers.yaml.
 * An empty list means "no outbound calls" (the state of every real vendor until its adapter is built from the official docs).
 * The guard refuses non-https URLs, IP literals, loopback/link-local/private names and hosts outside the list, whatever the list says
 * (loopback is only reachable with an explicit `allowLoopback`, which is for local test servers).
 */
export interface EgressPolicy {
  adapterId: string;
  hosts: readonly string[]; // exact host names, or "*.suffix"
  allowLoopback?: boolean;
}

export class EgressDeniedError extends Error {
  constructor(
    readonly adapterId: string,
    readonly reason: string,
  ) {
    super(`egress denied for ${adapterId}: ${reason}`);
    this.name = 'EgressDeniedError';
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
const isPrivateName = (h: string) =>
  h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');

export function assertEgressAllowed(rawUrl: string, policy: EgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressDeniedError(policy.adapterId, 'not a valid URL');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.username || url.password)
    throw new EgressDeniedError(policy.adapterId, 'credentials in URL');
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  if (!(policy.allowLoopback && loopback)) {
    if (url.protocol !== 'https:')
      throw new EgressDeniedError(policy.adapterId, 'only https is allowed');
    if (isIP(host) !== 0)
      throw new EgressDeniedError(policy.adapterId, 'IP literals are not allowed');
    if (isPrivateName(host) || PRIVATE_V4.some((r) => r.test(host)))
      throw new EgressDeniedError(policy.adapterId, 'private or loopback host');
  }
  const ok = policy.hosts.some((h) => {
    const p = h.toLowerCase();
    return p.startsWith('*.')
      ? host.endsWith(p.slice(1)) && host.length > p.length - 1
      : host === p;
  });
  if (!ok) throw new EgressDeniedError(policy.adapterId, `host ${host} is not in the allow-list`);
  return url;
}
