import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { createLoopbackHttpServer, createMetricsServer, createNodeHttpsServer } from './server';
import { createAgentRig, RIG_IMAGE, type AgentRig } from './testing';

const listen = (s: import('node:http').Server | import('node:https').Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const close = (s: import('node:http').Server) => new Promise<void>((r) => s.close(() => r()));
const spec = (): eg.RuntimeSpec =>
  eg.buildRuntimeSpec({
    decision: {
      argv: ['npm', 'test', '--silent'],
      cwd: '',
      env: { ...eg.EXEC_ENV },
      limits: {
        cpuSeconds: 60,
        wallSeconds: 60,
        memoryMb: 256,
        pids: 64,
        outputKb: 64,
        diskMb: 64,
      },
      network: 'none',
    },
    orgId: 'org-a',
    runId: 'run-1',
    runtimeClass: 'gvisor-runsc',
    image: RIG_IMAGE,
  });

describe('the agent over a real HTTP socket (loopback, simulated launcher)', () => {
  let rig: AgentRig;
  let server: ReturnType<typeof createLoopbackHttpServer>;
  let port = 0;
  beforeAll(async () => {
    rig = await createAgentRig({
      script: () => ({
        exitCode: 0,
        stdout: 'ok\n',
        produced: [{ path: 'dist/a.js', bytes: 2, kind: 'file' }],
        producedContent: { 'dist/a.js': 'hi' },
      }),
    });
    server = createLoopbackHttpServer({ handler: rig.agent.handler, metrics: rig.agent.metrics });
    port = await listen(server);
  });
  afterAll(async () => {
    await close(server);
    await rig.dispose();
  });
  const client = () =>
    new eg.RemoteWorkspaceRuntime({
      nodeId: 'sim-node',
      transport: new eg.HttpsTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: async () => {
          throw new Error('no tls');
        },
      }),
      signer: rig.signer,
      runtimeClass: 'gvisor-runsc',
      isolation: 'simulated',
    });
  it('runs the full lifecycle over HTTP: identity, create, put, start, wait, list, read, destroy', async () => {
    const c = client();
    expect((await c.identity()).nodeId).toBe('sim-node');
    await c.createWorkspace({
      workspaceId: 'ws-run-1',
      orgId: 'org-a',
      runId: 'run-1',
      diskMb: 64,
    });
    await c.putFiles('ws-run-1', new Map([['package.json', '{}']]));
    const { handle } = await c.start(spec());
    const w = await c.wait(handle);
    expect(w).toMatchObject({ exitCode: 0, stdout: 'ok\n' });
    expect((await c.listProduced('ws-run-1')).map((f) => f.path)).toContain('dist/a.js');
    expect(await c.readProduced('ws-run-1', 'dist/a.js', 10)).toBe('hi');
    await c.destroy(handle);
    await c.destroyWorkspace('ws-run-1');
    expect(await c.listWorkspaces()).toEqual([]);
  });
  it('a plain-http transport reports kind loopback (so it can never be "verified"); a non-loopback http URL and credentials in a URL are construction errors', () => {
    const t = new eg.HttpsTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      credentials: async () => {
        throw new Error('x');
      },
    });
    expect(t.kind).toBe('loopback');
    expect(
      () =>
        new eg.RemoteWorkspaceRuntime({
          nodeId: 'n',
          transport: t,
          signer: rig.signer,
          runtimeClass: 'gvisor-runsc',
          isolation: 'verified',
        }),
    ).toThrow('loopback_transport_cannot_be_verified');
    const mk = (u: string) => () =>
      new eg.HttpsTransport({
        baseUrl: u,
        credentials: async () => {
          throw new Error('x');
        },
      });
    expect(mk('http://10.0.0.5:8443')).toThrow('transport_requires_https');
    expect(mk('https://user:pw@node.example:8443')).toThrow(
      'transport_url_has_credentials_or_query',
    );
    expect(mk('https://node.example:8443/?token=abc')).toThrow(
      'transport_url_has_credentials_or_query',
    );
    expect(
      () =>
        new eg.HttpsTransport({
          baseUrl: 'https://node.example:8443',
          credentials: async () => {
            throw new Error('x');
          },
          pinnedLeafSha256: 'xyz',
        }),
    ).toThrow('transport_pin_invalid');
  });
  it('rejects an oversize body (413) and a GET (404) at the socket', async () => {
    const post = (path: string, body: Buffer, method = 'POST') =>
      new Promise<number>((resolve) => {
        const r = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on('error', () => resolve(-1));
        r.end(body);
      });
    expect(await post('/v1/health', Buffer.alloc(0), 'GET')).toBe(404);
    const big = await post('/v1/putFiles', Buffer.alloc(eg.NODE_LIMITS.maxBodyBytes + 1024, 0x61));
    expect([413, -1]).toContain(big); // the server cuts the connection after the cap
    expect(await post('/v1/health', Buffer.from('{}'))).toBe(401); // no token
  });
  it('serves metrics only on its own loopback listener and shows the counters', async () => {
    const m = createMetricsServer(rig.agent.metrics);
    const p = await listen(m);
    const text = await new Promise<string>((resolve) => {
      httpRequest({ host: '127.0.0.1', port: p, path: '/metrics' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      }).end();
    });
    expect(text).toContain('nuzm_agent_runs_started_total');
    expect(text).toContain('nuzm_agent_runs_active');
    await close(m);
  });
});

