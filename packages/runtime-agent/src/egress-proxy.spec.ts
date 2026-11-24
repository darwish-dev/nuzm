import { connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createEgressProxy, isPublicAddress, parseConnectTarget } from './egress-proxy';
import { Metrics } from './metrics';

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});
async function start(over: Partial<Parameters<typeof createEgressProxy>[0]> = {}) {
  const metrics = new Metrics();
  const events: { host: string; outcome: string }[] = [];
  const connectorCalls: string[] = [];
  server = createEgressProxy({
    allowHosts: ['registry.npmjs.org'],
    metrics,
    resolver: async () => ['104.16.1.1'],
    connector: async (ip) => {
      connectorCalls.push(ip);
      const up = new PassThrough();
      // an echo "upstream"
      const sock = Object.assign(up, {
        setTimeout: () => up,
        setNoDelay: () => up,
        destroyed: false,
      }) as unknown as Socket;
      return sock;
    },
    onEvent: (e) => events.push(e),
    ...over,
  });
  const port = await new Promise<number>((r) =>
    server!.listen(0, '127.0.0.1', () => r((server!.address() as AddressInfo).port)),
  );
  return { port, metrics, events, connectorCalls };
}
const send = (port: number, text: string) =>
  new Promise<string>((resolve) => {
    const s = connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (c) => {
      out += c.toString('latin1');
      if (out.includes('\r\n\r\n')) {
        s.destroy();
        resolve(out);
      }
    });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(text);
  });
const connectLine = (t: string) => `CONNECT ${t} HTTP/1.1\r\nhost: ${t}\r\n\r\n`;

describe('public address test', () => {
  it('refuses every private, loopback, link-local, CGNAT, documentation, multicast and embedded form', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '198.51.100.9',
      '203.0.113.5',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fd00:ec2::254',
      'fc00::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '2002:c0a8:0101::1',
      '64:ff9b::a00:1',
      '100::1',
      '::7f00:1',
      'fec0::1',
      'not-an-ip',
      '',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of [
      '104.16.1.1',
      '151.101.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '100.63.0.1',
      '2606:4700::1111',
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
  it('a client that disconnects while the upstream connect is in flight frees its tunnel slot immediately (O-17)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let upstreamDestroyed = false;
    const p = await start({
      maxTunnels: 1,
      connector: async () => {
        await gate;
        const up = new PassThrough();
        up.on('close', () => (upstreamDestroyed = true));
        return Object.assign(up, {
          setTimeout: () => up,
          setNoDelay: () => up,
        }) as unknown as Socket;
      },
    });
    const c = connect(p.port, '127.0.0.1');
    await new Promise<void>((r) => c.write(connectLine('registry.npmjs.org:443'), () => r()));
    await new Promise((r) => setTimeout(r, 50));
    c.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamDestroyed).toBe(true);
    expect(p.metrics.get('nuzm_proxy_tunnels_closed_total', 'client_gone_before_open')).toBe(1);
    // the single slot is free again
    expect(await send(p.port, connectLine('registry.npmjs.org:443'))).toMatch(/^HTTP\/1\.1 200 /);
  });
  it('parses only host:port authority forms', () => {
    expect(parseConnectTarget('registry.npmjs.org:443')).toEqual({
      host: 'registry.npmjs.org',
      port: 443,
    });
    for (const bad of [
      'registry.npmjs.org',
      'a@b.com:443',
      'REGISTRY.npmjs.org:443',
      '[::1]:443',
      'x:99999999',
    ])
      expect(parseConnectTarget(bad), bad).toBeNull();
  });
});

describe('egress proxy', () => {
  it('opens a tunnel only for an allowed host on 443 whose name resolves to public addresses, and connects to the IP it vetted', async () => {
    const p = await start();
    const r = await send(p.port, connectLine('registry.npmjs.org:443'));
    expect(r).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(p.connectorCalls).toEqual(['104.16.1.1']);
    expect(p.metrics.get('nuzm_proxy_tunnels_opened_total')).toBe(1);
  });
  it.each([
    ['GET / HTTP/1.1\r\nhost: x\r\n\r\n', 405, 'method_not_allowed'],
    [connectLine('registry.npmjs.org:80'), 403, 'port_not_443'],
    [connectLine('evil.example.com:443'), 403, 'host_not_allowed'],
    [connectLine('registry.npmjs.org.evil.com:443'), 403, 'host_not_allowed'],
    [connectLine('sub.registry.npmjs.org:443'), 403, 'host_not_allowed'],
    [connectLine('169.254.169.254:443'), 403, 'host_not_allowed'],
    [connectLine('93.184.216.34:443'), 403, 'host_not_allowed'],
    [
      'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\n\r\n',
      400,
      'unexpected_pipelined_data',
    ],
    ['garbage\r\n\r\n', 400, 'bad_request'],
  ])('refuses %j', async (req, code, why) => {
    const p = await start();
    const r = await send(p.port, req);
    expect(r).toMatch(new RegExp(`^HTTP/1\\.1 ${code} `));
    expect(p.metrics.get('nuzm_proxy_refused_total', why)).toBe(1);
    expect(p.connectorCalls).toEqual([]);
  });
  it('refuses a name that resolves to the metadata service, a private address, or ANY non-public answer (rebinding)', async () => {
    for (const answers of [
      ['169.254.169.254'],
      ['10.0.0.5'],
      ['104.16.1.1', '127.0.0.1'],
      ['::ffff:10.0.0.1'],
      [],
    ]) {
      const p = await start({ resolver: async () => answers });
      expect(await send(p.port, connectLine('registry.npmjs.org:443'))).toMatch(
        /^HTTP\/1\.1 403 resolved_to_non_public_address/,
      );
      expect(p.connectorCalls).toEqual([]);
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });
  it('a resolver or connector failure is a 502 and frees the slot; the tunnel cap is enforced', async () => {
    const p1 = await start({
      resolver: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    expect(await send(p1.port, connectLine('registry.npmjs.org:443'))).toMatch(
      /^HTTP\/1\.1 502 resolve_failed/,
    );
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const p2 = await start({
      connector: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await send(p2.port, connectLine('registry.npmjs.org:443'))).toMatch(
      /^HTTP\/1\.1 502 connect_failed/,
    );
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const p3 = await start({ maxTunnels: 1 });
    const first = connect(p3.port, '127.0.0.1');
    await new Promise<void>((r) => {
      first.once('data', () => r());
      first.write(connectLine('registry.npmjs.org:443'));
    });
    expect(await send(p3.port, connectLine('registry.npmjs.org:443'))).toMatch(
      /^HTTP\/1\.1 503 too_many_tunnels/,
    );
    first.destroy();
  });
  it('an invalid allow-list entry (IP, wildcard, uppercase, internal suffix) is a construction error', () => {
    for (const h of [
      '169.254.169.254',
      '*.npmjs.org',
      'Registry.NPMJS.org',
      'registry.internal',
      'localhost',
    ])
      expect(() => createEgressProxy({ allowHosts: [h], metrics: new Metrics() })).toThrow(
        'proxy_allow_host_invalid',
      );
  });
});
