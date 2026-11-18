import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Local HTTP server for simulators (tests and the offline demo only: it listens on 127.0.0.1 and nothing else). */
export interface LocalServer {
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}
export interface LocalRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface LocalReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Simulates a connection that never answers (the client's deadline must fire). */
  hang?: boolean;
}

export async function startLocalServer(
  handler: (req: LocalRequest) => LocalReply | Promise<LocalReply>,
): Promise<LocalServer> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((rq: IncomingMessage, rs: ServerResponse) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      void (async () => {
        const url = new URL(rq.url ?? '/', 'http://127.0.0.1');
        const reply = await handler({
          method: rq.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: rq.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (reply.hang) return; // never answers; the socket is closed on server.close()
        rs.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        });
        rs.end(reply.body ?? '');
      })().catch(() => {
        rs.writeHead(500);
        rs.end('{}');
      });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
      }),
  };
}
