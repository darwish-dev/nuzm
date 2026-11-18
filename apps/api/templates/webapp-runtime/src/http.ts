import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SessionUser } from './types.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  errors: { field: string; message: string }[] | undefined;
  constructor(
    status: number,
    code: string,
    detail: string,
    errors?: { field: string; message: string }[],
  ) {
    super(detail);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export interface AppRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
  user: SessionUser | null;
}
export interface AppResponse {
  status: number;
  body?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}
export type Handler = (req: AppRequest) => Promise<AppResponse>;

export const MAX_BODY_BYTES = 15 * 1024 * 1024;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  public: boolean;
}

export class Router {
  private routes: Route[] = [];
  private authenticate: (headers: Record<string, string>) => Promise<SessionUser | null>;
  constructor(authenticate: (headers: Record<string, string>) => Promise<SessionUser | null>) {
    this.authenticate = authenticate;
  }
  add(method: string, pattern: string, handler: Handler, isPublic = false): void {
    this.routes.push({
      method,
      parts: pattern.split('/').filter(Boolean),
      handler,
      public: isPublic,
    });
  }
  async handle(
    method: string,
    rawUrl: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<AppResponse> {
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const segs = url.pathname.split('/').filter(Boolean);
      let methodMismatch = false;
      for (const r of this.routes) {
        if (r.parts.length !== segs.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < segs.length; i++) {
          const p = r.parts[i] as string;
          const s = segs[i] as string;
          if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
          else if (p !== s) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (r.method !== method) {
          methodMismatch = true;
          continue;
        }
        let user: SessionUser | null = null;
        if (!r.public) {
          user = await this.authenticate(headers);
          if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first');
        }
        let body: unknown = undefined;
        if (rawBody.length > 0 && (headers['content-type'] ?? '').includes('application/json')) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON');
          }
        }
        return await r.handler({
          method,
          path: url.pathname,
          query: url.searchParams,
          params,
          headers,
          rawBody,
          body,
          user,
        });
      }
      if (methodMismatch) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      throw new HttpError(404, 'not_found', 'Not found');
    } catch (e) {
      if (e instanceof HttpError) {
        return {
          status: e.status,
          contentType: 'application/problem+json',
          body: { type: 'about:blank', title: e.code, status: e.status, code: e.code, detail: e.message, errors: e.errors },
        };
      }
      return {
        status: 500,
        contentType: 'application/problem+json',
        body: { type: 'about:blank', title: 'internal_error', status: 500, code: 'internal_error', detail: 'Unexpected error' },
      };
    }
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'The request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function send(res: ServerResponse, r: AppResponse): void {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...(r.headers ?? {}) };
  if (r.bytes) {
    headers['content-type'] = r.contentType ?? 'application/octet-stream';
    res.writeHead(r.status, headers);
    res.end(r.bytes);
    return;
  }
  if (r.text !== undefined) {
    headers['content-type'] = r.contentType ?? 'text/plain; charset=utf-8';
    res.writeHead(r.status, headers);
    res.end(r.text);
    return;
  }
  headers['content-type'] = r.contentType ?? 'application/json; charset=utf-8';
  res.writeHead(r.status, headers);
  res.end(r.body === undefined ? '' : JSON.stringify(r.body));
}

export function listen(
  router: Router,
  port: number,
  staticHandler: (path: string) => Promise<AppResponse | null>,
  apiPrefix: string,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';
        if (method === 'GET' && !url.startsWith(apiPrefix) && !url.startsWith('/health')) {
          const s = await staticHandler(url.split('?')[0] as string);
          if (s) return send(res, s);
        }
        const raw = await readBody(req);
        send(res, await router.handle(method, url, headers, raw));
      } catch (e) {
        if (e instanceof HttpError)
          send(res, { status: e.status, contentType: 'application/problem+json', body: { status: e.status, code: e.code, detail: e.message } });
        else send(res, { status: 500, body: { status: 500, code: 'internal_error' } });
      }
    })();
  });
  server.listen(port);
  return server;
}
