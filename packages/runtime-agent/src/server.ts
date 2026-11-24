import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { executionGateway as eg } from '@nuzm/domain';
import type { AgentConfig } from './config';
import type { Metrics } from './metrics';

/**
 * The network listeners. The node protocol listener is HTTPS with MUTUAL TLS (TLS 1.3, a client certificate is REQUIRED, signed by the configured CA, and its leaf fingerprint must
 * be one of the pinned control-plane fingerprints: a CA alone is not enough). It binds to the management-interface address from the config and never to a wildcard. The metrics
 * listener is plain text on 127.0.0.1 only. Request bodies are read with a hard cap and a deadline; a slow or oversize client is cut off before the handler sees it.
 */
const readBody = (req: import('node:http').IncomingMessage, cap: number): Promise<Buffer | 'too_large'> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > cap) {
        resolve('too_large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export interface NodeListenerOptions {
  handler: eg.NodeRequestHandler;
  metrics: Metrics;
  /** pinned control-plane client certificate fingerprints (sha256 hex) */
  clientFingerprints: readonly string[];
}
function attach(server: HttpServer | HttpsServer, o: NodeListenerOptions): void {
  server.maxHeadersCount = 40;
  server.headersTimeout = 10_000;
  server.requestTimeout = 150_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 64;
  server.on('request', (req, res) => {
    void (async () => {
      const socket = req.socket as TLSSocket;
      if (typeof socket.getPeerCertificate === 'function') {
        const peer = socket.getPeerCertificate();
        const fp = peer && peer.raw ? createHash('sha256').update(peer.raw).digest('hex') : '';
        if (!socket.authorized || !o.clientFingerprints.includes(fp)) {
          o.metrics.inc('nuzm_agent_client_cert_refused_total');
          res.writeHead(403, { connection: 'close' }).end();
          return;
        }
      }
      const body = await readBody(req, eg.NODE_LIMITS.maxBodyBytes).catch(() => null);
      if (body === null || body === 'too_large') {
        res.writeHead(body === 'too_large' ? 413 : 400, { connection: 'close' }).end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const k of ['content-type', 'authorization', 'x-nuzm-protocol'])
        if (typeof req.headers[k] === 'string') headers[k] = req.headers[k] as string;
      const out = await o.handler({ method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, headers, body }).catch(() => ({
        status: 500,
        body: Buffer.from('{"ok":false,"error":{"code":"internal"}}'),
      }));
      res.writeHead(out.status, { 'content-type': 'application/json', 'content-length': String(out.body.length), connection: 'close' }).end(out.body);
    })();
  });
}
export async function createNodeHttpsServer(cfg: AgentConfig, o: NodeListenerOptions): Promise<HttpsServer> {
  const [key, cert, ca] = await Promise.all([readFile(cfg.tls.keyFile), readFile(cfg.tls.certFile), readFile(cfg.tls.caFile)]);
  const server = createHttpsServer({
    key,
    cert,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  });
  attach(server, o);
  return server;
}
/** plain http on loopback: ONLY for the simulated launcher's tests of the real HTTP path (`parseAgentConfig` refuses it with the real launcher) */
export function createLoopbackHttpServer(o: Omit<NodeListenerOptions, 'clientFingerprints'>): HttpServer {
  const server = createHttpServer();
  attach(server, { ...o, clientFingerprints: [] });
  return server;
}
export function createMetricsServer(metrics: Metrics): HttpServer {
  const s = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
    else res.writeHead(404).end();
  });
  return s;
}
