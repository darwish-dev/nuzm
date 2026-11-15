import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { applyTestIdentityEnv } from '../identity/testing/env';

describe('GET /healthz', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    applyTestIdentityEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 and status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'nuzm-api' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      code: 'not_found',
      status: 404,
      type: 'urn:nuzm:error:not_found',
    });
    expect(res.json().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('propagates a valid W3C traceparent trace id', async () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { traceparent: tp } });
    expect(res.json().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(res.headers['x-trace-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
