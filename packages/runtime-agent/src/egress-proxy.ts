import { connect as netConnect, createServer, isIP, type Server, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { executionGateway as eg, isBlockedAddress } from '@nuzm/domain';
import type { Metrics } from './metrics';

/**
 * The EGRESS PROXY of the `registry-only` network class: a CONNECT-only forward proxy on the node. A sandbox in that class has exactly one route, to this proxy's address
 * (`network.ts`), and no DNS; it sends `CONNECT registry.npmjs.org:443` and the proxy decides:
 *   - method must be CONNECT; anything else is 405 (no plain HTTP proxying, so no request smuggling surface, no redirects to follow);
 *   - the target must be `<host>:443` with a host on the allow-list EXACTLY (no wildcard, no suffix match, no IP literal, no userinfo, no port other than 443);
 *   - the proxy resolves the name itself and refuses if ANY answer is a private, loopback, link-local, CGNAT, documentation, multicast, reserved or IPv4-mapped/embedded address
 *     (DNS rebinding and "resolves to the metadata service" both end here), then connects to the resolved IP it checked (never re-resolving), with a connect timeout;
 *   - a tunnel has an idle timeout, a total lifetime, and a byte cap; concurrent tunnels are bounded; one failure never affects another.
 * It logs and counts host names and byte totals only (no payload, no URL path: it cannot see them inside TLS anyway).
 * STATUS: unit-tested with an injected resolver and connector; never run against the real network from this repository. T5 of the qualification plan exercises it on the node.
 */
export interface ProxyOptions {
  allowHosts: readonly string[];
  metrics: Metrics;
  resolver?: (host: string) => Promise<string[]>;
  /** opens the upstream connection to an already-vetted IP (injectable for tests) */
  connector?: (ip: string, port: number, timeoutMs: number) => Promise<Socket>;
  maxTunnels?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  maxBytesPerTunnel?: number;
  onEvent?: (e: { host: string; outcome: string; bytes?: number }) => void;
}

/**
 * true if the textual address is publicly routable unicast. It DELEGATES to the platform's SSRF classifier (`isBlockedAddress`, Phase 2 DEFECT-2/3) so the proxy and the rest of the
 * platform can never disagree (DEFECT-18: a private re-implementation accepted 100::/64, `::7f00:1` and `fec0::1`). A non-IP string is refused. The extra rules below are
 * additional, never a replacement: NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) embed an IPv4 address this proxy does not vet, so they are refused here too.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 0) return false;
  if (isBlockedAddress(ip)) return false;
  const s = ip.toLowerCase();
  return !(/^64:ff9b:/.test(s) || /^2002:/.test(s));
}

const defaultResolver = async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
const defaultConnector = (ip: string, port: number, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = netConnect({ host: ip, port });
    const t = setTimeout(() => s.destroy(new Error('connect_timeout')), timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

/** `CONNECT host:port` request line -> host, or null */
export function parseConnectTarget(authority: string): { host: string; port: number } | null {
  const m = /^([a-z0-9.-]{1,253}):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

export function createEgressProxy(o: ProxyOptions): Server {
  const allow = new Set(o.allowHosts);
  for (const h of allow) if (!eg.isAllowableEgressHost(h)) throw new Error('proxy_allow_host_invalid');
  const resolver = o.resolver ?? defaultResolver;
  const connector = o.connector ?? defaultConnector;
  let tunnels = 0;
  const server = createServer({ allowHalfOpen: false }, (client) => {
    client.setNoDelay(true);
    client.setTimeout(10_000);
    let buf = Buffer.alloc(0);
    const refuse = (code: number, why: string, host = '?') => {
      o.metrics.inc('nuzm_proxy_refused_total', 1, why);
      o.onEvent?.({ host, outcome: `refused:${why}` });
      client.end(`HTTP/1.1 ${code} ${why}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > 4096) return refuse(431, 'header_too_large');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      client.setTimeout(0);
      const head = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      void handle(head, rest);
    };
    const handle = async (head: string, rest: Buffer): Promise<void> => {
      const line = head.split('\r\n')[0] ?? '';
      const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
      if (!m) return refuse(400, 'bad_request');
      if (m[1] !== 'CONNECT') return refuse(405, 'method_not_allowed');
      if (rest.length > 0) return refuse(400, 'unexpected_pipelined_data'); // nothing may ride behind the CONNECT before the tunnel is up
      const t = parseConnectTarget(m[2]!);
      if (!t || t.port !== 443) return refuse(403, 'port_not_443');
      if (isIP(t.host) !== 0 || !allow.has(t.host)) return refuse(403, 'host_not_allowed', t.host);
      if (tunnels >= (o.maxTunnels ?? 32)) return refuse(503, 'too_many_tunnels', t.host);
      let addrs: string[];
      try {
        addrs = await resolver(t.host);
      } catch {
        return refuse(502, 'resolve_failed', t.host);
      }
      if (addrs.length === 0 || !addrs.every(isPublicAddress)) return refuse(403, 'resolved_to_non_public_address', t.host);
      tunnels++;
      let upstream: Socket;
      try {
        upstream = await connector(addrs[0]!, 443, o.connectTimeoutMs ?? 10_000);
      } catch {
        tunnels--;
        return refuse(502, 'connect_failed', t.host);
      }
      // O-17: the client may have gone while the upstream connect was in flight: drop the upstream and free the slot at once instead of holding it until the idle timeout
      if (client.destroyed) {
        upstream.destroy();
        tunnels--;
        o.metrics.inc('nuzm_proxy_tunnels_closed_total', 1, 'client_gone_before_open');
        o.onEvent?.({ host: t.host, outcome: 'client_gone_before_open' });
        return;
      }
      let bytes = 0;
      const cap = o.maxBytesPerTunnel ?? 512 * 1024 * 1024;
      const closeBoth = (outcome: string) => {
        if (client.destroyed && upstream.destroyed) return;
        client.destroy();
        upstream.destroy();
        tunnels--;
        o.metrics.inc('nuzm_proxy_tunnels_closed_total', 1, outcome);
        o.onEvent?.({ host: t.host, outcome, bytes });
      };
      let closed = false;
      const once = (outcome: string) => {
        if (closed) return;
        closed = true;
        closeBoth(outcome);
      };
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      o.metrics.inc('nuzm_proxy_tunnels_opened_total');
      const count = (c: Buffer) => {
        bytes += c.length;
        if (bytes > cap) once('byte_cap');
      };
      client.on('data', count);
      upstream.on('data', count);
      client.pipe(upstream);
      upstream.pipe(client);
      for (const s of [client, upstream]) {
        s.setTimeout(o.idleTimeoutMs ?? 60_000, () => once('idle'));
        s.on('error', () => once('error'));
        s.on('close', () => once('closed'));
      }
      setTimeout(() => once('lifetime'), o.maxLifetimeMs ?? 15 * 60_000).unref();
    };
    client.on('data', onData);
    client.on('error', () => undefined);
    client.on('timeout', () => client.destroy());
  });
  server.maxConnections = (o.maxTunnels ?? 32) * 2;
  return server;
}