// ---- mutual TLS with a throw-away CA made by the system `openssl` (a fixed-argument certificate tool; it executes nothing from the repository)
const haveOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(!haveOpenssl)('mutual TLS (real handshakes against a throw-away CA)', () => {
  let tdir = '';
  let rig: AgentRig;
  let server: import('node:https').Server;
  let port = 0;
  const o = (...a: string[]) => execFileSync('openssl', a, { cwd: tdir, stdio: 'ignore' });
  const mkLeaf = async (
    name: string,
    ca: string,
    san: string | null,
    eku: 'serverAuth' | 'clientAuth',
  ) => {
    o('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${name}.key`);
    o('req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
    await writeFile(
      join(tdir, `${name}.ext`),
      `extendedKeyUsage=${eku}\n${san ? `subjectAltName=${san}\n` : ''}`,
    );
    o(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${ca}.pem`,
      '-CAkey',
      `${ca}.key`,
      '-CAcreateserial',
      '-days',
      '2',
      '-sha256',
      '-extfile',
      `${name}.ext`,
      '-out',
      `${name}.pem`,
    );
  };
  const mkCa = (name: string) => {
    o('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${name}.key`);
    o(
      'req',
      '-x509',
      '-new',
      '-key',
      `${name}.key`,
      '-subj',
      `/CN=${name}`,
      '-days',
      '2',
      '-sha256',
      '-out',
      `${name}.pem`,
    );
  };
  const fp = async (f: string) =>
    createHash('sha256')
      .update(new X509Certificate(await readFile(join(tdir, f))).raw)
      .digest('hex');
  beforeAll(async () => {
    tdir = await mkdtemp(join(tmpdir(), 'nuzm-mtls-'));
    mkCa('ca');
    mkCa('evilca');
    await mkLeaf('server', 'ca', 'IP:127.0.0.1,DNS:localhost', 'serverAuth');
    await mkLeaf('cp', 'ca', null, 'clientAuth'); // the pinned control plane
    await mkLeaf('other', 'ca', null, 'clientAuth'); // valid CA, NOT pinned
    await mkLeaf('rogue', 'evilca', null, 'clientAuth'); // wrong CA
    rig = await createAgentRig();
    const cfg = {
      ...rig.cfg,
      tls: {
        keyFile: join(tdir, 'server.key'),
        certFile: join(tdir, 'server.pem'),
        caFile: join(tdir, 'ca.pem'),
        clientFingerprints: [await fp('cp.pem')],
      },
    };
    server = await createNodeHttpsServer(cfg, {
      handler: rig.agent.handler,
      metrics: rig.agent.metrics,
      clientFingerprints: cfg.tls.clientFingerprints,
    });
    port = await listen(server);
  });
  afterAll(async () => {
    await close(server);
    await rig.dispose();
    await rm(tdir, { recursive: true, force: true });
  });
  const cred =
    (leaf: string, caName = 'ca') =>
    async () => ({
      ca: await readFile(join(tdir, `${caName}.pem`), 'utf8'),
      cert: await readFile(join(tdir, `${leaf}.pem`), 'utf8'),
      key: await readFile(join(tdir, `${leaf}.key`), 'utf8'),
    });
  const clientWith = (c: ReturnType<typeof cred>, pin?: string) =>
    new eg.RemoteWorkspaceRuntime({
      nodeId: 'sim-node',
      transport: new eg.HttpsTransport({
        baseUrl: `https://localhost:${port}`,
        credentials: c,
        pinnedLeafSha256: pin,
        maxResponseBytes: 1_000_000,
      }),
      signer: rig.signer,
      runtimeClass: 'gvisor-runsc',
      isolation: 'simulated',
    });
  it('the pinned control-plane certificate gets through and the signed request is served', async () => {
    const c = clientWith(cred('cp'));
    expect((await c.identity()).nodeId).toBe('sim-node');
    expect((await c.health()).ok).toBe(true);
  });
  it('a certificate from the right CA that is not pinned is refused (403), and one from another CA never completes the handshake', async () => {
    await expect(clientWith(cred('other')).identity()).rejects.toThrow(
      /forbidden|node_bad_response|node_unreachable/,
    );
    await expect(clientWith(cred('rogue', 'ca')).identity()).rejects.toThrow('node_unreachable');
    expect(rig.agent.metrics.get('nuzm_agent_client_cert_refused_total')).toBeGreaterThanOrEqual(1);
  });
  it('a client that trusts a different CA refuses the node; a wrong leaf pin refuses the node; a client with no certificate cannot connect', async () => {
    await expect(
      clientWith(async () => ({
        ...(await cred('cp')()),
        ca: await readFile(join(tdir, 'evilca.pem'), 'utf8'),
      })).identity(),
    ).rejects.toThrow('node_unreachable');
    await expect(clientWith(cred('cp'), '0'.repeat(64)).identity()).rejects.toThrow(
      'node_unreachable',
    );
    await expect(clientWith(cred('cp'), await fp('server.pem')).identity()).resolves.toBeDefined(); // the right pin works
    await expect(
      clientWith(async () => ({
        ca: await readFile(join(tdir, 'ca.pem'), 'utf8'),
        cert: '',
        key: '',
      })).identity(),
    ).rejects.toThrow();
  });
});
