import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { applyTestIdentityEnv } from '../identity/testing/env';
import { rewritePreviewUrl } from './isolation';
import { LivePreviewRegistry } from './internal/live-preview';

/** The live-preview proxy through the real API stack (Fastify host rewrite, isolation hook, global hooks), as the browser reaches it on `<token>.preview.localhost`. */
const DOMAIN = 'preview.localhost';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';
const HOST = `${TOKEN}.${DOMAIN}:4000`;
let app: NestFastifyApplication;
let upstream: Server;
const seen: { method: string; url: string; auth?: string; cookie?: string; body: string }[] = [];

beforeAll(async () => {
  applyTestIdentityEnv();
  process.env.BUILDER_PREVIEW_DOMAIN = DOMAIN;
  process.env.BUILDER_PREVIEW_SCHEME = 'http';
  process.env.BUILDER_PREVIEW_PORT = '4000';
  process.env.BUILDER_CONSOLE_ORIGIN = 'http://localhost:3000';
  // a stand-in for the generated app's process
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        body,
      });
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><script type="module" src="/app.js"></script>');
      }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      rewriteUrl: (req) => rewritePreviewUrl(req.headers.host, req.url ?? '/', DOMAIN),
    }),
    { rawBody: true },
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  app.get(LivePreviewRegistry).register(TOKEN, {
    orgId: 'o',
    projectId: 'p',
    port: (upstream.address() as AddressInfo).port,
    expiresAt: Date.now() + 600_000,
    stop: () => undefined,
  });
});
afterAll(async () => {
  await app?.close();
  upstream?.close();
});

describe('live preview through the API stack', () => {
  it('serves the app entry page on the preview host, frameable by the console only', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('/app.js');
    expect(String(r.headers['content-security-policy'])).toContain(
      'frame-ancestors http://localhost:3000',
    );
  });

  it("forwards the app's API calls with its own session and never the console's credentials", async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/patients?limit=5',
      headers: {
        host: HOST,
        'x-preview-authorization': 'Bearer app-session',
        authorization: 'Bearer console-token',
        cookie: 'nuzm_session=console',
      },
    });
    expect(r.statusCode).toBe(200);
    const last = seen.at(-1)!;
    expect(last).toMatchObject({
      method: 'GET',
      url: '/api/v1/patients?limit=5',
      auth: 'Bearer app-session',
    });
    expect(last.cookie).toBeUndefined();
  });

  it('forwards writes with their JSON body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/patients',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        'x-preview-authorization': 'Bearer app-session',
      },
      payload: JSON.stringify({ name: 'مريض' }),
    });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ name: 'مريض' });
  });

  it('a request with no body and a JSON content type still reaches the app', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: '/api/v1/patients/1',
      headers: { host: HOST, 'x-preview-authorization': 'Bearer app-session' },
    });
    expect(r.statusCode).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/patients/1' });
  });
});
