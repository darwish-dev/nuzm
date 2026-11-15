import 'reflect-metadata';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createEnv, ORG_A, ORG_B, type TestEnv } from '@nuzm/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../app.setup';
import { PlatformModule } from '../modules/platform';
import { Idempotent } from './idempotency';

let effects = 0;

@Controller('test')
class ThingsController {
  @Post('things')
  @Idempotent()
  @HttpCode(201)
  async create(@Body() body: { name: string }) {
    await new Promise((r) => setTimeout(r, 100));
    return { id: ++effects, name: body.name };
  }
}

let env: TestEnv;
let app: NestFastifyApplication;

beforeAll(async () => {
  env = await createEnv();
  process.env.DATABASE_URL = env.appUrl;
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule],
    controllers: [ThingsController],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app);
  // test-only stand-in for the S03 auth layer, which will set orgId from verified credentials
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('preHandler', async (req) => {
      const org = req.headers['x-test-org'];
      if (typeof org === 'string') req.orgId = org;
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await env.close();
});

const post = (key: string | undefined, body: unknown, org: string | null = ORG_A) =>
  app.inject({
    method: 'POST',
    url: '/test/things',
    headers: { ...(key ? { 'idempotency-key': key } : {}), ...(org ? { 'x-test-org': org } : {}) },
    payload: body as object,
  });

describe('Idempotent POST through the API stack', () => {
  it('requires the header (400 problem+json) and an authenticated org (401)', async () => {
    const missing = await post(undefined, { name: 'a' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'idempotency_key_required' });
    expect((await post('k', { name: 'a' }, null)).statusCode).toBe(401);
  });

  it('replays the first response with Idempotent-Replayed and one effect', async () => {
    const before = effects;
    const a = await post('k-1', { name: 'x' });
    const b = await post('k-1', { name: 'x' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(effects - before).toBe(1);
  });

  it('422 idempotency_key_reuse when the body changes', async () => {
    await post('k-2', { name: 'x' });
    const res = await post('k-2', { name: 'y' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'idempotency_key_reuse', status: 422 });
  });

  it('50 duplicate parallel POSTs → exactly one effect; the rest replay or get 409 in_progress', async () => {
    const before = effects;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => post('k-par', { name: 'p' })),
    );
    expect(effects - before).toBe(1);
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(r.json().code).toBe('idempotency_in_progress');
  });

  it('keys are scoped per org', async () => {
    const before = effects;
    await post('k-org', { name: 'o' }, ORG_A);
    await post('k-org', { name: 'o' }, ORG_B);
    expect(effects - before).toBe(2);
  });
});
